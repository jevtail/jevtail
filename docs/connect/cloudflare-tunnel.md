# Public URL for a home server (Cloudflare Tunnel)

Webhook sources (Sentry, Vercel, Supabase drains) need to reach jevtail. If it runs on a
Mac mini or a NAS behind NAT, a Cloudflare Tunnel gives it a hostname with TLS and no open
ports.

## Dashboard-managed tunnel (the `cloudflared tunnel run --token …` kind)

Zero Trust → Networks → Tunnels → your tunnel → **Public Hostname** → Add:
`jevtail.<your zone>` → `http://localhost:8787`. Cloudflare creates the DNS record.

## Same thing through the API

Useful when you script the setup. The tunnel config is replaced wholesale on PUT, so read it,
append, and write it back:

```js
const cfg = (await GET(`/accounts/${account}/cfd_tunnel/${tunnel}/configurations`)).result.config;
const catchAll = cfg.ingress.pop();                       // last rule is http_status:404
cfg.ingress.push({ hostname: "jevtail.example.com", service: "http://localhost:8787" }, catchAll);
await PUT(`/accounts/${account}/cfd_tunnel/${tunnel}/configurations`, { config: cfg });
await POST(`/zones/${zone}/dns_records`, { type: "CNAME", name: "jevtail", content: `${tunnel}.cfargotunnel.com`, proxied: true });
```

The hostname answers within a minute. Keep `JEVTAIL_TOKEN` set: the URL is public.

## Locally managed tunnel (config.yml)

Add an ingress entry before the catch-all and restart cloudflared:

```yaml
ingress:
  - hostname: jevtail.example.com
    service: http://localhost:8787
  - service: http_status:404
```
