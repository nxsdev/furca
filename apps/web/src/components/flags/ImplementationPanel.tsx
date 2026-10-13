import type { Environment } from "@furca/core/environments/Environment";
import type { Feature } from "@furca/core/features/Feature";
import { useState } from "react";
import { Panel, PanelHeader } from "~/components/ui/primitives";
import { CodeBlock } from "./CodeBlock";
import { Segmented } from "./Segmented";

const camel = (key: string) => key.replace(/[-_]+([a-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/^[0-9]/, "_$&");

function usage(feature: Feature, indent: string) {
  if (feature.valueType === "boolean") {
    return `${indent}if (furca.isOn("${feature.key}")) {\n${indent}  // new behavior\n${indent}}`;
  }
  return `${indent}const ${camel(feature.key)} = furca.getValue("${feature.key}", ${feature.defaultValue});`;
}

/** Copy-paste SDK snippets for this flag, using the chosen environment's SDK key */
export function ImplementationPanel({
  feature,
  environments,
  initialEnvironmentId,
}: {
  feature: Feature;
  environments: ReadonlyArray<Environment>;
  initialEnvironmentId: string | undefined;
}) {
  const [envId, setEnvId] = useState(initialEnvironmentId ?? environments[0]?.id ?? "");
  const env = environments.find((e) => e.id === envId) ?? environments[0];
  const apiHost = typeof window === "undefined" ? "https://furca.example.com" : window.location.origin;
  const sdkKey = env?.sdkKey ?? "<sdk-key>";

  const browser = `import { createClient } from "@furca/sdk";

const furca = createClient({
  apiHost: "${apiHost}",
  sdkKey: "${sdkKey}",
  attributes: { id: user.id },
});
await furca.ready();

${usage(feature, "")}`;

  const worker = `import { createClient } from "@furca/sdk";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const furca = createClient({
      apiHost: "${apiHost}",
      sdkKey: "${sdkKey}",
      attributes: { id: getUserId(request) },
    });
    await furca.ready();

${usage(feature, "    ")}

    // Send exposures after the response, without delaying it
    ctx.waitUntil(furca.flush());
    return new Response("ok");
  },
} satisfies ExportedHandler;`;

  return (
    <Panel>
      <PanelHeader
        title="Use this flag in code"
        description={
          <>
            Install with <code className="rounded-[4px] bg-default px-1 font-mono text-meta">npm install @furca/sdk</code>. The SDK
            evaluates locally, so checks don't make a network call.
          </>
        }
        actions={
          environments.length > 1 && (
            <Segmented
              aria-label="Environment"
              value={env?.id ?? ""}
              onChange={setEnvId}
              options={environments.map((e) => ({ id: e.id, label: e.name }))}
            />
          )
        }
      />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <CodeBlock title="Browser" code={browser} />
        <CodeBlock title="Cloudflare Worker" code={worker} />
        <p className="text-meta text-muted">
          The SDK key is public: it can only read this environment's payload and send events.
        </p>
      </div>
    </Panel>
  );
}
