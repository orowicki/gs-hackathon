import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import { LIST_DEAD_LETTERS, QUEUE_DELIVERY, QUEUE_DELIVERY_PROCESSING, ZSET_DELIVERY_RETRY } from "@alerting/shared";
import { ChannelRegistry, createDeliveryQueue, createEmailChannel, emailConfigFromEnv, type DeliveryQueue } from "../src/index.js";
import { makeRedis, note, waitFor } from "./helpers.js";

interface Mail {
  from: string;
  to: string[];
  raw: string;
}

function startSmtp(port: number, mails: Mail[], rcptError?: { responseCode: number }): Promise<SMTPServer> {
  const srv = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS", "AUTH"],
    logger: false,
    onRcptTo(_a, _s, cb) {
      cb(rcptError ? Object.assign(new Error("rejected"), rcptError) : null);
    },
    onData(stream, session, cb) {
      let raw = "";
      stream.on("data", (c) => (raw += c));
      stream.on("end", () => {
        mails.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw });
        cb();
      });
    },
  });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}
const stop = (s: SMTPServer): Promise<void> => new Promise((r) => s.close(() => r()));
const portOf = (s: SMTPServer): number => (s.server.address() as AddressInfo).port;
async function freePort(): Promise<number> {
  const s = await startSmtp(0, []);
  const p = portOf(s);
  await stop(s);
  return p;
}
const mk = (port: number) =>
  createEmailChannel({ host: "127.0.0.1", port, from: "alerting@alerting.local", publicUrl: "http://app:3000/", timeoutMs: 1000 });
const em = (i: number | string) => note(i, { channel: "email", body: "Disk full", runbookUrl: "https://rb/x" });

let q: DeliveryQueue | undefined;
afterEach(async () => {
  await q?.stop();
  q = undefined;
});

describe("email channel", () => {
  it("delivers a message with subject, body and ack link", async () => {
    const mails: Mail[] = [];
    const srv = await startSmtp(0, mails);
    try {
      const r = await mk(portOf(srv)).send(em("1"));
      expect(r).toEqual({ status: "delivered" });
    } finally {
      await stop(srv);
    }
    expect(mails).toHaveLength(1);
    expect(mails[0].from).toBe("alerting@alerting.local");
    expect(mails[0].to).toEqual(["bob@alerting.local"]);
    expect(mails[0].raw).toContain("Subject: [ERROR] Title 1");
    expect(mails[0].raw).toContain("Disk full");
    expect(mails[0].raw).toContain("Open: http://app:3000/alerts/a1");
    expect(mails[0].raw).toContain("Runbook: https://rb/x");
    expect(mails[0].raw).toContain("Acknowledge: http://app:3000/api/alerts/a1/ack");
  });

  it("reports a closed port as retryable and unavailable", async () => {
    const r = await mk(await freePort()).send(em("2"));
    expect(r).toMatchObject({ status: "failed", retryable: true, unavailable: true });
  });

  it("maps SMTP 550 to non-retryable and 451 to retryable", async () => {
    for (const [code, retryable] of [[550, false], [451, true]] as const) {
      const srv = await startSmtp(0, [], { responseCode: code });
      try {
        const r = await mk(portOf(srv)).send(em("3"));
        expect(r).toMatchObject({ status: "failed", retryable });
        expect((r as { unavailable?: boolean }).unavailable).toBeUndefined();
      } finally {
        await stop(srv);
      }
    }
  });

  it("parses env config with defaults", () => {
    expect(emailConfigFromEnv({})).toMatchObject({ host: "localhost", port: 1025, from: "alerting@alerting.local", secure: false, toDomain: "alerting.local", publicUrl: "http://localhost:3000" });
    expect(emailConfigFromEnv({ SMTP_HOST: "m", SMTP_PORT: "2525", SMTP_SECURE: "true" })).toMatchObject({ host: "m", port: 2525, secure: true });
  });

  it("queues during an SMTP outage and delivers after recovery", async () => {
    const port = await freePort();
    const mails: Mail[] = [];
    const redis = makeRedis();
    await redis.del(QUEUE_DELIVERY, QUEUE_DELIVERY_PROCESSING, ZSET_DELIVERY_RETRY, LIST_DEAD_LETTERS);
    const reg = new ChannelRegistry();
    reg.register(mk(port));
    q = createDeliveryQueue(redis, { registry: reg, baseMs: 20, capMs: 200, pollMs: 10, concurrency: 2 });
    await q.start();
    await q.enqueue(em("q"));
    await new Promise((r) => setTimeout(r, 400));
    expect(mails).toEqual([]);
    expect(await q.listDeadLetters()).toEqual([]);
    const srv = await startSmtp(port, mails);
    try {
      await waitFor(() => mails.length === 1, 15_000);
    } finally {
      await q.stop();
      await stop(srv);
    }
    expect(mails[0].raw).toContain("Subject: [ERROR] Title q");
    expect(await q.listDeadLetters()).toEqual([]);
  }, 30_000);

  it.skipIf(process.env.MAILPIT_E2E !== "1")("delivers to a real Mailpit", async () => {
    const ch = createEmailChannel({ host: "localhost", port: 1025, from: "alerting@alerting.local", publicUrl: "http://localhost:3000" });
    const title = `Mailpit ${Date.now()}`;
    expect(await ch.send(note("m", { channel: "email", title }))).toEqual({ status: "delivered" });
    await waitFor(async () => {
      const res = await fetch("http://localhost:8025/api/v1/messages");
      return JSON.stringify(await res.json()).includes(title);
    }, 10_000);
  });
});
