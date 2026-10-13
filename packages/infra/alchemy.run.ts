import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { resolve } from "node:path";

/**
 * furca on your Cloudflare account: one Worker (admin UI + API + SDK endpoints), one D1 database,
 * one KV namespace. `bun run deploy` / CI runs `alchemy deploy`; migrations are applied by Alchemy
 */

const Db = Cloudflare.D1.Database("db", {
  migrations: resolve(import.meta.dirname, "../database/migrations"),
}).pipe(Alchemy.RemovalPolicy.retain(true));

/** SDK payloads, one key per environment */
const Kv = Cloudflare.KV.Namespace("kv").pipe(Alchemy.RemovalPolicy.retain(true));

export const Web = Cloudflare.Website.Vite("web", {
  rootDir: resolve(import.meta.dirname, "../../apps/web"),
  observability: { enabled: true, logs: { enabled: true, invocationLogs: false } },
  // Hourly: refresh results of running experiments
  crons: ["0 * * * *"],
  env: {
    DB: Db,
    KV: Kv,
    BETTER_AUTH_SECRET: Config.Redacted("BETTER_AUTH_SECRET"),
    ENCRYPTION_KEY: Config.Redacted("ENCRYPTION_KEY"),
  },
  dev: { port: Number(process.env.FURCA_DEV_PORT ?? 5173) },
});

export type WebEnv = Cloudflare.InferEnv<typeof Web>;

export default Alchemy.Stack(
  "furca",
  {
    providers: Cloudflare.providers(),
    // Local dev needs no Cloudflare credentials; deploys keep state in your Cloudflare account
    state: process.env.ALCHEMY_LOCAL_STATE === "1" ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const web = yield* Web;
    return { url: web.url.as<string>() };
  }),
);
