import { Label, ListBox, Select, Tabs } from "@heroui/react";
import { Trans, useTranslation } from "react-i18next";
import { CopyButton, Panel, PanelHeader } from "~/components/ui/primitives";
import { useEnvironment } from "~/lib/environment";

export type SdkTarget = "browser" | "workers" | "node";

interface Conn {
  readonly apiHost: string;
  readonly sdkKey: string;
}

/** The origin SDKs talk to: this furca deployment */
export const apiHost = () => (typeof window === "undefined" ? "https://furca.example.com" : window.location.origin);

export const INSTALL = "npm install @furca/sdk";

/**
 * Copyable SDK setup per runtime. GA4 params match the GA4 exposure SQL template on the data
 * source page (experiment_key / variation_key), so warehouse analysis works without edits
 */
const sdkSnippet = (target: SdkTarget, { apiHost, sdkKey }: Conn): string => {
  if (target === "browser")
    return `import { createClient } from "@furca/sdk";

const furca = createClient({
  apiHost: "${apiHost}",
  sdkKey: "${sdkKey}",
  attributes: { id: user.id },
  // Optional: mirror exposures to GA4 for BigQuery analysis
  onExposure: (e) =>
    gtag("event", "experiment_viewed", {
      experiment_key: e.experimentKey,
      variation_key: e.variationKey,
    }),
});

await furca.ready(); // never rejects; flags fall back to your defaults

if (furca.isOn("new-checkout")) showNewCheckout();

furca.track("purchase", 4980); // value is optional; "sum" metrics add it up`;

  if (target === "workers")
    return `import { createClient, fetchPayload, type SdkPayload } from "@furca/sdk";

const FURCA = { apiHost: "${apiHost}", sdkKey: "${sdkKey}" };
let cache: { payload: SdkPayload; at: number } | undefined;

export default {
  async fetch(request, env, ctx) {
    // One payload per isolate, refreshed every 30s; flags evaluate locally
    if (!cache || Date.now() - cache.at > 30_000) {
      try {
        cache = { payload: await fetchPayload(FURCA), at: Date.now() };
      } catch (e) {
        console.warn("furca payload refresh failed, keeping last copy", e);
      }
    }

    const furca = createClient({
      ...FURCA,
      payload: cache?.payload,
      attributes: { id: request.headers.get("x-user-id"), country: request.cf?.country },
    });

    const body = furca.isOn("new-pricing") ? renderNewPricing() : renderPricing();
    furca.track("pricing_viewed");

    ctx.waitUntil(furca.flush()); // send exposures and events after responding
    return new Response(body);
  },
} satisfies ExportedHandler<Env>;`;

  return `import { createClient, fetchPayload, type SdkPayload } from "@furca/sdk";

const FURCA = { apiHost: "${apiHost}", sdkKey: "${sdkKey}" };

// One payload per process, refreshed every 30s; flags evaluate locally
let payload: SdkPayload | undefined;
const refresh = () =>
  fetchPayload(FURCA).then(
    (p) => (payload = p),
    (e) => console.warn("furca payload refresh failed, keeping last copy", e),
  );
await refresh();
setInterval(refresh, 30_000);

app.get("/checkout", async (req, res) => {
  const furca = createClient({ ...FURCA, payload, attributes: { id: req.user.id } });

  res.render("checkout", { layout: furca.getValue("checkout-layout", "classic") });

  furca.track("checkout_viewed");
  await furca.flush();
});`;
};

export function CodeBlock({ code, label, className = "max-h-[440px]" }: { code: string; label?: string; className?: string }) {
  const { t } = useTranslation("environments");
  return (
    <div className="group relative min-w-0">
      <pre className={`${className} overflow-auto rounded-md border border-border bg-background py-3 pr-12 pl-4 font-mono text-[12.5px] leading-5`}>
        <code>{code}</code>
      </pre>
      <div className="absolute top-1.5 right-1.5 rounded-md bg-background">
        <CopyButton value={code} label={label ?? t("codeBlock.copy")} />
      </div>
    </div>
  );
}

/** Runtime brand names stay as-is; only "Browser" is translated */
const targets: ReadonlyArray<{ id: SdkTarget; label: string | null }> = [
  { id: "browser", label: null },
  { id: "workers", label: "Cloudflare Workers" },
  { id: "node", label: "Node" },
];

/** SDK setup for the selected environment, with its real SDK key filled in */
export function Quickstart() {
  const { t } = useTranslation("environments");
  const { environments, current, select } = useEnvironment();
  if (current === null) return null;
  const conn = { apiHost: apiHost(), sdkKey: current.sdkKey };
  return (
    <Panel>
      <PanelHeader
        title={t("quickstart.title")}
        description={t("quickstart.description")}
        actions={
          <Select
            aria-label={t("quickstart.environmentLabel")}
            value={current.id}
            onChange={(id) => typeof id === "string" && select(id)}
            className="w-44 shrink-0"
          >
            <Label className="sr-only">{t("quickstart.environment")}</Label>
            <Select.Trigger className="h-8">
              <Select.Value className="text-label" />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {environments.map((e) => (
                  <ListBox.Item key={e.id} id={e.id} textValue={e.name}>
                    {e.name}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        }
      />
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-col gap-1.5">
          <h3 className="text-label font-medium">{t("quickstart.install")}</h3>
          <CodeBlock code={INSTALL} label={t("quickstart.copyInstall")} />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-label font-medium">{t("quickstart.connect", { name: current.name })}</h3>
          <Tabs variant="secondary" defaultSelectedKey="browser" className="min-w-0 gap-0">
            <Tabs.ListContainer>
              <Tabs.List aria-label={t("quickstart.runtime")} className="w-max min-w-0">
                {targets.map((target) => (
                  <Tabs.Tab key={target.id} id={target.id} className="w-auto px-3 text-label">
                    {target.label ?? t("quickstart.browser")}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
            {targets.map((target) => (
              <Tabs.Panel key={target.id} id={target.id} className="mt-3 p-0">
                <CodeBlock code={sdkSnippet(target.id, conn)} />
              </Tabs.Panel>
            ))}
          </Tabs>
        </div>
        <p className="text-label text-muted">
          <Trans t={t} i18nKey="quickstart.footer" components={{ code: <code className="font-mono text-foreground" /> }} />
        </p>
      </div>
    </Panel>
  );
}
