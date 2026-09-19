# Connecting sources

One page per platform: which credential you need, the exact scopes, where the URL goes,
and the traps we hit while wiring real projects. All webhooks use the same URL shape:

```
https://<your-jevtail-host>/in/<receiver>?token=<JEVTAIL_TOKEN>
```

| Platform | Mode | Credential | Plan gate | Guide |
| --- | --- | --- | --- | --- |
| Sentry | push (webhook) | user token or 2 minutes in the UI | free | [sentry.md](sentry.md) |
| Supabase | pull (Management API) or push (Log Drain) | personal access token | drain needs Pro, pull works on free | [supabase.md](supabase.md) |
| Vercel | push (Log Drain) | dashboard | Pro | [vercel.md](vercel.md) |
| Files and containers on a box you own | pull (`tail -F`, `docker logs -f`) | none | free | [self-hosted.md](self-hosted.md) |
| Telegram / Slack / Discord (alerts out) | sink | bot token / webhook URL | free | [alerts.md](alerts.md) |
| Cloudflare Tunnel (public URL for a home server) | infra | Cloudflare account | free | [cloudflare-tunnel.md](cloudflare-tunnel.md) |
| Datadog, CloudWatch, Elasticsearch, Loki | push (forwarding / subscription) | see page | varies | [planned.md](planned.md) |

Rule of thumb: prefer the platform's push mechanism when the plan allows it (no polling, no
token stored on your side); fall back to pulling through a read-only API on free tiers.
