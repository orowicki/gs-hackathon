# API routes

Source of truth: `packages/shared/src/routes.ts` (`ROUTES`). `packages/api/src/openapi.ts` builds the OpenAPI 3.1 document from it; it is served at `GET /api/openapi.json`. Request/response bodies are documented by type name only (stubs). Adding a route means adding a `ROUTES` entry (acceptance criterion 11 diffs UI calls against it).

Groups: system (`/health`, openapi), ingest (`POST /ingest/{sourceId}`), CRUD (`/api/{sources,schemas,rules,people,groups,runbooks}` with `{id}`), preferences (`/api/people|groups/{id}/preferences`), events (`/api/events`, `/recent`, `/test-filter`), filters (`/api/filters/parse|format|suggest`), alerts (list, get, `ack`, `resolve`, `audit`, runbook step `approve`), suggestions, channels and dead letters (`retry`), YAML `export`/`import` for schemas, sources, rules, and SSE endpoints (`/api/stream`, `/api/sources/{id}/preview`).

Also: `POST /api/schemas/test` (try a mapping on a pasted sample), `POST /api/sources/test` (try a parser on a sample line), `GET/PUT /api/people/{id}/starred-filters`, `GET /api/alerts/{id}/runbook-runs` (`RunbookRun[]`), `GET /api/approvals` (pending approvals), `GET /api/audit` (global audit, query-filterable).

Example: `POST /api/alerts/{id}/ack` returns the updated `Alert`.

Who uses it: A implements ingest, sources, schemas, events, filters, YAML and preview; B implements rules, people, groups, preferences, channels, dead letters, suggestions; C implements alerts, runbooks, audit, approvals and the stream endpoint. The UI and external LLM agents both call the same routes.
