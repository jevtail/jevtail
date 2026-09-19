# Alert destinations

Fastest to slowest to set up. Configure one or more; when none is set, alerts print to stdout.

## Telegram (about a minute)

1. Message **@BotFather** → `/newbot` → copy the token.
2. Open the new bot and press **Start**. Bots cannot message you first; until you do this,
   sending fails with `400 chat not found`.
3. Your chat id: `https://api.telegram.org/bot<token>/getUpdates` after step 2, or send the
   bot a message and read `message.chat.id` from that response.

```
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=6519334879
```

## Discord (one click)

Channel → Edit → Integrations → Webhooks → New → copy URL.

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

## Slack

Create an app → Incoming Webhooks → Add to workspace → copy URL.

```
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

## Anything with an incoming webhook

`ALERT_WEBHOOK_URL=…` posts `{"text": "<alert>"}`.

## What an alert looks like

```
🟠 major · dependency · docker:api · NEW
Error: connect ECONNREFUSED 10.0.0.8:5432 (pool exhausted after 19s)
failure 0.95 · needs_human 0.84 · ×40
/api/checkout
```

One alert per template per `JEVTAIL_ALERT_COOLDOWN_MIN` (60). The line is
`needs_human ≥ 0.7` or `severity ≥ 2`; change it by overriding the rules
(`JEVTAIL_RULES`) or the thresholds in code.
