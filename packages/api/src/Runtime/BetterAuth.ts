import { Context } from "effect";
import type { Auth } from "./Auth";

/** Request-scoped Better Auth instance */
export class BetterAuth extends Context.Service<BetterAuth, Auth>()("furca/BetterAuth") {}
