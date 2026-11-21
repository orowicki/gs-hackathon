# Kafka in the demo

Kafka runs as **Redpanda**, a Kafka-compatible broker in the `redpanda` container. Nothing needs to be installed on your machine.

- From containers: `redpanda:9092`
- From your machine: `localhost:19092`
- Topic: `demo.events`, read by the source `demo-kafka` (consumer group `alerting`)

Run every command from the repo root.

## 1. Start everything

```sh
git pull
docker compose up -d --build --force-recreate
```

## 2. Check that Kafka is ready

```sh
docker compose exec -T redpanda rpk topic list
docker compose exec -T redpanda rpk group describe alerting
```

Expected:
- `demo.events` is in the topic list.
- The group shows `STATE Stable` and `MEMBERS 1`, which means the app is listening.

## 3. Send an event through Kafka

```sh
echo '{"alertname":"HighLatency","labels":{"service":"pricing-engine-emea","region":"eu-west","severity":"critical"},"annotations":{"summary":"Sent via Kafka"},"startsAt":"2026-11-21T10:00:00Z","status":"firing"}' \
  | docker compose exec -T redpanda rpk topic produce demo.events
```

Open <http://localhost:3000>. The alert appears within a few seconds.

> Use a service that a rule matches, such as `pricing-engine-*` or `payments-api` with severity `critical`. With any other service the event is stored, but no alert is shown.

## 4. Prove that the app consumed it

```sh
docker compose exec -T redpanda rpk group describe alerting
```

`CURRENT-OFFSET` went up and `LAG` is `0`, so the message was read and processed.

## 5. Full demo (optional)

```sh
just demo
```

Check the last line: `... N via kafka` with N > 0. A Kafka warning at the start means Kafka was skipped.

## Troubleshooting

| Problem | Fix |
|---|---|
| `demo.events` missing | Create it: `docker compose exec -T redpanda rpk topic create demo.events` |
| Group not `Stable` / no members | Restart the worker: `docker compose restart worker`, then check `docker compose logs worker \| grep -i kafka` |
| Event sent but no alert | Use a service that a rule matches (see step 3) |
| `just demo` shows a Kafka warning | Check that Redpanda is running: `docker compose ps redpanda` |

Before the real demo, do a dry run from a clean state: `docker compose down -v`, then steps 1 to 4.
