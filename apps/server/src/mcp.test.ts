import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bunSqlite } from "@jevtail/core/store-bun";
import { createApp } from "./app";

test("mcp: an MCP client lists tools, ingests, and reads stats/alerts through /mcp", async () => {
  const fakeJev = (async (_u: string, init: any) => {
    const body = JSON.parse(init.body); const answers: any = {};
    for (const e of body.state.events) {
      const bad = /ECONNREFUSED|FATAL/i.test(e.message);
      answers[`${e.id}.is_failure`] = { type: "noul", noul: bad ? 0.95 : 0.05 };
      answers[`${e.id}.needs_human`] = { type: "noul", noul: bad ? 0.9 : 0.1 };
      answers[`${e.id}.severity`] = { type: "score", score: bad ? 2.7 : 0.1, confidence: 0.8, probabilities: {} };
      answers[`${e.id}.category`] = { type: "choice", choice: bad ? "dependency" : "other", confidence: 0.9, probabilities: {} };
      answers[`${e.id}.security`] = { type: "noul", noul: 0.01 };
    }
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 100 } }), { status: 200 });
  }) as any;
  const store = await bunSqlite(":memory:");
  const app = createApp({ store, env: { TYPESAFE_API_KEY: "k", JEVTAIL_TOKEN: "s3cret" } as any, fetchImpl: fakeJev, sinks: [async () => {}] });
  const appFetch = ((input: any, init?: any) => app.request(input, init)) as typeof fetch;

  const denied = await app.request("/mcp", { method: "POST", body: "{}" });
  expect(denied.status).toBe(401);

  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://jevtail.test/mcp?token=s3cret"), { fetch: appFetch }));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  expect(tools).toEqual(expect.arrayContaining(["jevtail_stats", "jevtail_alerts", "jevtail_events", "jevtail_templates", "jevtail_template", "jevtail_judge", "jevtail_ingest"]));

  const ing = await client.callTool({ name: "jevtail_ingest", arguments: { events: [
    { message: "Error: connect ECONNREFUSED 10.0.0.5:5432", level: "error", source: "api" },
    { message: "GET /health 200", level: "info", source: "api" },
  ] } });
  const ingested = JSON.parse((ing.content as any)[0].text);
  expect(ingested).toMatchObject({ received: 2, judged: 2 });
  expect(ingested.alerts).toHaveLength(1);

  const st = JSON.parse((await client.callTool({ name: "jevtail_stats", arguments: { minutes: 60 } }) as any).content[0].text);
  expect(st.events).toBe(2); expect(st.alerts).toBe(1); expect(st.worstTemplates[0].scores.category).toBe("dependency");

  const al = JSON.parse((await client.callTool({ name: "jevtail_alerts", arguments: {} }) as any).content[0].text);
  expect(al).toHaveLength(1); expect(al[0].message).toContain("ECONNREFUSED");

  const tpl = JSON.parse((await client.callTool({ name: "jevtail_template", arguments: { key: al[0].template } }) as any).content[0].text);
  expect(tpl.samples).toHaveLength(1);

  const judged = JSON.parse((await client.callTool({ name: "jevtail_judge", arguments: { lines: ["FATAL: out of memory"] } }) as any).content[0].text);
  expect(judged[0].scores.severity).toBe(2.7);
  await client.close();
});
