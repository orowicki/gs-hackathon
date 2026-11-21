# demo-service

Fake target for runbook `http` actions. No dependencies.

- `GET /health` -> 200 `{"status":"ok"}` (503 `{"status":"down"}` after `setHealthy(false)`)
- `POST /workflows/:id/retry` -> 200 `{"workflowId":id,"status":"retried"}`
- `POST /restart/:instance` -> 200
- `GET /calls` -> every recorded call (method, path, body, headers, at)

Run: `node fixtures/demo-service/server.mjs` (PORT, default 4100) or `docker compose up demo-service`.
Tests: `import { startDemoService } from "../../fixtures/demo-service/server.mjs"` (port 0 = random).
