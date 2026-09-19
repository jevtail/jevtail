// Sinks deliver alerts. Each is (events) => Promise<void>; add one by copying.
import { flat, type JudgedEvent } from "@jevtail/core";

export type Sink = (alerts: JudgedEvent[]) => Promise<void>;

const SEV = ["⚪", "🟡", "🟠", "🔴"];

/** Plain-text message; the judgment fields become the headline, no LLM needed. */
export function format(e: JudgedEvent): string {
  const j = flat(e.judgment ?? {});
  const sev = typeof j.severity === "number" ? Math.min(3, Math.round(j.severity)) : 0;
  const head = `${SEV[sev]} ${["noise", "minor", "major", "critical"][sev]} · ${j.category ?? "?"} · ${e.source}${e.novel ? " · NEW" : ""}`;
  const n = e.meta?.occurrences as number | undefined;
  const lines = [head, e.message.slice(0, 400)];
  const facts: string[] = [];
  if (typeof j.is_failure === "number") facts.push(`failure ${j.is_failure.toFixed(2)}`);
  if (typeof j.needs_human === "number") facts.push(`needs_human ${j.needs_human.toFixed(2)}`);
  if (typeof j.security === "number" && j.security >= 0.5) facts.push(`security ${j.security.toFixed(2)}`);
  if (n && n > 1) facts.push(`×${n}`);
  if (facts.length) lines.push(facts.join(" · "));
  const m = e.meta ?? {};
  const where = [m.project, m.projectName, m.environment, m.path].filter(Boolean).join(" ");
  if (where) lines.push(where);
  if (e.link) lines.push(String(e.link));
  return lines.join("\n");
}

export const stdout: Sink = async (alerts) => { for (const a of alerts) console.log(format(a) + "\n"); };

export function telegram(botToken: string, chatId: string, f: typeof fetch = fetch): Sink {
  return async (alerts) => {
    for (const a of alerts) {
      await f(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: format(a), disable_web_page_preview: true }),
      });
    }
  };
}

/** Slack and Discord incoming webhooks both accept a JSON body with a text field (`text` / `content`). */
export function webhook(url: string, f: typeof fetch = fetch): Sink {
  const field = /discord(?:app)?\.com/.test(url) ? "content" : "text";
  return async (alerts) => {
    for (const a of alerts) await f(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [field]: format(a) }) });
  };
}

/** Build sinks from env-like config; missing values just skip that sink. */
export function sinksFromEnv(env: Record<string, string | undefined>, f: typeof fetch = fetch): Sink[] {
  const out: Sink[] = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) out.push(telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, f));
  for (const k of ["SLACK_WEBHOOK_URL", "DISCORD_WEBHOOK_URL", "ALERT_WEBHOOK_URL"]) if (env[k]) out.push(webhook(env[k]!, f));
  if (env.JEVTAIL_STDOUT !== "0" && out.length === 0) out.push(stdout);
  return out;
}
