// bun:sqlite driver, kept out of index.ts so the Workers bundle never imports it.
import type { Store } from "./store";

/** bun:sqlite driver. Imported lazily so the Workers bundle never sees it. */
export async function bunSqlite(path: string): Promise<Store> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  return {
    async exec(sql, params = []) { db.query(sql).run(...(params as any[])); },
    async all(sql, params = []) { return db.query(sql).all(...(params as any[])) as any[]; },
  };
}

