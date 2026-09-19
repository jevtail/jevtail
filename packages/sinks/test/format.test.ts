import { test, expect } from "bun:test";
import { format, formatTelegram } from "../src/index";
const e: any = { id: "1", tenant: "t", source: "sentry", ts: 0, level: "error", novel: true, template: "k",
  message: "TypeError: Cannot read properties of undefined (reading 'filter') <at />", link: "https://minkyu.sentry.io/issues/1",
  meta: { project: "ophiliapicture", environment: "production", users: 45, occurrences: 3 },
  judgment: { is_failure: { type: "noul", noul: 0.95 }, needs_human: { type: "noul", noul: 0.84 }, severity: { type: "score", score: 2.2 }, category: { type: "choice", choice: "bug" }, security: { type: "noul", noul: 0.01 } } };

test("plain format has a header, a blank line, the message and facts", () => {
  const t = format(e);
  expect(t.split("\n")[0]).toBe("🟠 MAJOR · bug · sentry · new");
  expect(t).toContain("\n\nTypeError");
  expect(t).toContain("failure 95% · human 84% · ×3");
  expect(t).toContain("ophiliapicture · production · 45 users");
});

test("telegram format is HTML-escaped with a short link label", () => {
  const t = formatTelegram(e);
  expect(t).toContain("<b>MAJOR</b>");
  expect(t).toContain("&lt;at /&gt;");
  expect(t).toContain('<a href="https://minkyu.sentry.io/issues/1">open ↗</a>');
  expect(t).not.toContain("https://minkyu.sentry.io/issues/1<");
});
