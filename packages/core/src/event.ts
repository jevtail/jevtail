/** One log line / alert / error, normalized from any receiver. */
export interface Event {
  id: string;
  tenant: string;
  source: string;            // "sentry" | "vercel" | "supabase" | "generic" | ...
  ts: number;                // epoch ms
  level: "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  meta?: Record<string, unknown>;
  link?: string;
}

export type Judgment = Record<string, JevAnswer>;
export type JevAnswer = { type: string; noul?: number; choice?: string; score?: number; confidence?: number; probabilities?: Record<string, number> };

export interface JudgedEvent extends Event { template: string; judgment?: Judgment; novel: boolean }

export function uid(): string {
  return crypto.randomUUID();
}

export function levelOf(v: unknown, fallback: Event["level"] = "info"): Event["level"] {
  const s = String(v ?? "").toLowerCase();
  if (s.startsWith("fatal") || s === "critical" || s === "panic" || s === "emerg") return "fatal";
  if (s.startsWith("err")) return "error";
  if (s.startsWith("warn")) return "warn";
  if (s.startsWith("debug") || s === "trace") return "debug";
  if (s === "info" || s === "log") return "info";
  return fallback;
}

/** seconds, ms, or microseconds since epoch; ISO strings; a zone-less ISO string is taken as UTC. */
export function tsOf(v: unknown, fallback = Date.now()): number {
  if (typeof v === "number") return v > 1e15 ? Math.round(v / 1000) : v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === "string") {
    const n = Number(v); if (Number.isFinite(n)) return tsOf(n, fallback);
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(v) ? v + "Z" : v;
    const d = Date.parse(iso); if (!Number.isNaN(d)) return d;
  }
  return fallback;
}
