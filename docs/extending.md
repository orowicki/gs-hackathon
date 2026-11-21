# Extending the service

Step-by-step guides for the usual extension points. Paths are relative to the repo root. For how the pieces fit together see [architecture.md](architecture.md). For the YAML formats see [config-formats.md](config-formats.md).

Contracts: [source plugin](autopilot/interfaces/source-plugin.md), [channel plugin](autopilot/interfaces/channel-plugin.md).

## New source type (ingest plugin)

Files: `packages/ingest/src/plugins/<name>.ts` (new), `packages/ingest/src/plugins/index.ts`, and `packages/shared/src/types/source.ts` (typed config).

Interface (`packages/ingest/src/types.ts`):

```ts
export interface SourcePlugin<C = unknown> {
  type: SourceType | string;
  configSchema: JsonSchemaObject; // JSON Schema object, drives the UI form
  start(config: C, emit: Emit, ctx: SourceContext): Promise<SourceHandle>;
}
export interface SourceHandle { stop(): Promise<void> }
export type Emit = (raw: string | JsonObject, meta?: { receivedAt?: string }) => Promise<void>;
```

Steps:

1. Write the plugin. Call `emit(raw)` for every message (a string line or a JSON object). The parser of the source is applied by the runner, not by the plugin. Stop all timers and connections in `stop()`, and honour `ctx.signal`. Copy `plugins/file-tail.ts` or `plugins/redis-stream.ts`.
2. Put the config JSON schema in `plugins/schemas.ts` next to the others and use it as `configSchema`.
3. Register it in `registerBuiltinPlugins()` in `plugins/index.ts`: `registerSourcePlugin(myPlugin)`. Also add `export * from "./<name>.js"` there.
4. Optional, for typed configs: add the config interface and a `Source` union member in `packages/shared/src/types/source.ts`, and add the type to `SOURCE_TYPES`.
5. Create a source instance in the UI, with `POST /api/sources`, or as `config/sources/<id>.yaml` (`type: <name>`).

The type then appears in `GET /api/source-types` (the route calls `registerBuiltinPlugins()`), and `packages/ingest/src/runner.ts` looks the plugin up with `getSourcePlugin(source.type)`.

Test: copy `packages/ingest/test/plugins-file-tail.test.ts` (needs Redis for the redis variants). Run `npx vitest run packages/ingest`.

## New parser

Files: `packages/ingest/src/parsers/index.ts`, `packages/shared/src/types/source.ts`.

Interface (`packages/ingest/src/parsers/index.ts`):

```ts
export type Parser = (input: string | JsonObject, config: ParserConfig) => JsonObject;
```

A parser must not throw. Unreadable input returns `fallback(text)`, which is `{ raw: "<text>" }`. (`parse()` also catches throws and unknown types and falls back the same way.)

Steps:

1. Write the function in `parsers/index.ts`, next to `jsonParser` and `logfmtParser`.
2. Register it: add it to the `PARSERS` record, or call `registerParser("<name>", parser)`.
3. Add the name to `PARSER_TYPES` in `packages/shared/src/types/source.ts`. This type drives `ParserType` and the `enum` in the UI form (`plugins/schemas.ts`). Extra options go on `ParserConfig` (like `pattern` for `regex`).
4. Use it with `parser: { type: <name> }` in a source.

Test: add cases to `packages/ingest/test/parsers.test.ts`. Run `npx vitest run packages/ingest/test/parsers.test.ts`.

## New delivery channel

Files: `packages/delivery/src/<name>.ts` (new), `packages/delivery/src/index.ts`, `packages/api/src/main.ts`.

Interface (`packages/delivery/src/channel.ts`):

```ts
export interface Channel {
  id: ChannelId; // string, e.g. "ntfy"
  send(n: QueuedNotification): Promise<ChannelResult>;
}
```

`ChannelResult` is a `DeliveryResult`, or `{ status: "failed", retryable: true, unavailable: true, error }` when the channel itself is down (retried with backoff until `maxOutageMs`, not counted against `maxAttempts`). A thrown error is a retryable failure. A channel id nobody registered is a non-retryable failure.

Steps:

1. Write a factory, e.g. `createXChannel(opts): Channel` (`X` is a placeholder for your channel name). Copy `ui.ts` (simplest), `ntfy.ts` (HTTP) or `email.ts` (SMTP, with error classification).
2. Export it from `packages/delivery/src/index.ts`.
3. Register it at startup in `packages/api/src/main.ts`: `registerChannel(createXChannel(...))` (your factory), next to the ui, ntfy and email lines. Read options from env there, and document new variables in the README configuration table.
4. Make people use it: add the channel id to `channels` in a person's preferences (see [config-formats.md](config-formats.md)) or to `force` in a rule.

Test: copy `packages/delivery/test/ntfy.test.ts` (or `email.test.ts`; both need Redis). Run `npx vitest run packages/delivery`.

## New runbook action type

Files: `packages/runbooks/src/actions.ts` (the file, not a directory), `packages/shared/src/types/runbook.ts`, optionally `packages/runbooks/src/match.ts`.

Interface (`packages/runbooks/src/actions.ts`):

```ts
export interface ActionPlugin {
  type: string; // matches `action:` in a runbook step
  execute(step: RunbookStep, ctx: ActionContext): Promise<ActionResult>;
}
export interface ActionResult { ok: boolean; result: string } // result: short outcome text
```

`ActionContext` gives `render(s)` (template substitution), `alertId`, `runbookId`, `stepIndex` and an abort `signal`. Return `ok: false` instead of throwing.

Steps:

1. Add a factory, e.g. `fooAction(opts): ActionPlugin` (`foo` is a placeholder for your action name) in `actions.ts`, like `httpAction`, `escalateAction` and `waitAction`. Cast `step` to your step type.
2. Add the step interface (e.g. `action: "foo"`, your action name) to `packages/shared/src/types/runbook.ts`, and add it to the `RunbookStep` union. Add a `case` to `stepDisplayName` in `actions.ts` (the default case prints the action name).
3. Register it in `createDefaultActions()` in `actions.ts`: add your `fooAction(...)` to the `createActionRegistry([...])` list. Pass extra deps via `DefaultActionDeps`, wired in `packages/api/src/main.ts` (`createDefaultActions({ notifyGroup })`).
4. Optional validation: `packages/runbooks/src/match.ts` checks the fields of known actions (`http`, `escalate`, `wait`). Unknown actions pass the generic check, so add a field check there for yours.
5. Use it in a runbook: `steps: [{ action: foo, ... }]` (with your action name) (see `config/runbooks/`).

Test: copy `packages/runbooks/test/actions.test.ts`. Run `npx vitest run packages/runbooks`.

## New HTTP API route

Files: `packages/api/src/routes/<name>.routes.ts` (new). Nothing else changes: `routes/index.ts` loads every `*.routes.ts` in the folder.

Interface (`packages/api/src/http.ts`):

```ts
export interface RouteModule {
  name: string;
  order?: number; // lower runs first, default 100; ties by name
  handle(ctx: RouteContext): Promise<boolean> | boolean; // true = handled
}
```

Steps:

1. Create the file with `export default { name, order?, handle } satisfies RouteModule`. `handle` gets `{ req, res, path, deps }`. Return `false` when the method or path is not yours, so the next module can try. Reply with `send(res, status, body)`. See `health.routes.ts` (small) and `delivery.routes.ts`.
2. If you need new dependencies, add them to `Deps` by declaration merging in your file, and pass them when the server is built in `packages/api/src/main.ts`:

   ```ts
   declare module "../http.js" { interface Deps { myThing?: MyThing } }
   ```

3. Document the route in `packages/api/src/openapi.ts` (the `openapi-ui-coverage` and `openapi` tests check it).

Test: copy `packages/api/test/delivery-routes.test.ts`. Run `npx vitest run packages/api`.

## New schema, rule or source by YAML

No code needed. Add a file under `config/schemas/`, `config/rules/` or `config/sources/` (one entity per file). The watcher upserts it live, and the seed loads it on `just up` if missing. The shape of each kind and examples are in [config-formats.md](config-formats.md). Try a schema mapping on a sample with `POST /api/schemas/test` first.
