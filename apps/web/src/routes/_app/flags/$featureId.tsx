import type { Environment } from "@furca/core/environments/Environment";
import type { Experiment } from "@furca/core/experiments/Experiment";
import type { Feature } from "@furca/core/features/Feature";
import { AlertDialog, Button, Dropdown, Input, Label, Skeleton, Tabs, TextField, toast } from "@heroui/react";
import { ORPCError } from "@orpc/client";
import { useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, CornerDownRight, Ellipsis, Flag, Info, Pencil, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { FlagSwitch } from "~/components/flags/FlagSwitch";
import { HistoryPanel } from "~/components/flags/HistoryPanel";
import { ImplementationPanel } from "~/components/flags/ImplementationPanel";
import { AddRuleButton, newRule, type Rule, type RulesDraft, RulesList, ruleIssue } from "~/components/flags/RulesEditor";
import { Segmented } from "~/components/flags/Segmented";
import { TestUserPanel, useTestUser } from "~/components/flags/TestUserPanel";
import { cacheFeature, useSetEnabled } from "~/components/flags/useSetEnabled";
import { ValueInput, ValuePreview, valueIssue } from "~/components/flags/ValueInput";
import { errorText, setServerError, submitHandler, useAppForm } from "~/components/form/form";
import { environmentHue } from "~/components/shell/Sidebar";
import { TagInput } from "~/components/targeting/ConditionBuilder";
import { CopyButton, EmptyState, ListSkeleton, Panel, PanelHeader, QueryError } from "~/components/ui/primitives";
import { i18n, intlLocale } from "~/i18n";
import { useEnvironment } from "~/lib/environment";
import { client, errorMessage, orpc } from "~/lib/rpc";

type Tab = "targeting" | "implementation" | "history";

export const Route = createFileRoute("/_app/flags/$featureId")({
  validateSearch: (search: Record<string, unknown>): { tab?: Exclude<Tab, "targeting"> } =>
    search.tab === "implementation" || search.tab === "history" ? { tab: search.tab } : {},
  head: () => ({ meta: [{ title: i18n.t("flags:page.detailTitle") }] }),
  component: FlagPage,
});

const noRules: ReadonlyArray<Rule> = [];
const savedRulesOf = (feature: Feature | undefined, envId: string | undefined): ReadonlyArray<Rule> =>
  feature?.environments.find((e) => e.environmentId === envId)?.rules ?? noRules;
const sameRules = (a: ReadonlyArray<Rule>, b: ReadonlyArray<Rule>) => JSON.stringify(a) === JSON.stringify(b);
const draftOf = (feature: Feature, environments: ReadonlyArray<Environment>): RulesDraft => ({
  envs: environments.map((e) => ({ environmentId: e.id, rules: [...savedRulesOf(feature, e.id)] })),
});

function FlagPage() {
  const { t } = useTranslation("flags");
  const { featureId } = Route.useParams();
  const feature = useQuery(orpc.features.get.queryOptions({ input: { id: featureId } }));

  if (feature.error !== null) {
    if (feature.error instanceof ORPCError && feature.error.code === "NOT_FOUND") {
      return (
        <div className="pt-8">
          <EmptyState
            icon={<Flag />}
            title={t("detail.notFoundTitle")}
            description={t("detail.notFoundDescription")}
            action={
              <Link to="/flags" className="button button--sm button--outline">
                {t("detail.backToFlags")}
              </Link>
            }
          />
        </div>
      );
    }
    return <QueryError message={t("detail.loadError", { error: errorMessage(feature.error) })} onRetry={() => feature.refetch()} />;
  }
  if (feature.isPending) return <FlagSkeleton />;
  return <FlagDetail feature={feature.data} />;
}

function FlagSkeleton() {
  const { t } = useTranslation("flags");
  return (
    <div aria-busy="true" aria-label={t("detail.loading")}>
      <Skeleton className="mb-4 h-4 w-16 rounded-md" />
      <Skeleton className="h-7 w-64 rounded-md" />
      <Skeleton className="mt-2 mb-8 h-4 w-96 max-w-full rounded-md" />
      <Panel>
        <ListSkeleton rows={4} />
      </Panel>
    </div>
  );
}

function FlagDetail({ feature }: { feature: Feature }) {
  const { t } = useTranslation(["flags", "common"]);
  const { tab = "targeting" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const { environments, current } = useEnvironment();
  const experiments = useQuery({ ...orpc.experiments.list.queryOptions({ input: { includeArchived: true } }), retry: false });
  const experimentsById = useMemo(() => new Map((experiments.data ?? []).map((x) => [x.id, x])), [experiments.data]);
  const linkedExperiments = (experiments.data ?? []).filter((x) => x.featureId === feature.id);

  const [envId, setEnvId] = useState<string | undefined>(undefined);
  const ruleEnv = environments.find((e) => e.id === (envId ?? current?.id)) ?? environments[0];
  const [editingId, setEditingId] = useState<string | null>(null);

  // Rules: every environment's drafts live in one form until "Save"
  const form = useAppForm({
    defaultValues: draftOf(feature, environments),
    onSubmit: async ({ value, formApi }) => {
      try {
        let saved = feature;
        for (const [i, env] of value.envs.entries()) {
          if (sameRules(env.rules, savedRulesOf(saved, env.environmentId))) continue;
          saved = await client.features.saveRules({ id: feature.id, environmentId: env.environmentId, rules: env.rules });
          cacheFeature(queryClient, saved);
          // Saved environments stop counting as unsaved even if a later one fails
          formApi.setFieldValue(`envs[${i}].rules`, [...savedRulesOf(saved, env.environmentId)]);
        }
        formApi.reset(draftOf(saved, environments));
        setEditingId(null);
        toast.success(t("detail.rulesSaved"), { description: t("detail.rulesSavedDescription") });
      } catch (error) {
        setServerError(formApi, error);
        toast.danger(t("detail.saveRulesFailed"), { description: errorMessage(error), timeout: 0 });
      } finally {
        void queryClient.invalidateQueries({ queryKey: orpc.environments.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
      }
    },
  });
  const envs = useStore(form.store, (s) => s.values.envs);
  const saving = useStore(form.store, (s) => s.isSubmitting);
  const saveError = useStore(form.store, (s) => errorText(s.errors));
  const dirtyIds = envs.filter((e) => !sameRules(e.rules, savedRulesOf(feature, e.environmentId))).map((e) => e.environmentId);
  const dirty = dirtyIds.length > 0;
  const envIndex = envs.findIndex((e) => e.environmentId === ruleEnv?.id);
  const rules = envs[envIndex]?.rules ?? savedRulesOf(feature, ruleEnv?.id);
  const invalidCount = envs
    .filter((e) => dirtyIds.includes(e.environmentId))
    .flatMap((e) => e.rules)
    .filter((r) => ruleIssue(r, feature.valueType) !== null).length;
  const discard = () => {
    form.reset(draftOf(feature, environments));
    setEditingId(null);
  };

  // Environments without edits keep following the saved rules (refetch, another tab); new environments join the form
  const prevFeature = useRef(feature);
  useEffect(() => {
    const prev = prevFeature.current;
    prevFeature.current = feature;
    for (const env of environments) {
      const i = form.state.values.envs.findIndex((e) => e.environmentId === env.id);
      const next = [...savedRulesOf(feature, env.id)];
      if (i === -1) form.pushFieldValue("envs", { environmentId: env.id, rules: next });
      else if (sameRules(form.state.values.envs[i]!.rules, savedRulesOf(prev, env.id)) && !sameRules(next, savedRulesOf(prev, env.id)))
        form.setFieldValue(`envs[${i}].rules`, next);
    }
  }, [feature, environments, form]);

  const testUser = useTestUser({
    feature,
    environment: ruleEnv,
    savedRules: savedRulesOf(feature, ruleEnv?.id),
    experimentsById,
  });
  const matchedRuleId = testUser.result?.matchedRuleId ?? null;
  const defaultMatched = testUser.result?.evaluation.source === "default";

  // ⌘S / Ctrl+S saves rule changes
  useEffect(() => {
    if (!dirty) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (invalidCount === 0 && !form.state.isSubmitting) void form.handleSubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, invalidCount, form]);

  const blocker = useBlocker({
    shouldBlockFn: ({ current: from, next }) => dirty && from.pathname !== next.pathname,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });

  const ruleNumber = (id: string | null) => {
    const i = rules.findIndex((r) => r.id === id);
    return i === -1 ? null : i + 1;
  };
  const attributeSuggestions = useMemo(
    () => [
      ...new Set([
        "id",
        "email",
        "country",
        "plan",
        ...feature.environments.flatMap((e) => e.rules.flatMap((r) => (r._tag === "experiment" ? [] : r.conditions.map((c) => c.attribute)))),
        ...testUser.rows.map((r) => r.key).filter(Boolean),
      ]),
    ],
    [feature.environments, testUser.rows],
  );

  return (
    <>
      <FlagHeader feature={feature} linkedExperiments={linkedExperiments} />
      <Tabs
        variant="secondary"
        selectedKey={tab}
        onSelectionChange={(k) => void navigate({ search: k === "targeting" ? {} : { tab: k as Exclude<Tab, "targeting"> }, replace: true })}
      >
        <Tabs.ListContainer className="mb-6">
          <Tabs.List aria-label={t("detail.sections")} className="min-w-0 gap-1">
            <Tabs.Tab id="targeting" className="w-auto px-2.5 text-label">
              {t("detail.tabs.targeting")}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="implementation" className="w-auto px-2.5 text-label">
              {t("detail.tabs.implementation")}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="history" className="w-auto px-2.5 text-label">
              {t("detail.tabs.history")}
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="targeting" className="p-0">
          {ruleEnv === undefined || envIndex === -1 ? (
            <Panel>
              <ListSkeleton rows={3} />
            </Panel>
          ) : (
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="flex min-w-0 flex-col gap-6">
                <EnvironmentsPanel feature={feature} environments={environments} />
                <Panel>
                  <PanelHeader
                    title={t("detail.rulesTitle")}
                    description={t("detail.rulesDescription")}
                    actions={
                      environments.length > 1 && (
                        <Segmented
                          className="shrink-0"
                          aria-label={t("detail.rulesEnvironment")}
                          value={ruleEnv.id}
                          onChange={(id) => {
                            setEnvId(id);
                            setEditingId(null);
                          }}
                          options={environments.map((e) => ({
                            id: e.id,
                            textValue: e.name,
                            label: (
                              <span className="inline-flex items-center gap-1.5">
                                {e.name}
                                {dirtyIds.includes(e.id) && <span className="size-1.5 rounded-full bg-focus" aria-label={t("detail.unsaved")} />}
                              </span>
                            ),
                          }))}
                        />
                      )
                    }
                  />
                  <EnvironmentOffNote feature={feature} environment={ruleEnv} rules={rules} experimentsById={experimentsById} />
                  <RulesList
                    key={ruleEnv.id}
                    form={form}
                    envIndex={envIndex}
                    valueType={feature.valueType}
                    environment={ruleEnv}
                    experimentsById={experimentsById}
                    editingId={editingId}
                    onEditingChange={setEditingId}
                    matchedRuleId={matchedRuleId}
                    attributeSuggestions={attributeSuggestions}
                    footer={<DefaultValueRow feature={feature} isMatched={defaultMatched} />}
                  />
                  <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                    <AddRuleButton
                      onAdd={(kind) => {
                        const rule = newRule(kind, feature.valueType, feature.defaultValue);
                        form.pushFieldValue(`envs[${envIndex}].rules`, rule);
                        setEditingId(rule.id);
                      }}
                    />
                    <span className="hidden text-meta text-muted sm:inline">
                      {t("detail.experimentRulesHint")}
                    </span>
                  </div>
                </Panel>
              </div>
              <div className="lg:sticky lg:top-6">
                <TestUserPanel
                  state={testUser}
                  feature={feature}
                  environment={ruleEnv}
                  ruleNumber={ruleNumber}
                  hasUnsavedChanges={dirtyIds.includes(ruleEnv.id)}
                />
              </div>
            </div>
          )}
        </Tabs.Panel>
        <Tabs.Panel id="implementation" className="p-0">
          <ImplementationPanel feature={feature} environments={environments} initialEnvironmentId={ruleEnv?.id} />
        </Tabs.Panel>
        <Tabs.Panel id="history" className="p-0">
          <HistoryPanel featureId={feature.id} />
        </Tabs.Panel>
      </Tabs>

      {dirty && (
        <div className="pointer-events-none sticky bottom-4 z-(--z-sticky) mt-6 flex justify-center">
          <div
            role="region"
            aria-label={t("detail.unsavedRegion")}
            className="pointer-events-auto flex w-full max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-overlay py-2 pr-2 pl-4 shadow-overlay"
          >
            <span className="size-2 shrink-0 rounded-full bg-focus" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-label">
              {t("detail.unsavedChanges", {
                environments: new Intl.ListFormat(intlLocale(), { type: "conjunction" }).format(
                  environments.filter((e) => dirtyIds.includes(e.id)).map((e) => e.name),
                ),
              })}
              {invalidCount > 0 && <span className="text-danger"> · {t("detail.fixFirst", { count: invalidCount })}</span>}
              {saveError !== "" && <span className="block text-meta text-danger">{saveError}</span>}
            </p>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="tertiary" isDisabled={saving} onPress={discard}>
                {t("common:actions.discard")}
              </Button>
              <Button size="sm" isPending={saving} isDisabled={invalidCount > 0} onPress={() => void form.handleSubmit()}>
                {t("common:actions.save")}
              </Button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog.Backdrop isOpen={blocker.status === "blocked"} onOpenChange={(open) => !open && blocker.reset?.()}>
        <AlertDialog.Container size="sm">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="warning" />
              <AlertDialog.Heading>{t("detail.leaveTitle")}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-body text-muted">{t("detail.leaveDescription")}</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button size="sm" variant="tertiary" onPress={() => blocker.reset?.()}>
                {t("detail.keepEditing")}
              </Button>
              <Button size="sm" variant="danger" onPress={() => blocker.proceed?.()}>
                {t("detail.discardAndLeave")}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  );
}

function FlagHeader({ feature, linkedExperiments }: { feature: Feature; linkedExperiments: ReadonlyArray<Experiment> }) {
  const { t } = useTranslation(["flags", "common"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const details = () => ({ description: feature.description, tags: [...feature.tags] });
  const form = useAppForm({
    defaultValues: details(),
    onSubmit: async ({ value }) => {
      try {
        const saved = await client.features.update({
          id: feature.id,
          description: value.description.trim(),
          defaultValue: feature.defaultValue,
          tags: value.tags,
        });
        cacheFeature(queryClient, saved);
        setEditing(false);
      } catch (error) {
        toast.danger(t("header.saveDetailsFailed"), { description: errorMessage(error) });
      }
    },
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => client.features.archive({ id: feature.id, archived }),
    onSuccess: (saved) => {
      cacheFeature(queryClient, saved);
      void queryClient.invalidateQueries({ queryKey: orpc.features.list.key() });
      toast(saved.archived ? t("header.archivedToast", { key: saved.key }) : t("header.restoredToast", { key: saved.key }), {
        description: saved.archived ? t("header.archivedDescription") : undefined,
      });
    },
    onError: (error) => toast.danger(t("header.updateFailed"), { description: errorMessage(error) }),
  });
  const remove = useMutation({
    mutationFn: () => client.features.delete({ id: feature.id }),
    onSuccess: async () => {
      setConfirmDelete(false);
      queryClient.removeQueries({ queryKey: orpc.features.get.queryKey({ input: { id: feature.id } }) });
      await queryClient.invalidateQueries({ queryKey: orpc.features.list.key() });
      toast(t("header.deletedToast", { key: feature.key }));
      await navigate({ to: "/flags" });
    },
  });

  const startEditing = () => {
    form.reset(details());
    setEditing(true);
  };

  return (
    <header className="pb-5">
      <nav aria-label={t("header.breadcrumb")} className="mb-2 text-label">
        <Link to="/flags" className="rounded-sm text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus">
          {t("shared.flags")}
        </Link>
        <span className="mx-1.5 text-muted" aria-hidden="true">
          /
        </span>
      </nav>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="min-w-0 truncate font-mono text-title font-semibold tracking-tight">{feature.key}</h1>
            <CopyButton value={feature.key} label={t("shared.copyKey")} />
            <span className="rounded-[4px] border border-border px-1.5 font-mono text-meta leading-[18px] text-muted">{feature.valueType}</span>
            {feature.archived && <span className="rounded-[4px] bg-default px-1.5 text-meta leading-[18px] text-muted">{t("shared.archived")}</span>}
          </div>
          {editing ? (
            <form className="mt-3 flex max-w-xl flex-col gap-3" noValidate onSubmit={submitHandler(form)}>
              <form.AppField name="description">
                {(field) => (
                  <TextField value={field.state.value} onChange={field.handleChange} onBlur={field.handleBlur} autoFocus>
                    <Label>{t("shared.description")}</Label>
                    <Input className="text-base sm:text-label" placeholder={t("shared.descriptionPlaceholder")} />
                  </TextField>
                )}
              </form.AppField>
              <form.AppField name="tags">
                {(field) => (
                  <div className="flex flex-col gap-1.5">
                    <Label>{t("shared.tags")}</Label>
                    <TagInput aria-label={t("shared.tags")} values={field.state.value} onChange={field.handleChange} placeholder="checkout, growth" />
                  </div>
                )}
              </form.AppField>
              <div className="flex gap-2">
                <form.AppForm>
                  <form.SubmitButton size="sm" label={t("common:actions.save")} />
                </form.AppForm>
                <Button size="sm" variant="tertiary" onPress={() => setEditing(false)}>
                  {t("common:actions.cancel")}
                </Button>
              </div>
            </form>
          ) : (
            <div className="group mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <p className={`max-w-[70ch] text-body ${feature.description === "" ? "text-muted" : "text-muted"}`}>
                {feature.description === "" ? t("header.noDescription") : feature.description}
              </p>
              {feature.tags.map((tag) => (
                <span key={tag} className="rounded-[4px] bg-default px-1.5 text-meta leading-[18px]">
                  {tag}
                </span>
              ))}
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label={t("header.editDetails")}
                className="size-7 min-w-7 text-muted hover:text-foreground"
                onPress={startEditing}
              >
                <Pencil className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
        <Dropdown>
          <Button isIconOnly size="sm" variant="outline" aria-label={t("header.actions")} className="shrink-0">
            <Ellipsis className="size-4" />
          </Button>
          <Dropdown.Popover placement="bottom end" className="min-w-56">
            <Dropdown.Menu
              aria-label={t("header.actions")}
              disabledKeys={linkedExperiments.length > 0 ? ["delete"] : []}
              onAction={(key) => {
                if (key === "archive") archive.mutate(!feature.archived);
                else if (key === "delete") setConfirmDelete(true);
              }}
            >
              <Dropdown.Item id="archive" textValue={feature.archived ? t("header.restore") : t("common:actions.archive")}>
                {feature.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                <Label>{feature.archived ? t("header.restore") : t("common:actions.archive")}</Label>
              </Dropdown.Item>
              <Dropdown.Item id="delete" textValue={t("header.deleteFlag")} variant="danger">
                <Trash2 className="size-4" />
                <div className="flex flex-col">
                  <Label>{t("header.deleteFlag")}</Label>
                  {linkedExperiments.length > 0 && (
                    <span className="text-meta text-muted">{t("header.usedBy", { count: linkedExperiments.length })}</span>
                  )}
                </div>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>

      <AlertDialog.Backdrop isOpen={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialog.Container size="sm">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>{t("header.deleteTitle", { key: feature.key })}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-body text-muted">{t("header.deleteDescription")}</p>
              {remove.error !== null && <p className="mt-3 text-label text-danger">{errorMessage(remove.error)}</p>}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button size="sm" variant="tertiary" onPress={() => setConfirmDelete(false)}>
                {t("common:actions.cancel")}
              </Button>
              <Button size="sm" variant="danger" isPending={remove.isPending} onPress={() => remove.mutate()}>
                {t("header.deleteFlag")}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </header>
  );
}

function EnvironmentsPanel({ feature, environments }: { feature: Feature; environments: ReadonlyArray<Environment> }) {
  const { t } = useTranslation("flags");
  const setEnabled = useSetEnabled();
  return (
    <Panel>
      <PanelHeader
        title={t("environments.title")}
        description={t("environments.description")}
      />
      <ul>
        {environments.map((env) => {
          const config = feature.environments.find((e) => e.environmentId === env.id);
          const enabled = config?.enabled ?? false;
          const count = config?.rules.length ?? 0;
          return (
            <li key={env.id} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0 sm:px-5">
              <span className={`size-2 shrink-0 rounded-full ${environmentHue(env.key)}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-label font-medium">{env.name}</div>
                <div className="text-meta text-muted">
                  {count === 0 ? t("environments.noRules") : t("environments.ruleCount", { count })}
                </div>
              </div>
              <span className={`text-label ${enabled ? "font-medium" : "text-muted"}`}>{enabled ? t("shared.on") : t("shared.off")}</span>
              <FlagSwitch
                size="md"
                aria-label={t("shared.switchLabel", { key: feature.key, environment: env.name })}
                isSelected={enabled}
                isDisabled={feature.archived}
                onChange={(next) => setEnabled.mutate({ feature, environment: env, enabled: next })}
              />
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** Last row of the rules list: what everyone else gets (shared by all environments) */
function DefaultValueRow({ feature, isMatched }: { feature: Feature; isMatched: boolean }) {
  const { t } = useTranslation(["flags", "common"]);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const form = useAppForm({
    defaultValues: { value: feature.defaultValue },
    onSubmit: async ({ value, formApi }) => {
      try {
        const saved = await client.features.update({
          id: feature.id,
          description: feature.description,
          defaultValue: value.value,
          tags: feature.tags,
        });
        cacheFeature(queryClient, saved);
        void queryClient.invalidateQueries({ queryKey: orpc.environments.key() });
        setEditing(false);
        toast.success(t("defaultRow.saved"));
      } catch (error) {
        setServerError(formApi, error);
      }
    },
  });

  return (
    <li className={`relative border-b border-border ${isMatched ? "bg-focus/[0.06]" : ""}`}>
      {isMatched && <span className="absolute inset-y-0 left-0 w-0.5 bg-focus" aria-hidden="true" />}
      <div className="flex items-start gap-3 px-4 py-3 sm:px-5">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted">
          <CornerDownRight className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="rounded-[4px] border border-border px-1.5 text-meta leading-[18px] font-medium">{t("defaultRow.badge")}</span>
            <span className="text-label">{t("defaultRow.everyoneElse")}</span>
            <span className="hidden text-meta text-muted sm:inline">{t("defaultRow.sameEverywhere")}</span>
            {isMatched && <span className="text-meta font-medium text-focus">{t("shared.matchesTestUser")}</span>}
          </div>
          <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-meta text-muted">
            <Trans
              t={t}
              i18nKey="shared.serve"
              components={{ value: <ValuePreview valueType={feature.valueType} value={feature.defaultValue} className="min-w-0" /> }}
            />
          </div>
        </div>
        <Button
          isIconOnly
          size="sm"
          variant={editing ? "tertiary" : "ghost"}
          aria-label={editing ? t("defaultRow.close") : t("defaultRow.edit")}
          aria-expanded={editing}
          className="size-8 min-w-8 text-muted hover:text-foreground"
          onPress={() => {
            form.reset({ value: feature.defaultValue });
            setEditing(!editing);
          }}
        >
          <Pencil className="size-3.5" />
        </Button>
      </div>
      {editing && (
        <form
          className="flex flex-col gap-3 border-t border-border bg-surface-secondary/60 px-4 py-4 sm:px-5 sm:pl-13"
          noValidate
          onSubmit={submitHandler(form)}
        >
          {/* ValueInput shows its own validation message; the validator only blocks submit */}
          <form.AppField name="value" validators={{ onChange: ({ value }) => valueIssue(feature.valueType, value) ?? undefined }}>
            {(field) => (
              <ValueInput valueType={feature.valueType} value={field.state.value} onChange={field.handleChange} label={t("shared.defaultValue")} />
            )}
          </form.AppField>
          <form.Subscribe selector={(s) => errorText(s.errors)}>
            {(error) => error !== "" && <p className="text-meta text-danger">{error}</p>}
          </form.Subscribe>
          <div className="flex items-center justify-between gap-3">
            <p className="text-meta text-muted">{t("defaultRow.help")}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="tertiary" onPress={() => setEditing(false)}>
                {t("common:actions.cancel")}
              </Button>
              <form.Subscribe selector={(s) => [s.isSubmitting, s.isFieldsValid && s.values.value !== feature.defaultValue] as const}>
                {([isSubmitting, canSave]) => (
                  <Button size="sm" type="submit" isPending={isSubmitting} isDisabled={!canSave}>
                    {t("defaultRow.save")}
                  </Button>
                )}
              </form.Subscribe>
            </div>
          </div>
        </form>
      )}
    </li>
  );
}

/** Rules don't apply while the flag is off in this environment; a running experiment gets no traffic */
function EnvironmentOffNote({
  feature,
  environment,
  rules,
  experimentsById,
}: {
  feature: Feature;
  environment: Environment;
  rules: ReadonlyArray<Rule>;
  experimentsById: ReadonlyMap<string, Experiment>;
}) {
  const { t } = useTranslation("flags");
  if (rules.length === 0 || feature.environments.find((e) => e.environmentId === environment.id)?.enabled === true) return null;
  const running = rules
    .map((r) => (r._tag === "experiment" && r.enabled ? experimentsById.get(r.experimentId) : undefined))
    .find((x) => x?.status === "running");
  return (
    <p className="flex items-start gap-2 border-b border-border bg-surface-secondary/60 px-4 py-2.5 text-label sm:px-5">
      {running ? (
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-health" aria-hidden="true" />
      ) : (
        <Info className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden="true" />
      )}
      <span className={running ? "" : "text-muted"}>
        {running
          ? t("offNote.experimentStarved", { key: feature.key, environment: environment.name, experiment: running.name })
          : t("offNote.rulesInactive", { key: feature.key, environment: environment.name })}
      </span>
    </p>
  );
}
