# Client UI Specification

> **For Claude / any agent building UI in this repo:** this file is the source of truth for how the
> client looks and behaves. Follow it exactly. If something is not covered here, choose the simplest
> option that keeps the screen calm, and note the open question at the bottom of this file instead of
> inventing extra UI.

## 1. Principles

> Revised 2026-11-21 (team decision): Grafana-style layout. Supersedes the earlier
> "no sidebars, no stat cards" rule.

1. **Two areas, always one click away.** A left sidebar (Grafana-style) with two sections:
   **Alerts** (alert feed, my notifications) for people handling alerts, and **Configuration**
   (rules, sources, schemas, people & groups, channels) for setting the service up. Every page is
   reachable from the sidebar; no page is hidden behind another page's button. Each page declares
   its sidebar entry with `nav` in its `packages/web/src/routes/*.route.tsx` file.
2. **The filter is the main control on the feed.** Stat panels above the feed (open alerts, and open
   alerts per severity) give the overview and filter the feed when clicked. No charts or dashboards
   beyond these panels.
3. **Grafana look.** Dark theme by default (light available), panels with 1 px borders, colour used
   for severity, validity and the accent. Palette lives in `packages/web/src/styles/tokens.css`.
4. **Every configuration page has its primary action** ("Add source", "Add schema", "New rule", ...)
   at the top right of its page header.
5. **Readable by non-engineers.** No raw JSON, curly braces or quotes in the default views.

## 2. Pages and routes

| Route | Page | Sidebar section | Who sees it |
|---|---|---|---|
| `/` | Alert feed (landing page) | Alerts | everyone |
| `/alerts/:id` | Alert detail | (under Alert feed) | everyone |
| `/settings/notifications` | My notifications | Alerts | everyone |
| `/rules`, `/rules/new`, `/rules/:id` | Rules list and editor | Configuration | everyone; editing only profiles with permission to create rules |
| `/config/sources`, `/config/sources/:id` | Sources | Configuration | everyone |
| `/config/schemas`, `/config/schemas/:id` | Schemas | Configuration | everyone |
| `/config/people` | People & groups | Configuration | everyone |
| `/config/channels` | Channels and dead letters | Configuration | everyone |

The current filter is stored in the URL (`/?q=<url-encoded filter>`), so a filtered view can be shared
as a link and survives a page refresh.

## 3. Landing page (`/`) layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ⚙   [ (alert.status = important) AND (alert.type = timeout)       ☆ ] [+] │  ← top bar
├──────────────────────────────────────────────────────────────────────────┤
│ ▌ Order settlement failed: validate-counterparty      settlement   2m  ×3│
│ ▌ Rejected EUR 25,000,000 — LIMIT_BREACH              trade-gw     4m    │
│ ▌ Error rate 12% over the last 5 minutes              payments     9m    │
│ ▌ ...                                                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

The page has only these elements:
1. **Settings icon** in the top-left corner (section 4).
2. **Filter bar** across the top (section 5).
3. **Add button `+`**, to the right of the filter bar, shown only for permitted profiles (section 8).
4. **Alert list**, which fills the rest of the screen below the filter bar (section 6).

## 4. Settings (top-left)

- A small gear icon in the top-left corner. It is the only navigation element on the page.
- Clicking it expands a compact panel (dropdown or slide-out from the left) that does not cover the
  whole screen. Clicking outside or pressing `Esc` closes it.
- Contents: current profile (name, role), notification preferences, theme (system / light / dark),
  and a list of starred filters with the option to remove them. Keep it to a short, plain list.

## 5. Filter bar

### 5.1 Filter language

The user types a conditional expression, for example:

```
(alert.status = important) AND (alert.type = timeout)
```

| Element | Syntax |
|---|---|
| Field | dotted path, e.g. `alert.status`, `alert.type`, `alert.service`, `payload.notional`, `error.code` |
| Comparison | `=`, `!=`, `>`, `>=`, `<`, `<=`, `contains`, `in` |
| Value | bare word (`timeout`), quoted text (`"order settlement"`), number (`10000000`), list for `in` (`[TIMEOUT, REJECTED]`) |
| Logic | `AND`, `OR`, `NOT`, parentheses for grouping |

- Keywords are case-insensitive (`and` = `AND`). Field names are case-sensitive.
- An empty filter shows all alerts.
- Available field names come from the backend (fields seen in real alerts), not from a hard-coded list.

### 5.2 Validity feedback

- **Valid** filter: the alert list updates as the user types (debounced around 250 ms). The input
  shows a subtle valid state (thin green left edge or border; nothing louder).
- **Invalid** filter: thin red border and a one-line plain-English message under the input, e.g.
  `Expected a value after "=" at position 17`. The alert list keeps showing the last valid result.
- Never show a modal or toast for filter errors.

### 5.3 Autocomplete (Wireshark-style)

While the user types, a suggestion list opens directly under the input. It completes the token under
the cursor, based on where the cursor is in the expression:

| Cursor position | Suggests |
|---|---|
| start of an expression, after `(`, `AND`, `OR`, `NOT` | field names |
| after a field name | comparison operators |
| after an operator | values seen for that field (most recent alerts) |
| after a complete condition or `)` | `AND`, `OR`, `)` |

Rules:
- Match the typed prefix case-insensitively.
- Ordering: **starred filters first, then everything else in alphabetical order** (see 5.4).
- Show at most around 10 items; the list scrolls if there are more.
- Keyboard: `↑` / `↓` to move, `Tab` or `Enter` to accept, `Esc` to close. Mouse click also accepts.
- Accepting a field name or operator inserts it followed by a space, so the user can keep typing.

### 5.4 Starred (favourite) filters

- A **subtle outlined star `☆`** appears:
  - at the right end of the filter input, once the current filter is valid;
  - at the right end of each suggestion row that is a complete, valid filter.
- Clicking it stars the filter (filled star `★`, using the accent colour). Clicking again unstars it.
  Clicking the star in a suggestion row stars the filter without accepting it.
- Starred filters are saved per user profile and remain after logging out and back in.
- **Empty input + focus:** the suggestion list opens and shows the starred filters at the top
  (alphabetically), with nothing else needed below them.
- **While typing:** starred filters that match the text (case-insensitive, matching anywhere in the
  filter text) are shown first, alphabetically, followed by the token completions from 5.3,
  alphabetically.
- Starred rows look the same as other rows, apart from the filled star on the right. No separate
  heading or coloured background.

## 6. Alert list

### 6.1 Ordering and live updates

- Sorted **newest first** (by last occurrence).
- Updates in real time (server push, not polling or manual refresh).
- A new alert appears at the top with a brief background highlight (around 1.5 s fade, nothing else).
- If the user has scrolled down, do not move the list. Show a small pill at the top instead,
  `3 new alerts`; clicking it scrolls to the top.

### 6.2 Collapsed row (default)

One line, around 36 px high, containing, from left to right:
1. severity marker: a 3 px coloured bar on the left edge, plus a short text label for accessibility
   (`CRIT`, `ERR`, `WARN`, `INFO`);
2. title (from the rule's template), truncated with an ellipsis;
3. service / source, muted;
4. relative time (`2m`), with the exact time in a tooltip;
5. duplicate counter `×3`, only when the count is greater than 1.

### 6.3 Expanded row

- Clicking a row (or the chevron at its start) expands it in place; clicking again collapses it.
  More than one row can be expanded at once.
- The expanded area shows a few key facts as label/value pairs: message/summary, environment, type,
  status, first seen, last seen, plus the alert's main identifiers (e.g. workflow ID, trade ID).
- At the bottom right: **Open** link, which goes to `/alerts/:id`. Ctrl/Cmd-click opens it in a new tab.

## 7. Alert detail page (`/alerts/:id`)

### 7.1 Layout

```
← Back to alerts

▌ Order settlement failed: validate-counterparty                 CRIT · ×3
  settlement · prod · first seen 09:14:02 · last seen 09:16:40

  Type              WORKFLOW_FAILED
  Workflow ID       WF-20261023-00042
  Workflow name     order-settlement
  Step              validate-counterparty
  Environment       prod
  Timestamp         23 Oct 2026, 09:14:02 (2 min ago)

  Error
    Code            TIMEOUT
    Message         Counterparty service did not respond in 5000 ms
```

- **Back to alerts** returns to the list with the previous filter and scroll position restored.
- The header repeats the title, severity, counter and the most important context in one muted line.

### 7.2 Showing the event data ("JSON without the brackets")

The full event is shown as a clean, readable list of fields. The user should never see `{ } [ ] " ,`.

- Each field is one row: **label** on the left (muted), **value** on the right.
- **Labels:** humanised from the key (`workflowId` → `Workflow ID`, `startsAt` → `Starts at`).
  Hovering a label shows the original path (`payload.workflowId`) with a copy button, because that
  path is what users type in the filter.
- **Nested objects** become a small section: the object's name as a sub-heading, its fields indented
  underneath. Sections can be collapsed; all are expanded by default.
- **Arrays** of simple values are shown as a comma-separated line. Arrays of objects become numbered
  sub-sections (`Alert 1`, `Alert 2`).
- **Value formatting:**
  - timestamps (ISO strings, epoch seconds or milliseconds) → `23 Oct 2026, 09:14:02 (2 min ago)`;
  - large numbers → thousands separators (`25,000,000`);
  - booleans → `Yes` / `No`;
  - empty or null → a muted `—`;
  - IDs and codes in a monospace font.
- Keep the original order of keys from the event; do not sort them alphabetically.
- At the very bottom: a quiet **View raw JSON** toggle (collapsed by default) for engineers, with a
  copy button.

## 8. Add button `+` and rule creation

- Shown only when the current profile has permission to create rules. For other profiles it is
  **not rendered at all** (not disabled, not greyed out).
- A small square icon button with `+`, to the right of the filter bar, with the tooltip `New rule`.
- Clicking it opens **`/rules/new`** as a separate page (not a modal).
- What that page contains and how rule creation works is specified separately in the rule-creation
  documentation in this repo. Do not design it from this file.

## 9. Visual style

| Token | Value |
|---|---|
| Fonts | IBM Plex Sans (UI text), IBM Plex Mono (IDs, codes, the filter input, raw JSON) |
| Text sizes | 13 px list rows and labels, 14 px body, 18 px page titles. Weights 400 and 600 only. |
| Radius | 4 px. No pill-shaped buttons apart from the `N new alerts` pill. |
| Shadows | Only on floating layers (suggestion list, settings panel). |
| Spacing | 4 / 8 / 12 / 16 / 24 px. |
| Icons | Lucide, 16 px, stroke 1.5. |
| Motion | 120–160 ms ease-out, only for expanding rows, opening panels and highlighting new alerts. Respect `prefers-reduced-motion`. |

Colours: Grafana's structure and neutrals with Goldman Sachs blue as the one brand highlight.
The single source is `packages/web/src/styles/tokens.css`; never hard-code colours in page CSS.

| Role | Dark | Light |
|---|---|---|
| Brand / highlight (links, focus, active nav, primary buttons) | `#7399C6` (links `#8FB2DD`, buttons `#3E6AA6`) | `#2F5D97` |
| Critical (text / fill) | Grafana red `#F2495C` / dark-red `#E02F44` | `#C4162A` / `#E02F44` |
| Error | orange `#FF9830` / dark-orange `#FA6400` | `#C25400` / `#FA6400` |
| Warning | semi-dark-yellow `#F2CC0C` / dark-yellow `#E0B400` (dark text) | `#946D00` / `#E0B400` |
| Info | blue `#5794F2` / dark-blue `#3274D9` | `#1F60C4` / `#3274D9` |
| OK / healthy, resolved | green `#73BF69` | `#1A7F4B` |
| Acknowledged | purple `#B877D9` | `#8F3BB8` |

Severity colours are for severity only; decoration (badges, edges, icons) stays neutral.

### Do not

- gradients, glassmorphism, blurred backgrounds, glowing effects;
- emoji anywhere in the UI;
- cards inside cards, big rounded cards with soft shadows around every element;
- coloured badges on every field; colour is for severity, alert state (acknowledged, resolved),
  validity and the accent only;
- default, untouched component-library styling (re-theme it with the tokens above first);
- placeholder content (`Lorem ipsum`, `John Doe`, invented statistics); use realistic alerts based
  on the samples in `docs/human/GIVEN_SPEC.md` Appendix A;
- toasts for routine events; modals for anything except confirming a destructive action.

## 10. States

- **Loading:** 6–8 skeleton rows in the list; no spinners in the middle of the page.
- **Empty (no alerts at all):** one muted line, `No alerts yet.`, and for permitted profiles a text
  link `Create a rule` that opens `/rules/new`.
- **Empty (filter matches nothing):** `No alerts match this filter.` and a `Clear filter` link.
- **Connection lost:** a thin bar under the top bar, `Live updates paused — reconnecting…`, which
  disappears by itself when the connection returns.

## 11. Accessibility and keyboard

- `/` focuses the filter input from anywhere on the page.
- `↑` / `↓` moves between alerts, `Enter` or `→` expands, `←` collapses, `o` opens the detail page.
- Severity is never shown by colour alone (always with the text label).
- Text contrast of at least WCAG AA in both themes; visible focus rings in the accent colour.

## 12. Open questions

Record answers here as they are decided:

- ~~Exact list of profiles/roles and which of them may create rules.~~ **Decided:** no auth. Profiles
  are the people in People & groups, chosen from a profile picker in the settings panel (no
  password). A `canCreateRules` flag on each person decides whether `+` is rendered.
- ~~Where starred filters are stored.~~ **Decided:** backend, per profile.
- ~~Content of the settings panel.~~ **Decided:** profile picker, My notifications, theme, starred
  filters, and a short **Configure** list linking to separate pages: `/config/sources`,
  `/config/schemas`, `/config/rules`, `/config/people`, `/config/channels`. These pages follow this
  file's visual style; they are the only additions to section 2's routes.
- **Decided (filter language):** the same language is used for rules, routing and runbook matching.
  Common fields use the `alert.` prefix (`alert.severity`, `alert.source`, `alert.status`,
  `alert.environment`, `alert.schema`); raw event fields use their own path. Added operators:
  `matches` (glob, e.g. `pricing-engine-*`), `in`, `not`; `>=`/`<=` on `alert.severity` follow
  severity order. Severity values are `critical`, `error`, `warning`, `info`; alert status values are
  `open`, `acknowledged`, `resolved` (the example `alert.status = important` in section 3 is
  illustrative only).
- **Decided (`/rules/new`):** specified in `docs/autopilot/SPEC.md` (When → Who → Looks, using this
  file's filter input for conditions).
