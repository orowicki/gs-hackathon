// The live page served at GET / by server.mjs. Plain HTML + JS, no dependencies.
export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo Systems</title>
<style>
  :root {
    --bg: #f6f7f9; --surface: #fff; --border: #e3e6ea; --text: #1d2430; --muted: #6b7380;
    --accent: #2f5d97; --ok: #1f8a4c; --ok-bg: #e6f4ec; --bad: #c0392b; --bad-bg: #fbe9e7;
    --warn: #a86a00; --warn-bg: #fff3dc; --info-bg: #e8eef7;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #12151a; --surface: #1a1e25; --border: #2a3039; --text: #e4e8ee; --muted: #8b94a3;
      --accent: #8fb2dd; --ok: #5cc98a; --ok-bg: #173324; --bad: #f07b6e; --bad-bg: #3a1d1a;
      --warn: #e6b450; --warn-bg: #3a2e14; --info-bg: #1d2a3d;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--border); background: var(--surface); }
  header h1 { font-size: 16px; margin: 0; }
  header .sub { color: var(--muted); font-size: 13px; }
  .live { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 0 var(--ok); animation: pulse 1.6s infinite; }
  .dot.off { background: var(--bad); animation: none; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 60%, transparent); } 100% { box-shadow: 0 0 0 8px transparent; } }
  main { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 16px; padding: 16px 20px; max-width: 1200px; margin: 0 auto; }
  @media (max-width: 820px) { main { grid-template-columns: 1fr; padding: 16px; } aside { order: -1; } }
  section, aside { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
  .head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--border); }
  .head h2 { margin: 0; font-size: 14px; }
  .count { color: var(--muted); font-weight: 400; margin-left: 6px; }
  button { font: inherit; cursor: pointer; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 6px; padding: 4px 10px; }
  button:hover { border-color: var(--accent); }
  ol { list-style: none; margin: 0; padding: 0; }
  li.call { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  li.call.new { animation: flash 1.4s ease-out; }
  @keyframes flash { from { background: var(--info-bg); } to { background: transparent; } }
  .time { color: var(--muted); font: 12px var(--mono); padding-top: 2px; white-space: nowrap; }
  .what { font-weight: 600; }
  .req { font: 12px var(--mono); color: var(--muted); overflow-wrap: anywhere; }
  .rb { display: inline-block; margin-top: 4px; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--info-bg); color: var(--accent); }
  .status { font: 12px var(--mono); padding: 2px 8px; border-radius: 6px; white-space: nowrap; }
  .s2 { background: var(--ok-bg); color: var(--ok); } .s4, .s5 { background: var(--bad-bg); color: var(--bad); }
  .empty { padding: 36px 14px; text-align: center; color: var(--muted); }
  aside .body { padding: 6px 14px 14px; }
  .ctl { padding: 10px 0; border-bottom: 1px solid var(--border); }
  .ctl:last-child { border-bottom: 0; }
  .ctl .name { font-weight: 600; }
  .ctl .hint { color: var(--muted); font-size: 12px; margin: 2px 0 8px; }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
  .seg button { border: 0; border-radius: 0; padding: 5px 12px; }
  .seg button + button { border-left: 1px solid var(--border); }
  .seg button.on { background: var(--accent); color: var(--surface); }
  .seg button.on.bad { background: var(--bad); }
  code { font: 12px var(--mono); }
</style>
</head>
<body>
<header>
  <h1>Demo systems</h1>
  <span class="sub">The fake services the runbooks call: every request appears here live</span>
  <span class="live"><span class="dot" id="dot"></span><span id="live">live</span></span>
</header>
<main>
  <section>
    <div class="head">
      <h2>Calls from runbooks<span class="count" id="count"></span></h2>
      <button id="clear" type="button">Clear</button>
    </div>
    <ol id="calls"><li class="empty">No calls yet. Fire an alert with a runbook, or approve a step on an alert page.</li></ol>
  </section>
  <aside>
    <div class="head"><h2>Scenario switches</h2></div>
    <div class="body">
      <div class="ctl">
        <div class="name">counterparty-service</div>
        <div class="hint"><code>GET /health</code>: what the health-check steps see</div>
        <div class="seg" data-key="healthy"><button data-v="true">Healthy</button><button data-v="false" class="badopt">Down</button></div>
      </div>
      <div class="ctl">
        <div class="name">Workflow retry</div>
        <div class="hint">Failing makes "retry fails twice → escalate" happen</div>
        <div class="seg" data-key="retryFails"><button data-v="false">Succeeds</button><button data-v="true" class="badopt">Fails</button></div>
      </div>
      <div class="ctl">
        <div class="name">Payments errors</div>
        <div class="hint">One region → fail over · All regions → roll back</div>
        <div class="seg" data-key="scope"><button data-v="one-region">One region</button><button data-v="all-regions" class="badopt">All regions</button></div>
      </div>
      <div class="ctl">
        <div class="name">Pricing latency after restart</div>
        <div class="hint">Still high → call the pricing on-call</div>
        <div class="seg" data-key="latencyHigh"><button data-v="false">Back to normal</button><button data-v="true" class="badopt">Still high</button></div>
      </div>
    </div>
  </aside>
</main>
<script>
const $ = (s) => document.querySelector(s);
let since = 0, seen = 0, first = true;

const describe = (c) => {
  const p = c.path, r = c.response || {};
  let m;
  if (p === "/health") return c.status === 200 ? "Health check: counterparty-service is up" : "Health check: counterparty-service is DOWN";
  if ((m = p.match(/^\\/workflows\\/([^/]+)\\/retry$/))) return c.status === 200 ? "Retried workflow " + decodeURIComponent(m[1]) : "Retry of " + decodeURIComponent(m[1]) + " failed";
  if ((m = p.match(/^\\/restart\\/([^/]+)$/))) return "Restarted " + decodeURIComponent(m[1]);
  if ((m = p.match(/^\\/regions\\/([^/]+)$/))) return "Checked regions of " + decodeURIComponent(m[1]) + ": " + (r.scope === "one-region" ? "only " + (r.failing || []).join(", ") + " failing" : "all regions failing");
  if ((m = p.match(/^\\/failover\\/([^/]+)$/))) return "Failed " + decodeURIComponent(m[1]) + " traffic over: " + (r.from || "?") + " → " + (r.to || "?");
  if ((m = p.match(/^\\/deployments\\/([^/]+)\\/rollback$/))) return "Rolled back " + decodeURIComponent(m[1]) + " to " + (r.rolledBackTo || "previous");
  if ((m = p.match(/^\\/latency\\/([^/]+)$/))) return "Measured latency of " + decodeURIComponent(m[1]) + ": " + r.p99Ms + " ms" + (r.high ? " (still high)" : "");
  if ((m = p.match(/^\\/chat\\/([^/]+)$/))) return "Posted an update in #" + decodeURIComponent(m[1]);
  return c.method + " " + p;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

function render(list) {
  const ol = $("#calls");
  if (list.length && ol.querySelector(".empty")) ol.innerHTML = "";
  for (const c of list) {
    const li = document.createElement("li");
    li.className = "call" + (first ? "" : " new");
    const t = new Date(c.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const rb = c.headers && c.headers["x-alerting-runbook"];
    const body = c.body && typeof c.body === "object" ? " " + JSON.stringify(c.body) : "";
    li.innerHTML =
      '<span class="time">' + t + "</span>" +
      '<div><div class="what">' + esc(describe(c)) + "</div>" +
      '<div class="req">' + esc(c.method + " " + c.path + body) + "</div>" +
      (rb ? '<span class="rb">runbook: ' + esc(rb) + "</span>" : "") + "</div>" +
      '<span class="status s' + String(c.status || 0)[0] + '">' + (c.status || "…") + "</span>";
    ol.prepend(li);
    seen++;
  }
  $("#count").textContent = seen ? " · " + seen : "";
}

async function poll() {
  try {
    const res = await fetch("/calls?since=" + since, { cache: "no-store" });
    const list = await res.json();
    if (list.length) { since = list[list.length - 1].seq; render(list); }
    first = false;
    $("#dot").classList.remove("off"); $("#live").textContent = "live";
  } catch {
    $("#dot").classList.add("off"); $("#live").textContent = "reconnecting…";
  }
  setTimeout(poll, 1000);
}

function showState(s) {
  document.querySelectorAll(".seg").forEach((seg) => {
    const v = String(s[seg.dataset.key]);
    seg.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.v === v;
      b.classList.toggle("on", on);
      b.classList.toggle("bad", on && b.classList.contains("badopt"));
    });
  });
}
async function setState(patch) {
  const res = await fetch("/admin/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  showState(await res.json());
}
document.querySelectorAll(".seg").forEach((seg) =>
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const raw = b.dataset.v, v = raw === "true" ? true : raw === "false" ? false : raw;
    void setState({ [seg.dataset.key]: v });
  }),
);
$("#clear").addEventListener("click", async () => {
  await fetch("/admin/clear", { method: "POST" });
  $("#calls").innerHTML = '<li class="empty">Cleared. Waiting for calls…</li>';
  seen = 0; $("#count").textContent = "";
});
fetch("/admin/state").then((r) => r.json()).then(showState);
poll();
</script>
</body>
</html>`;
