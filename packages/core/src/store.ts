// One SQL dialect (SQLite), two drivers: bun:sqlite for Docker/local, D1 for
// Cloudflare Workers. Core only ever calls exec/all with the same SQL text.
export interface Store {
  exec(sql: string, params?: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL, source TEXT NOT NULL, ts INTEGER NOT NULL,
  level TEXT NOT NULL, message TEXT NOT NULL, meta TEXT, link TEXT,
  template TEXT NOT NULL, judgment TEXT
);
CREATE INDEX IF NOT EXISTS events_tenant_ts ON events(tenant, ts);
CREATE TABLE IF NOT EXISTS templates (
  tenant TEXT NOT NULL, key TEXT NOT NULL, source TEXT NOT NULL, level TEXT NOT NULL, masked TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL,
  judgment TEXT, judged_ts INTEGER, alerted_ts INTEGER,
  PRIMARY KEY (tenant, key)
);
CREATE TABLE IF NOT EXISTS analyses (
  tenant TEXT NOT NULL, template TEXT NOT NULL, ts INTEGER NOT NULL, analysis TEXT NOT NULL,
  PRIMARY KEY (tenant, template)
);`;

export async function migrate(store: Store) {
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await store.exec(stmt);
}

/** Cloudflare D1 driver (env.DB binding). */
export function d1(db: { prepare(sql: string): { bind(...p: unknown[]): { run(): Promise<unknown>; all<T>(): Promise<{ results: T[] }> } } }): Store {
  return {
    async exec(sql, params = []) { await db.prepare(sql).bind(...params).run(); },
    async all<T>(sql: string, params: unknown[] = []) { return (await db.prepare(sql).bind(...params).all<T>()).results; },
  };
}
