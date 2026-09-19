// Bun / Docker entry point. `bun apps/server/src/bun.ts`
import { bunSqlite } from "@jevtail/core/store-bun";
import { createApp, type Env } from "./app";
import { tailFiles, tailDocker, pollSupabase } from "./sources";

const env = process.env as unknown as Env;
if (!env.TYPESAFE_API_KEY) { console.error("TYPESAFE_API_KEY is required (https://console.typesafe.ai)"); process.exit(2); }
const store = await bunSqlite(process.env.JEVTAIL_DB ?? "./jevtail.db");
const app = createApp({ store, env });
if (env.JEVTAIL_TAIL) tailFiles(env.JEVTAIL_TAIL, app.ingest);
if (env.JEVTAIL_DOCKER) tailDocker(env.JEVTAIL_DOCKER, app.ingest);
if (env.SUPABASE_ACCESS_TOKEN && env.SUPABASE_PROJECTS) pollSupabase(env.SUPABASE_ACCESS_TOKEN, env.SUPABASE_PROJECTS, app.ingest, Number(env.SUPABASE_POLL_SEC ?? 60) * 1000);
const port = Number(process.env.PORT ?? 8787);
console.log(`jevtail listening on :${port}  (POST /in/sentry|vercel|supabase|generic)`);
export default { port, fetch: app.fetch };
