import { test, expect } from "bun:test";
import { bunSqlite } from "@jevtail/core/store-bun";
import { createApp } from "./app";

test("end to end: sentry webhook -> judged -> alert delivered to sink", async () => {
  const jevCalls: any[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    const body = JSON.parse(init.body); jevCalls.push(body);
    const answers: any = {};
    for (const e of body.state.events) {
      answers[`${e.id}.is_failure`] = { type: "noul", noul: 0.97 };
      answers[`${e.id}.needs_human`] = { type: "noul", noul: 0.9 };
      answers[`${e.id}.severity`] = { type: "score", score: 2.6, confidence: 0.8, probabilities: {} };
      answers[`${e.id}.category`] = { type: "choice", choice: "dependency", confidence: 0.9, probabilities: {} };
      answers[`${e.id}.security`] = { type: "noul", noul: 0.01 };
    }
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 300 } }), { status: 200 });
  }) as any;
  const delivered: string[] = [];
  const store = await bunSqlite(":memory:");
  const app = createApp({ store, env: { TYPESAFE_API_KEY: "k", JEVTAIL_TOKEN: "s3cret" } as any, fetchImpl, sinks: [async (as) => { for (const a of as) delivered.push(a.message); }] });

  const unauth = await app.request("/in/sentry", { method: "POST", body: "{}" });
  expect(unauth.status).toBe(401);

  const payload = { action: "created", data: { event: { title: "PrismaClientKnownRequestError: Can't reach database server", level: "error", timestamp: 1758240000, web_url: "https://sentry.io/i/9" }, issue: { project: { slug: "api" } } } };
  const res = await app.request("/in/sentry?token=s3cret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ received: 1, judged: 1, alerts: 1 });
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain("Can't reach database server");
  expect(Object.keys(jevCalls[0].questions)).toContain("e0.category");

  // same shape again: template cached, cooldown suppresses the alert
  const again = await app.request("/in/sentry?token=s3cret", { method: "POST", body: JSON.stringify(payload) });
  expect(await again.json()).toMatchObject({ judged: 0, alerts: 0 });

  const events = await (await app.request("/events?token=s3cret&since=0")).json() as any[];
  expect(events).toHaveLength(2);
  expect(events[0].judgment.category.choice).toBe("dependency");
  const health = await (await app.request("/health")).json() as any;
  expect(health.rules).toContain("category");
});
