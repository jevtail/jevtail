# Vercel

Vercel pushes through **Log Drains**, which exist on Pro and Enterprise teams. Hobby
projects have no drain and no runtime-logs API, so there is nothing to connect on Hobby:
put a Sentry SDK in the app instead and connect Sentry.

## Setup (Pro)

1. Team Settings → **Log Drains** → Add.
2. Sources: Function, Edge, Build (skip Static: it is request noise). Format: **JSON** or
   **NDJSON**, both are accepted.
3. Endpoint: `https://<host>/in/vercel?token=<JEVTAIL_TOKEN>`.
4. Vercel verifies the endpoint by expecting an `x-vercel-verify` header in the response.
   Copy the string it shows into jevtail's env as `VERCEL_VERIFY=…` and restart before
   clicking Verify.

## What the receiver does

- Level from `level` when present, else `statusCode ≥ 500 → error`, `≥ 400 → warn`.
- Message from `message`, else `"<method> <path> <status>"` for proxy rows.
- Link to the deployment (`projectName` + `deploymentId`), meta keeps source, host, path,
  requestId, environment, branch.

Status: parsed against the documented drain shapes; not yet verified against a live drain.
