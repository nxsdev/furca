import { handleApiRequest, runScheduled, type KujiEnv } from "@kuji/api/Runtime/WorkerEntry";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

const startFetch = createStartHandler(defaultStreamHandler);

/** Worker entry: /api/* is the Effect API, everything else is the TanStack Start app */
export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) return handleApiRequest(request, env, ctx);
    return startFetch(request);
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(controller, env));
  },
} satisfies ExportedHandler<KujiEnv>;
