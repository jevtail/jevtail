# Sentry

Sentry already groups errors into issues, so jevtail receives one webhook per new,
regressed or reappeared issue and judges it (severity, category, needs_human) with the
issue's user and event counts as context.

## What you need

- A jevtail public URL: `https://<host>/in/sentry?token=<JEVTAIL_TOKEN>`
- Either two minutes in the Sentry UI, **or** a user token to let a script do it.

## Option A: UI (no token)

1. Settings → Developer Settings → Custom Integrations → **Create New Integration** → Internal.
2. Name `jevtail`, Webhook URL = the jevtail URL, enable **Alert Rule Action**, tick
   **Issue** webhooks (`created` is enough). Save.
3. Alerts → Create Alert → Issues → conditions "A new issue is created" (add
   "regression" and "reappeared" if you like) → action **Send a notification via an
   integration → jevtail**. Repeat per project, or pick "all projects".

## Option B: API (script does everything)

Create a **Personal Token** (Settings → Account → API → Personal Tokens), not an
Organization Token: organization tokens (`sntrys_…`) default to CI scopes and return 403 on
everything below. Permissions:

| Permission | Level | Why |
| --- | --- | --- |
| Project | Write | alert workflows are project-scoped |
| Organization | Write | creating the internal integration (`org:write`) |
| Alerts | Write | creating the workflow |
| Issue & Event | Read | optional, to verify with a test event |

Two hosts matter on SaaS:

- Integrations live on the control host: `https://sentry.io/api/0/sentry-apps/`
- Alerts and projects live on your region host, e.g. `https://us.sentry.io/api/0/…`
  (the region is shown in Settings → General; using the wrong host gives a bare 404)

```bash
S=https://sentry.io/api/0; R=https://us.sentry.io/api/0; H="Authorization: Bearer $SENTRY_TOKEN"
# 1. internal integration with the webhook
curl -X POST $S/sentry-apps/ -H "$H" -H 'content-type: application/json' -d '{
  "name":"jevtail","organization":"<org>","webhookUrl":"https://<host>/in/sentry?token=<JEVTAIL_TOKEN>",
  "isAlertable":true,"isInternal":true,"verifyInstall":false,"events":["issue"],"scopes":["event:read","project:read"]}'
# -> note the "slug" (e.g. jevtail-b7b0b6); it is auto-installed on the org
# 2. detectors: one "Error Monitor" per project
curl "$R/organizations/<org>/detectors/?type=error" -H "$H"
# 3. one workflow bound to those detectors, action = webhook to the integration slug
curl -X POST $R/organizations/<org>/workflows/ -H "$H" -H 'content-type: application/json' -d '{
  "name":"jevtail","enabled":true,"config":{"frequency":30},
  "triggers":{"logicType":"any-short","conditions":[
    {"type":"first_seen_event","comparison":true,"conditionResult":true},
    {"type":"regression_event","comparison":true,"conditionResult":true},
    {"type":"reappeared_event","comparison":true,"conditionResult":true}]},
  "actionFilters":[{"logicType":"all","conditions":[],"actions":[
    {"type":"webhook","data":{},"config":{"targetType":null,"targetDisplay":null,"targetIdentifier":"<integration slug>"}}]}],
  "detectorIds":["<detector id>", "..."]}'
```

Note: an internal integration subscribed to **Issue** webhooks already delivers
`issue.created` (and `resolved`, `assigned`, `ignored`, which jevtail ignores) without any
workflow. The workflow adds regression and reappearance triggers and the alert-rule path.

Traps we hit:

- Workflow `triggers.logicType` must be `any-short` (the API rejects `any`).

- `POST /projects/{org}/{project}/rules/` returns **410 Gone**: the legacy issue-alert API is
  retired in favour of workflows above.
- `/projects/{org}/{project}/plugins/webhooks/` returns **404**: the legacy WebHooks plugin is
  gone on SaaS. Use an internal integration.
- Creating the integration with extra fields (`author`, `overview`, `redirectUrl`) returned a
  bare 403 in our run; the minimal body above worked.

## Verify

Send one event through the project's DSN and watch it arrive:

```bash
curl -X POST "https://<ingest-host>/api/<project id>/store/" \
  -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_key=<public key>" -H 'content-type: application/json' \
  -d '{"event_id":"'$(uuidgen | tr -d - | tr A-Z a-z)'","level":"error","platform":"javascript",
       "exception":{"values":[{"type":"WiringTest","value":"PaymentGateway timeout, orders failing"}]}}'
```

Then resolve the test issue in Sentry. Alerts fire only for new / regressed / reappeared
issues, so a second identical event does not trigger again until the issue changes state.
