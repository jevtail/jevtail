// Sinks deliver alerts. Each is (events) => Promise<void>; add one by copying.
import { flat, renderAnalysis, type JudgedEvent, type Analysis } from "@jevtail/core";

export type Sink = (alerts: JudgedEvent[]) => Promise<void>;

const SEV = ["⚪", "🟡", "🟠", "🔴"];
const WORD = ["noise", "MINOR", "MAJOR", "CRITICAL"];
const pct = (n: unknown) => (typeof n === "number" ? `${Math.round(n * 100)}%` : "");

interface Parts { icon: string; sev: string; category: string; source: string; novel: boolean; message: string; facts: string[]; where: string; link?: string }

function parts(e: JudgedEvent): Parts {
  const j = flat(e.judgment ?? {});
  const sev = typeof j.severity === "number" ? Math.min(3, Math.round(j.severity)) : 0;
  const facts: string[] = [];
  if (typeof j.is_failure === "number") facts.push(`failure ${pct(j.is_failure)}`);
  if (typeof j.needs_human === "number") facts.push(`human ${pct(j.needs_human)}`);
  if (typeof j.security === "number" && j.security >= 0.5) facts.push(`security ${pct(j.security)}`);
  const n = e.meta?.occurrences as number | undefined;
  if (n && n > 1) facts.push(`×${n}`);
  const m = e.meta ?? {};
  const where = [m.project ?? m.projectName, m.environment, m.path ?? m.url, m.users ? `${m.users} users` : ""].filter(Boolean).join(" · ");
  return { icon: SEV[sev], sev: WORD[sev], category: String(j.category ?? "?"), source: e.source, novel: e.novel, message: e.message.slice(0, 400), facts, where, link: e.link ? String(e.link) : undefined };
}

/** Plain text (Slack, Discord, stdout). */
export function format(e: JudgedEvent): string {
  const p = parts(e);
  const why = e.analysis ? ["", ...renderAnalysis(e.analysis as Analysis, e.ts)] : [];
  return [`${p.icon} ${p.sev} · ${p.category} · ${p.source}${p.novel ? " · new" : ""}`, "", p.message, "", [p.facts.join(" · "), p.where].filter(Boolean).join("\n"), p.link ?? "", ...why].filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n").trim();
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Telegram HTML: bold header, monospace message, a short link label instead of a long URL. */
export function formatTelegram(e: JudgedEvent): string {
  const p = parts(e);
  const lines = [
    `${p.icon} <b>${p.sev}</b> · ${esc(p.category)} · <b>${esc(p.source)}</b>${p.novel ? " · new" : ""}`,
    "",
    `<code>${esc(p.message)}</code>`,
    "",
    p.facts.length ? esc(p.facts.join(" · ")) : "",
    p.where ? esc(p.where) : "",
    p.link ? `<a href="${esc(p.link)}">open ↗</a>` : "",
    ...(e.analysis ? ["", ...renderAnalysis(e.analysis as Analysis, e.ts).map((l, i) => (i === 0 ? `<b>${esc(l)}</b>` : esc(l)))] : []),
  ];
  return lines.filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n").trim();
}

export const stdout: Sink = async (alerts) => { for (const a of alerts) console.log(format(a) + "\n"); };

export function telegram(botToken: string, chatId: string, f: typeof fetch = fetch): Sink {
  return async (alerts) => {
    for (const a of alerts) {
      await f(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: formatTelegram(a), parse_mode: "HTML", disable_web_page_preview: true }),
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
