# Filter language (`@alerting/filter`)

One filter language for rules, routing, preferences, runbook matching and the UI filter bar.
Pure TypeScript, no runtime deps, browser-safe. `import { parse, print, evaluate } from "@alerting/filter"`.

## Tree (plain JSON)

```ts
type FilterNode =
  | { type: "and"; children: FilterNode[] }   // >= 2 children; chains are flattened
  | { type: "or"; children: FilterNode[] }    // >= 2 children
  | { type: "not"; child: FilterNode }
  | { type: "cmp"; field: string; op: "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "matches"; value: string | number }
  | { type: "in"; field: string; values: (string | number)[] };   // empty list allowed
```

Example: `alert.severity >= error AND NOT payload.region in [eu, "us east"]` becomes

```json
{ "type": "and", "children": [
  { "type": "cmp", "field": "alert.severity", "op": ">=", "value": "error" },
  { "type": "not", "child": { "type": "in", "field": "payload.region", "values": ["eu", "us east"] } }
] }
```

## API

- `parse(text): FilterNode | null` (throws `FilterSyntaxError`), `tryParse(text)` returns `{ ok: true, tree } | { ok: false, error: { message, position } }`.
- `print(tree): string` canonical text (`AND`/`OR`/`NOT` uppercase, `contains`/`in`/`matches` lowercase, minimal parentheses, strings quoted only when needed). `print(null)` is `""`.
- `evaluate(tree, { alert?, event? }): boolean`.
- `validateTree(json): FilterNode` checks an untrusted tree (throws `Error` with a path such as `Invalid filter tree at $.children[1]: ...`); returns a clean copy. and/or need >= 2 children, field names must be valid and not `AND`/`OR`/`NOT`.
- Guarantees: `parse(print(t))` deep-equals `t` for any valid tree; `print(parse(print(parse(s))))` equals `print(parse(s))`.
- Parenthesised groups of the same type are not merged (`(a AND b) AND c` stays nested), so trees round-trip exactly.

## Syntax and semantics

- Fields: dotted paths (letters, digits, `_`, `-`), case-sensitive. `alert.<x>` reads `ctx.alert.<x>`; anything else is a raw path into `ctx.event` (own properties only).
- Operators: `= != > >= < <= contains in matches`. Word operators and `AND`/`OR`/`NOT` are case-insensitive. Precedence NOT > AND > OR; parentheses group.
- Values: bare word (`timeout`, `pricing-engine-*`), `"quoted"` with `\"` and `\\`, number (`-3`, `1.5`), list `[a, "b c", 3]` (only for `in`). A quoted `"5"` is a string; bare `5` is a number.
- `=`/`!=`: numeric compare if the literal is a number and the actual value is a number or numeric string; otherwise compare `String(actual)` with the literal text.
- `> >= < <=`: numeric only (both numeric), else false. For `alert.severity` they use `SEVERITY_ORDER` (critical 4 > error 3 > warning 2 > info 1); unknown values give false.
- Missing field (undefined/null): `!=` is true, every other operator is false.
- `contains`: substring (case-sensitive) on strings/numbers, element membership if the actual value is an array.
- `matches`: glob over the whole string, `*` any chars, `?` one char, case-sensitive, everything else literal.
- Empty or whitespace-only text parses to `null`, meaning match everything; `evaluate(null, ...)` is `true`.

## Errors

`{ message, position }`, `position` is a 1-based column. Messages are plain English, e.g.
`Expected a value after "=" at position 17`, `Unknown operator "foo" at position 3. Expected =, !=, ...`,
`Missing closing quote for the text starting at position 5`, `Missing ")" to close the "(" at position 1`,
`Unexpected ")" at position 6`, `Missing "]" to close the list opened at position 6`,
`Expected a list like [a, b] after "in" at position 6`, `Expected a field name at position 1`,
`Unexpected "b" at position 7. Expected AND, OR or the end of the filter`. For unclosed quote/paren/bracket the position is where it was opened.

## Autocomplete support

Exports `COMMON_FIELDS`, `OPERATORS` (`{ symbol, description }[]`), `KEYWORDS`, `SEVERITY_ORDER`, `SEVERITY_FIELD`, and
`suggestContext(text, cursor?) => { expect: "field" | "operator" | "value" | "logic", field?, prefix }` (UI.md 5.3; best effort, never throws; `field` set when `expect` is `value`).

## Used by

Rules (trigger conditions), routing, user preferences, runbook matching, the UI filter bar (text typed by the user), the API (endpoints accept filter text or a tree; trees pass through `validateTree`; text through `tryParse`).
