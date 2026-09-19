// Cloudflare Workers entry point. D1 binding `DB`, secrets via `wrangler secret put`.
import { d1 } from "@jevtail/core";
import { createApp, type Env } from "./app";

type Bindings = Env & { DB: any };
let app: ReturnType<typeof createApp> | undefined;

export default {
  fetch(req: Request, env: Bindings, ctx: unknown) {
    app ??= createApp({ store: d1(env.DB), env });
    return app.fetch(req, env, ctx as any);
  },
};
