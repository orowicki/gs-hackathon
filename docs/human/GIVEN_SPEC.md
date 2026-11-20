
# Flexible Alerting & Notification Service
 
*Hackathon 2026 – Software Engineering*
 
## 1. The Problem
 
Every system produces errors, warnings and business events, such as a failed workflow, a breached threshold or a rejected message. Today these signals end up spread across logs, dashboards and mailboxes. The right people find out late, or they get so many alerts they stop reading them.
 
You are asked to build a service that gets the right alert to the right people, on the channel they prefer, and helps them resolve it by following the team's runbooks.
 
Aspects to keep in mind:
 
- **Flexibility** – your service should be easily adoptable to any teams or systems
- **Scalability** – high volume of messages and alerts should not impact your service performance
- **UX** – the service should be usable by engineers, on-call support, and potentially non-engineers – think of their user experience.
## 2. Functionalities
 
### 2.1 Ingest from many sources
 
- Support **at least two different source types**, e.g. a message broker (Kafka, RabbitMQ), an HTTP/webhook endpoint, a tailed log file or a polled API.
- Messages arrive in **different schemas**. The service must not assume one fixed format. Sample events are in Appendix A.
- Adding a new source or schema should need as little code as possible.
### 2.2 Let teams define what they care about
 
Teams set up **rules** that decide which messages reach them:
 
- **Filters on any field.** Examples: source, workflow, schema, severity, environment, or a value in the message body (`amount > 1,000,000`, `error.code in [TIMEOUT, REJECTED]`).
- Rules can be combined with AND/OR logic.
- **Per-rule routing.** Each rule says who gets notified and on which channel(s).
- **Per-rule presentation.** Each rule says how the alert is shown: title and body templates, which fields to include, severity or colour in the UI.
- Rules can be created and changed **at runtime**, through an API, the UI or config files that are reloaded live, without restarting the service.
### 2.3 Deliver alerts on the preferred channel
 
- Sample channels: **Email, SMS, Phone call, UI.**
- Each team or person sets channel preferences, e.g. *critical → phone + SMS; warning → email; info → UI only*. Optional: working hours or on-call schedules.
- External channels **may be simulated**. A mock SMTP server, a fake SMS/phone gateway that logs or shows deliveries, or a sandbox account all count. What we judge is that adding a real provider would be a small, isolated change.
- Delivery must survive failure: retries, and no lost alerts when a channel is down.
### 2.4 Service UI
 
- Live feed of alerts for a team, updated in real time (push, not page refresh).
- Acknowledge or resolve an alert.
- Manage rules and channel preferences.
- Propose fixes / enhancements to the alerts.
- Each rule controls how its alerts look (see 2.2).
### 2.5 Don't flood people
 
- **Deduplication.** The same error 500 times in a minute is one alert with a counter, not 500.
- **Throttling or grouping** per rule or recipient.
### 2.6 Help resolve alerts with runbooks
 
An alert should tell people what to do next, not only what went wrong.
 
- Teams attach runbooks or instructions to rules, schemas or alert types. They come in many formats: a Markdown page, a link to a wiki/Confluence, a checklist, or plain free text written by a person. See example in Appendix B.
- When an alert fires, it displays the matching runbook and the next steps, filled in with values from the message (e.g. the workflow ID or service name), on every channel where they fit (the full steps in the UI and email, a short link in an SMS).
- Steps can be actions as well as text: retry a workflow, restart a service, call a webhook, open a ticket, escalate to another team. Risky actions need a human to approve them first, from the UI or by replying to the alert.
- Record what was done and by whom, and close the alert when the problem goes away.
- Adding a new runbook or a new kind of action should be as easy as adding a rule.
- Optionally, think of an automatic way to record steps to resolve the incidents, so the runbooks/knowledge base is auto updated.
## 3. Judging Criteria
 
- **Flexibility** – How easy is it to add a new source, schema, channel or rule type? Is that config or code? How expressive are the rules?
- **Scalability** – Can the service scale horizontally? How is state handled (rules, dedup windows, delivery status)? Is there an obvious bottleneck or single point of failure?
- **UX** – Is the UI usable by someone who has never seen it? Is the rule editor understandable? Are alerts clear and actionable? From a fresh clone to a working demo: how many commands, and how long? Is the README clear? How long does it take a new team to start getting alerts?
- **Throughput / Latency** – Messages per second ingested and processed, and the end-to-end latency from ingest to delivery (p50/p99). **Measured, not estimated.** Include your load-test script and results in the presentation.
- **Level of implementation** – Include a link to your repo with clear README and description of what has been mocked.
- **Innovation** – Any outstanding solution or additional functionality will be appreciated.
- **Presentation**
## 4. Submission
 
- **Create video:** Each team must prepare a video of up to five minutes that explains and showcases its solution, remember that it will be the primary basis for judging your solution across all categories.
- If you used AI tools (e.g., Copilot, Claude) during development, share how you used them and how you addressed security and privacy concerns.
- **Upload your video:** The video should be uploaded to Lockbox under a directory named with the team's name. We recommend you submit also other resources, such as a text file with a link to a Git repository or a demo application.
- After the first round, judges will select the top five teams to present live in the finals, followed by a Q&A session.
***Talk with our mentors!***
 
---
 
## Appendix A — Sample Events
 
These are examples, not a fixed contract. Your service must handle schemas it has never seen, and judges will bring a new one to the demo.
 
**Workflow failure** (from a message broker):
 
```json
{
  "type": "WORKFLOW_FAILED",
  "workflowId": "WF-20261023-00042",
  "workflowName": "order-settlement",
  "step": "validate-counterparty",
  "severity": "ERROR",
  "environment": "prod",
  "timestamp": "2026-10-23T09:14:02.331Z",
  "error": {
    "code": "TIMEOUT",
    "message": "Counterparty service did not respond in 5000 ms"
  }
}
```
 
**Metric threshold breach** (from an HTTP webhook):
 
```json
{
  "alertname": "HighErrorRate",
  "labels": {
    "service": "payments-api",
    "region": "eu-west",
    "severity": "critical"
  },
  "annotations": {
    "summary": "Error rate 12% over the last 5 minutes"
  },
  "startsAt": "2026-10-23T09:13:00Z",
  "status": "firing"
}
```
 
**Business event** (from a message broker, using a different envelope):
 
```json
{
  "meta": {
    "schema": "trade.rejected.v2",
    "producer": "trade-gateway",
    "ts": 1792833245000
  },
  "payload": {
    "tradeId": "T-998877",
    "desk": "rates",
    "notional": 25000000,
    "currency": "EUR",
    "reason": "LIMIT_BREACH"
  }
}
```
 
### Example rules, in plain words
 
- *Team Settlements*: any `WORKFLOW_FAILED` where `workflowName = order-settlement` and `environment = prod` → **phone the on-call person + SMS**; show the step and the error message in red in the UI.
- *Team Pricing*: log lines from `pricing-engine-*` at `WARN` or above → **UI only**; group them into one alert per instrument every 5 minutes.
- *Team Rates*: `trade.rejected.*` where `desk = rates` and `notional > 10,000,000` → **email + UI**; title `"Rejected {{payload.currency}} {{payload.notional}} — {{payload.reason}}"`.
- *Anna (personal)*: anything `critical` from `payments-api` → **SMS**, but only between 08:00 and 20:00; otherwise **email**.
## Appendix B — Sample Runbooks
 
Runbooks come in different shapes. Your service should cope with more than one, and judges will bring one you have not seen.
 
**Structured steps** (YAML, for the Team Settlements rule):
 
```yaml
runbook: settlement-timeout
matches:
  type: WORKFLOW_FAILED
  "error.code": TIMEOUT
steps:
  - check: "Is counterparty-service healthy?"
    action: http_get
    url: "http://counterparty-service/health"
  - action: retry_workflow
    workflowId: "{{workflowId}}"
    approval: none
  - if: "retry fails twice"
    action: escalate
    team: counterparty-support
    approval: required
```
 
**Markdown page** (written by people, for the payments rule):
 
```markdown
# HighErrorRate on payments-api
1. Open the payments dashboard and check if errors are in one region only.
2. If one region: fail traffic over to the other region (needs approval from the team lead).
3. If all regions: check the last deployment and roll it back.
4. Post an update in the #payments-incidents channel every 15 minutes.
```
 
**Free text** (copied from a wiki or a chat message):
 
> When pricing latency goes over a second, it's usually the cache. Restart the pricing-engine instance named in the alert, wait 2 minutes, and if latency is still high, call the pricing on-call person.
 

