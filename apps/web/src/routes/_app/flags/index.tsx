import type { Feature, FeatureValueType } from "@furca/core/features/Feature";
import { Button, Checkbox, ListBox, SearchField, Select } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Flag, FlaskConical, Plus, ShieldCheck } from "lucide-react";
import { type MouseEvent, type ReactNode, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { CodeBlock } from "~/components/flags/CodeBlock";
import { CreateFlagForm, valueTypes } from "~/components/flags/CreateFlagForm";
import { FlagSwitch } from "~/components/flags/FlagSwitch";
import { useSetEnabled } from "~/components/flags/useSetEnabled";
import { environmentHue } from "~/components/shell/Sidebar";
import { CopyButton, EmptyState, ListSkeleton, PageHeader, Panel, QueryError, RelativeTime } from "~/components/ui/primitives";
import { i18n } from "~/i18n";
import { useEnvironment } from "~/lib/environment";
import { usePermissions } from "~/lib/permissions";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/flags/")({
  // ?new=1 (also from the ⌘K palette) opens the inline create form
  validateSearch: (search: Record<string, unknown>): { new?: 1 | "1" } =>
    search.new === "1" || search.new === 1 || search.new === true ? { new: 1 } : {},
  head: () => ({ meta: [{ title: i18n.t("flags:page.listTitle") }] }),
  component: FlagsPage,
});

const SNIPPET = `const furca = createClient({ apiHost, sdkKey });
await furca.ready();
if (furca.isOn("new-checkout")) showNewCheckout();`;

const matches = (f: Feature, q: string) =>
  f.key.includes(q) || f.description.toLowerCase().includes(q) || f.tags.some((t) => t.toLowerCase().includes(q));

function FlagsPage() {
  const { t } = useTranslation("flags");
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [query, setQuery] = useState("");
  const [type, setType] = useState<FeatureValueType | "all">("all");
  const [showArchived, setShowArchived] = useState(false);
  const features = useQuery(orpc.features.list.queryOptions({ input: { includeArchived: showArchived } }));
  const experiments = useQuery({ ...orpc.experiments.list.queryOptions({ input: { includeArchived: false } }), retry: false });
  const { environments, current } = useEnvironment();
  const { canEdit } = usePermissions();
  const creating = canEdit && search.new !== undefined;
  const setCreating = (open: boolean) => void navigate({ search: open ? { new: 1 } : {}, replace: !open });

  const runningByFeature = useMemo(() => {
    const map = new Map<string, Array<{ id: string; name: string }>>();
    for (const x of experiments.data ?? []) {
      if (x.status !== "running") continue;
      map.set(x.featureId, [...(map.get(x.featureId) ?? []), { id: x.id, name: x.name }]);
    }
    return map;
  }, [experiments.data]);

  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      [...(features.data ?? [])]
        .filter((f) => (type === "all" || f.valueType === type) && (q === "" || matches(f, q)))
        .sort((a, b) => a.key.localeCompare(b.key)),
    [features.data, type, q],
  );
  const filtering = q !== "" || type !== "all";
  const isEmpty = features.data !== undefined && features.data.length === 0 && !showArchived;

  return (
    <>
      <PageHeader
        title={t("shared.flags")}
        description={t("list.description")}
        actions={
          canEdit &&
          !creating &&
          !isEmpty && (
            <Button size="sm" onPress={() => setCreating(true)}>
              <Plus className="size-4" />
              {t("shared.createFlag")}
            </Button>
          )
        }
      />
      {creating && <CreateFlagForm onCancel={() => setCreating(false)} />}

      {features.error !== null ? (
        <QueryError message={t("list.loadError", { error: errorMessage(features.error) })} onRetry={() => features.refetch()} />
      ) : isEmpty && !creating ? (
        <EmptyState
          icon={<Flag />}
          title={t("list.emptyTitle")}
          description={t("list.emptyDescription")}
          action={
            <div className="flex w-full max-w-[560px] flex-col items-center gap-4">
              <div className="w-full">
                <CodeBlock title="app.ts" code={SNIPPET} />
              </div>
              {canEdit && (
                <Button size="sm" onPress={() => setCreating(true)}>
                  <Plus className="size-4" />
                  {t("shared.createFlag")}
                </Button>
              )}
            </div>
          }
        />
      ) : isEmpty ? null : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <SearchField aria-label={t("list.search")} value={query} onChange={setQuery} className="w-full sm:w-72">
              <SearchField.Group className="h-8">
                <SearchField.SearchIcon />
                <SearchField.Input placeholder={t("list.searchPlaceholder")} className="text-base sm:text-label" />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
            <Select aria-label={t("shared.type")} value={type} onChange={(k) => typeof k === "string" && setType(k as FeatureValueType | "all")} className="w-36">
              <Select.Trigger className="h-8 min-h-8 py-1 text-label">
                <Select.Value className="text-label" />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {[{ id: "all", label: t("list.allTypes") }, ...valueTypes.map((id) => ({ id, label: t(`valueTypes.${id}`) }))].map((o) => (
                    <ListBox.Item key={o.id} id={o.id} textValue={o.label} className="text-label">
                      {o.label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <Checkbox isSelected={showArchived} onChange={setShowArchived} className="ml-1">
              <Checkbox.Content className="text-label">
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                {t("list.showArchived")}
              </Checkbox.Content>
            </Checkbox>
          </div>
          <Panel className="overflow-hidden">
            {features.isPending ? (
              <ListSkeleton rows={6} />
            ) : (
              <FlagsTable
                rows={rows}
                runningByFeature={runningByFeature}
                currentEnvironmentId={current?.id ?? null}
                environments={environments}
                emptyMessage={
                  filtering ? (
                    <Trans
                      t={t}
                      i18nKey="list.noMatches"
                      components={{
                        clear: (
                          <button
                            type="button"
                            className="rounded-sm text-link underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                            onClick={() => {
                              setQuery("");
                              setType("all");
                            }}
                          />
                        ),
                      }}
                    />
                  ) : (
                    t("list.noFlags")
                  )
                }
              />
            )}
          </Panel>
        </>
      )}
    </>
  );
}

const th = "h-9 px-3 text-left align-middle text-meta font-medium whitespace-nowrap text-muted first:pl-4 last:pr-4";
const td = "px-3 py-2.5 align-middle first:pl-4 last:pr-4";

function FlagsTable({
  rows,
  environments,
  currentEnvironmentId,
  runningByFeature,
  emptyMessage,
}: {
  rows: ReadonlyArray<Feature>;
  environments: ReturnType<typeof useEnvironment>["environments"];
  currentEnvironmentId: string | null;
  runningByFeature: ReadonlyMap<string, ReadonlyArray<{ id: string; name: string }>>;
  emptyMessage: ReactNode;
}) {
  const { t } = useTranslation(["flags", "reviews"]);
  const navigate = useNavigate();
  const setEnabled = useSetEnabled();
  const { canEdit } = usePermissions();
  const current = environments.find((e) => e.id === currentEnvironmentId);
  const openRow = (e: MouseEvent, id: string) => {
    if ((e.target as HTMLElement).closest("a,button,input,label,[role=switch]")) return;
    void navigate({ to: "/flags/$featureId", params: { featureId: id } });
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-label">
        <thead className="border-b border-border bg-surface-secondary/60">
          <tr>
            <th className={th}>{t("list.columns.flag")}</th>
            <th className={`${th} hidden md:table-cell`}>{t("list.columns.type")}</th>
            {environments.map((env) => (
              <th key={env.id} className={`${th} w-px ${env.id === currentEnvironmentId ? "text-foreground" : "hidden sm:table-cell"}`}>
                <span className="inline-flex items-center gap-1.5" title={env.requireApproval ? t("reviews:request.tableHint", { environment: env.name }) : undefined}>
                  <span className={`size-1.5 rounded-full ${environmentHue(env.key)}`} aria-hidden="true" />
                  {env.name}
                  {env.requireApproval && (
                    <>
                      <ShieldCheck className="size-3.5 text-muted" aria-hidden="true" />
                      <span className="sr-only">{t("reviews:request.tableHint", { environment: env.name })}</span>
                    </>
                  )}
                </span>
              </th>
            ))}
            <th className={`${th} hidden text-right sm:table-cell`} title={current ? t("shared.rulesIn", { environment: current.name }) : undefined}>
              <span className="inline-flex items-center gap-1.5">
                {current && <span className={`size-1.5 rounded-full ${environmentHue(current.key)}`} aria-hidden="true" />}
                {t("list.columns.rules")}
                {current && <span className="sr-only">{t("list.columns.rulesInSr", { environment: current.name })}</span>}
              </span>
            </th>
            <th className={`${th} hidden lg:table-cell`}>{t("list.columns.experiment")}</th>
            <th className={`${th} hidden text-right md:table-cell`}>{t("list.columns.updated")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6 + environments.length} className="px-4 py-10 text-center text-body text-muted">
                {emptyMessage}
              </td>
            </tr>
          )}
          {rows.map((f) => {
            const running = runningByFeature.get(f.id) ?? [];
            const rules = f.environments.find((e) => e.environmentId === currentEnvironmentId)?.rules.length ?? 0;
            return (
              <tr
                key={f.id}
                onClick={(e) => openRow(e, f.id)}
                className="group cursor-pointer border-b border-border transition-colors duration-150 last:border-0 hover:bg-surface-secondary/70"
              >
                <td className={`${td} max-w-0 min-w-44 sm:min-w-56`}>
                  <div className="flex min-w-0 items-center gap-1">
                    <Link
                      to="/flags/$featureId"
                      params={{ featureId: f.id }}
                      className={`truncate rounded-sm font-mono text-label font-medium outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                        f.archived ? "text-muted" : "text-foreground"
                      }`}
                    >
                      {f.key}
                    </Link>
                    <span className="shrink-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:hover)]:opacity-0">
                      <CopyButton value={f.key} label={t("shared.copyKey")} />
                    </span>
                    {f.archived && (
                      <span className="shrink-0 rounded-[4px] border border-border px-1.5 text-meta text-muted">{t("shared.archived")}</span>
                    )}
                  </div>
                  {(f.description !== "" || f.tags.length > 0) && (
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-muted">
                      {f.description !== "" && <span className="truncate">{f.description}</span>}
                      {f.tags.map((t) => (
                        <span key={t} className="hidden shrink-0 rounded-[4px] bg-default px-1.5 text-meta xl:inline">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className={`${td} hidden font-mono text-muted md:table-cell`}>{f.valueType}</td>
                {environments.map((env) => {
                  const enabled = f.environments.find((e) => e.environmentId === env.id)?.enabled ?? false;
                  return (
                    <td key={env.id} className={`${td} ${env.id === currentEnvironmentId ? "" : "hidden sm:table-cell"}`}>
                      <FlagSwitch
                        aria-label={t("shared.switchLabel", { key: f.key, environment: env.name })}
                        isSelected={enabled}
                        isDisabled={f.archived || !canEdit || env.requireApproval}
                        onChange={(next) => setEnabled.mutate({ feature: f, environment: env, enabled: next })}
                      />
                    </td>
                  );
                })}
                <td className={`${td} hidden text-right font-mono tabular sm:table-cell ${rules === 0 ? "text-muted" : ""}`}>{rules}</td>
                <td className={`${td} hidden max-w-48 lg:table-cell`}>
                  {running.length > 0 ? (
                    <Link
                      to="/experiments/$experimentId"
                      params={{ experimentId: running[0]!.id }}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-sm text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <FlaskConical className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
                      <span className="truncate">{running[0]!.name}</span>
                      {running.length > 1 && <span className="shrink-0 text-muted">+{running.length - 1}</span>}
                    </Link>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className={`${td} hidden text-right text-muted md:table-cell`}>
                  <RelativeTime date={f.updatedAt} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
