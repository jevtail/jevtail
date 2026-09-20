// Jev (TypeSafe System One) client: many events per request, one question set
// per event, answers routed back by id. Same shape as jgrep --rows.
import type { Event, Judgment } from "./event";

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-latest";
export const MAX_QUESTIONS_PER_REQUEST = 64;

export type Rules = Record<string, { type: "noul" | "choice" | "score"; instructions: string; [k: string]: unknown }>;

export function validateRules(r: unknown): Rules {
  if (!r || typeof r !== "object") throw new Error("rules must be a JSON object");
  for (const [name, spec] of Object.entries(r as Record<string, any>)) {
    if (!spec || !["noul", "choice", "score"].includes(spec.type) || typeof spec.instructions !== "string")
      throw new Error(`rule "${name}" needs {type: noul|choice|score, instructions}`);
    if (name.includes(".")) throw new Error(`rule name "${name}" must not contain "."`);
  }
  return r as Rules;
}

export function buildRequest(events: Pick<Event, "source" | "level" | "message" | "meta">[], rules: Rules, context?: unknown) {
  const state: Record<string, unknown> = {
    events: events.map((e, i) => ({ id: `e${i}`, source: e.source, level: e.level, message: e.message, ...(e.meta ? { meta: e.meta } : {}) })),
  };
  if (context) state.context = context;
  const questions: Record<string, unknown> = {};
  events.forEach((_, i) => {
    for (const [name, spec] of Object.entries(rules))
      questions[`e${i}.${name}`] = { ...spec, instructions: `Look only at the event with id "e${i}". ${spec.instructions}` };
  });
  return { model: MODEL, state, questions };
}

export interface JevClient { judge(events: Event[], rules: Rules, context?: unknown): Promise<{ judgments: Judgment[]; tokens: number }> }

export type Fetch = typeof fetch;

/** POST one System One request with retries on 429/5xx. */
export async function postSystemOne(body: unknown, apiKey: string, f: Fetch = fetch): Promise<{ answers: Record<string, any>; usage?: { input_tokens: number } }> {
  for (let attempt = 0; ; attempt++) {
    const res = await f(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (res.ok) return (await res.json()) as { answers: Record<string, any>; usage?: { input_tokens: number } };
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
    throw new Error(`TypeSafe API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

export function jevClient(apiKey: string, f: Fetch = fetch, opts: { concurrency?: number } = {}): JevClient {
  const post = (body: unknown) => postSystemOne(body, apiKey, f);
  return {
    async judge(events, rules, context) {
      const k = Object.keys(rules).length;
      const per = Math.max(1, Math.floor(MAX_QUESTIONS_PER_REQUEST / k));
      const batches: number[][] = [];
      for (let i = 0; i < events.length; i += per) batches.push(events.slice(i, i + per).map((_, j) => i + j));
      const judgments: Judgment[] = new Array(events.length);
      let tokens = 0, next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const b = batches[next++];
          const res = await post(buildRequest(b.map((i) => events[i]), rules, context));
          tokens += res.usage?.input_tokens ?? 0;
          b.forEach((ei, j) => {
            const jd: Judgment = {};
            for (const name of Object.keys(rules)) jd[name] = res.answers[`e${j}.${name}`] ?? { type: "missing" };
            judgments[ei] = jd;
          });
        }
      };
      await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 8, batches.length) }, worker));
      return { judgments, tokens };
    },
  };
}

/** Flatten a judgment into scalar fields: noul -> p, choice -> label, score -> number. */
export function flat(j: Judgment): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [name, a] of Object.entries(j)) {
    if (a.type === "noul" && typeof a.noul === "number") out[name] = a.noul;
    else if (a.type === "choice" && a.choice) out[name] = a.choice;
    else if (a.type === "score" && typeof a.score === "number") out[name] = a.score;
  }
  return out;
}
