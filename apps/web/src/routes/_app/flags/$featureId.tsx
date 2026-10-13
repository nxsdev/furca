import type { Environment } from "@kuji/core/environments/Environment";
import type { Experiment } from "@kuji/core/experiments/Experiment";
import { type Feature, validateFeatureValue } from "@kuji/core/features/Feature";
import { AlertDialog, Button, Dropdown, Input, Label, Skeleton, Tabs, TextField, toast } from "@heroui/react";
import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, CornerDownRight, Ellipsis, Flag, Info, Pencil, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FlagSwitch } from "~/components/flags/FlagSwitch";
import { HistoryPanel } from "~/components/flags/HistoryPanel";
import { ImplementationPanel } from "~/components/flags/ImplementationPanel";
import { AddRuleButton, newRule, type Rule, RulesList, ruleIssue } from "~/components/flags/RulesEditor";
import { Segmented } from "~/components/flags/Segmented";
import { TestUserPanel, useTestUser } from "~/components/flags/TestUserPanel";
import { cacheFeature, useSetEnabled } from "~/components/flags/useSetEnabled";
import { ValueInput, ValuePreview } from "~/components/flags/ValueInput";
import { environmentHue } from "~/components/shell/Sidebar";
import { TagInput } from "~/components/targeting/ConditionBuilder";
import { CopyButton, EmptyState, ListSkeleton, Panel, PanelHeader, QueryError } from "~/components/ui/primitives";
import { useEnvironment } from "~/lib/environment";
import { client, errorMessage, orpc } from "~/lib/rpc";

type Tab = "targeting" | "implementation" | "history";

export const Route = createFileRoute("/_app/flags/$featureId")({
  validateSearch: (search: Record<string, unknown>): { tab?: Exclude<Tab, "targeting"> } =>
    search.tab === "implementation" || search.tab === "history" ? { tab: search.tab } : {},
  head: () => ({ meta: [{ title: "Flag · kuji" }] }),
  component: FlagPage,
});

const noRules: ReadonlyArray<Rule> = [];
const savedRulesOf = (feature: Feature | undefined, envId: string | undefined): ReadonlyArray<Rule> =>
  feature?.environments.find((e) => e.environmentId === envId)?.rules ?? noRules;

function FlagPage() {
  const { featureId } = Route.useParams();
  const feature = useQuery(orpc.features.get.queryOptions({ input: { id: featureId } }));

  if (feature.error !== null) {
    if (feature.error instanceof ORPCError && feature.error.code === "NOT_FOUND") {
      return (
        <div className="pt-8">
          <EmptyState
            icon={<Flag />}
            title="Flag not found"
            description="It may have been deleted. Flags are listed on the Flags page."
            action={
              <Link to="/flags" className="button button--sm button--outline">
                Back to flags
              </Link>
            }
          />
        </div>
      );
    }
    return <QueryError message={`Could not load this flag. ${errorMessage(feature.error)}`} onRetry={() => feature.refetch()} />;
  }
  if (feature.isPending) return <FlagSkeleton />;
  return <FlagDetail feature={feature.data} />;
}

function FlagSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading flag">
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
  const { tab = "targeting" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const { environments, current } = useEnvironment();
  const experiments = useQuery({ ...orpc.experiments.list.queryOptions({ input: { includeArchived: true } }), retry: false });
  const experimentsById = useMemo(() => new Map((experiments.data ?? []).map((x) => [x.id, x])), [experiments.data]);
  const linkedExperiments = (experiments.data ?? []).filter((x) => x.featureId === feature.id);

  // Rules: local drafts per environment until "Save"
  const [envId, setEnvId] = useState<string | undefined>(undefined);
  const ruleEnv = environments.find((e) => e.id === (envId ?? current?.id)) ?? environments[0];
  const [drafts, setDrafts] = useState<Readonly<Record<string, ReadonlyArray<Rule>>>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const dirtyIds = Object.keys(drafts).filter((id) => JSON.stringify(drafts[id]) !== JSON.stringify(savedRulesOf(feature, id)));
  const dirty = dirtyIds.length > 0;
  const rules = (ruleEnv && drafts[ruleEnv.id]) ?? savedRulesOf(feature, ruleEnv?.id);
  const invalidCount = dirtyIds.flatMap((id) => drafts[id] ?? []).filter((r) => ruleIssue(r, feature.valueType) !== null).length;

  const testUser = useTestUser({
    feature,
    environment: ruleEnv,
    savedRules: savedRulesOf(feature, ruleEnv?.id),
    experimentsById,
  });
  const matchedRuleId = testUser.result?.matchedRuleId ?? null;
  const defaultMatched = testUser.result?.evaluation.source === "default";

  const save = useMutation({
    mutationFn: async () => {
      for (const environmentId of dirtyIds) {
        const saved = await client.features.saveRules({ id: feature.id, environmentId, rules: drafts[environmentId] ?? [] });
        cacheFeature(queryClient, saved);
        setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== environmentId)));
      }
    },
    onSuccess: () => {
      setEditingId(null);
      toast.success("Rules saved", { description: "SDKs pick them up on their next payload fetch." });
    },
    onError: (error) => toast.danger("Could not save rules", { description: errorMessage(error), timeout: 0 }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.environments.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
    },
  });

  // ⌘S / Ctrl+S saves rule changes
  useEffect(() => {
    if (!dirty) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (invalidCount === 0 && !save.isPending) save.mutate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, invalidCount, save]);

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
          <Tabs.List aria-label="Flag sections" className="min-w-0 gap-1">
            <Tabs.Tab id="targeting" className="w-auto px-2.5 text-label">
              Targeting
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="implementation" className="w-auto px-2.5 text-label">
              Implementation
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="history" className="w-auto px-2.5 text-label">
              History
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="targeting" className="p-0">
          {ruleEnv === undefined ? (
            <Panel>
              <ListSkeleton rows={3} />
            </Panel>
          ) : (
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="flex min-w-0 flex-col gap-6">
                <EnvironmentsPanel feature={feature} environments={environments} />
                <Panel>
                  <PanelHeader
                    title="Rules"
                    description="Evaluated top to bottom. The first rule that matches serves its value."
                    actions={
                      environments.length > 1 && (
                        <Segmented
                          className="shrink-0"
                          aria-label="Environment for rules"
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
                                {dirtyIds.includes(e.id) && <span className="size-1.5 rounded-full bg-focus" aria-label="unsaved" />}
                              </span>
                            ),
                          }))}
                        />
                      )
                    }
                  />
                  <EnvironmentOffNote feature={feature} environment={ruleEnv} rules={rules} experimentsById={experimentsById} />
                  <RulesList
                    rules={rules}
                    onChange={(next) => setDrafts({ ...drafts, [ruleEnv.id]: next })}
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
                        setDrafts({ ...drafts, [ruleEnv.id]: [...rules, rule] });
                        setEditingId(rule.id);
                      }}
                    />
                    <span className="hidden text-meta text-muted sm:inline">
                      Experiment rules are added from the experiment.
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
            aria-label="Unsaved changes"
            className="pointer-events-auto flex w-full max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-overlay py-2 pr-2 pl-4 shadow-overlay"
          >
            <span className="size-2 shrink-0 rounded-full bg-focus" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-label">
              Unsaved changes to {environments.filter((e) => dirtyIds.includes(e.id)).map((e) => e.name).join(" and ")} rules
              {invalidCount > 0 && (
                <span className="text-danger">
                  {" "}
                  · fix {invalidCount} {invalidCount === 1 ? "rule" : "rules"} first
                </span>
              )}
              {save.error !== null && <span className="block text-meta text-danger">{errorMessage(save.error)}</span>}
            </p>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="tertiary"
                isDisabled={save.isPending}
                onPress={() => {
                  setDrafts({});
                  setEditingId(null);
                  save.reset();
                }}
              >
                Discard
              </Button>
              <Button size="sm" isPending={save.isPending} isDisabled={invalidCount > 0} onPress={() => save.mutate()}>
                Save
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
              <AlertDialog.Heading>Discard unsaved rule changes?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-body text-muted">Your edits to the rules haven't been saved. Leaving this page discards them.</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button size="sm" variant="tertiary" onPress={() => blocker.reset?.()}>
                Keep editing
              </Button>
              <Button size="sm" variant="danger" onPress={() => blocker.proceed?.()}>
                Discard and leave
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  );
}

function FlagHeader({ feature, linkedExperiments }: { feature: Feature; linkedExperiments: ReadonlyArray<Experiment> }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(feature.description);
  const [tags, setTags] = useState<string[]>([...feature.tags]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const update = useMutation({
    mutationFn: () => client.features.update({ id: feature.id, description: description.trim(), defaultValue: feature.defaultValue, tags }),
    onSuccess: (saved) => {
      cacheFeature(queryClient, saved);
      setEditing(false);
    },
    onError: (error) => toast.danger("Could not save details", { description: errorMessage(error) }),
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => client.features.archive({ id: feature.id, archived }),
    onSuccess: (saved) => {
      cacheFeature(queryClient, saved);
      void queryClient.invalidateQueries({ queryKey: orpc.features.list.key() });
      toast(saved.archived ? `Archived ${saved.key}` : `Restored ${saved.key}`, {
        description: saved.archived ? "Hidden from the flags list. Its environment switches and rules still apply." : undefined,
      });
    },
    onError: (error) => toast.danger("Could not update the flag", { description: errorMessage(error) }),
  });
  const remove = useMutation({
    mutationFn: () => client.features.delete({ id: feature.id }),
    onSuccess: async () => {
      setConfirmDelete(false);
      queryClient.removeQueries({ queryKey: orpc.features.get.queryKey({ input: { id: feature.id } }) });
      await queryClient.invalidateQueries({ queryKey: orpc.features.list.key() });
      toast(`Deleted ${feature.key}`);
      await navigate({ to: "/flags" });
    },
  });

  const startEditing = () => {
    setDescription(feature.description);
    setTags([...feature.tags]);
    setEditing(true);
  };

  return (
    <header className="pb-5">
      <nav aria-label="Breadcrumb" className="mb-2 text-label">
        <Link to="/flags" className="rounded-sm text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus">
          Flags
        </Link>
        <span className="mx-1.5 text-muted" aria-hidden="true">
          /
        </span>
      </nav>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="min-w-0 truncate font-mono text-title font-semibold tracking-tight">{feature.key}</h1>
            <CopyButton value={feature.key} label="Copy key" />
            <span className="rounded-[4px] border border-border px-1.5 font-mono text-meta leading-[18px] text-muted">{feature.valueType}</span>
            {feature.archived && <span className="rounded-[4px] bg-default px-1.5 text-meta leading-[18px] text-muted">Archived</span>}
          </div>
          {editing ? (
            <form
              className="mt-3 flex max-w-xl flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                update.mutate();
              }}
            >
              <TextField value={description} onChange={setDescription} autoFocus>
                <Label>Description</Label>
                <Input className="text-base sm:text-label" placeholder="What does this flag control?" />
              </TextField>
              <div className="flex flex-col gap-1.5">
                <Label>Tags</Label>
                <TagInput aria-label="Tags" values={tags} onChange={setTags} placeholder="checkout, growth" />
              </div>
              <div className="flex gap-2">
                <Button size="sm" type="submit" isPending={update.isPending}>
                  Save
                </Button>
                <Button size="sm" variant="tertiary" onPress={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="group mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <p className={`max-w-[70ch] text-body ${feature.description === "" ? "text-muted" : "text-muted"}`}>
                {feature.description === "" ? "No description" : feature.description}
              </p>
              {feature.tags.map((t) => (
                <span key={t} className="rounded-[4px] bg-default px-1.5 text-meta leading-[18px]">
                  {t}
                </span>
              ))}
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="Edit description and tags"
                className="size-7 min-w-7 text-muted hover:text-foreground"
                onPress={startEditing}
              >
                <Pencil className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
        <Dropdown>
          <Button isIconOnly size="sm" variant="outline" aria-label="Flag actions" className="shrink-0">
            <Ellipsis className="size-4" />
          </Button>
          <Dropdown.Popover placement="bottom end" className="min-w-56">
            <Dropdown.Menu
              aria-label="Flag actions"
              disabledKeys={linkedExperiments.length > 0 ? ["delete"] : []}
              onAction={(key) => {
                if (key === "archive") archive.mutate(!feature.archived);
                else if (key === "delete") setConfirmDelete(true);
              }}
            >
              <Dropdown.Item id="archive" textValue={feature.archived ? "Restore" : "Archive"}>
                {feature.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                <Label>{feature.archived ? "Restore" : "Archive"}</Label>
              </Dropdown.Item>
              <Dropdown.Item id="delete" textValue="Delete flag" variant="danger">
                <Trash2 className="size-4" />
                <div className="flex flex-col">
                  <Label>Delete flag</Label>
                  {linkedExperiments.length > 0 && (
                    <span className="text-meta text-muted">
                      Used by {linkedExperiments.length} {linkedExperiments.length === 1 ? "experiment" : "experiments"}
                    </span>
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
              <AlertDialog.Heading>Delete {feature.key}?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-body text-muted">
                It disappears from every environment's payload right away, so SDKs return the fallback in your code. This can't be
                undone.
              </p>
              {remove.error !== null && <p className="mt-3 text-label text-danger">{errorMessage(remove.error)}</p>}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button size="sm" variant="tertiary" onPress={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="danger" isPending={remove.isPending} onPress={() => remove.mutate()}>
                Delete flag
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </header>
  );
}

function EnvironmentsPanel({ feature, environments }: { feature: Feature; environments: ReadonlyArray<Environment> }) {
  const setEnabled = useSetEnabled();
  return (
    <Panel>
      <PanelHeader
        title="Environments"
        description="When a flag is off, it's left out of that environment's payload and SDKs return the fallback you pass in code."
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
                  {count === 0 ? "No rules" : `${count} ${count === 1 ? "rule" : "rules"}`}
                </div>
              </div>
              <span className={`text-label ${enabled ? "font-medium" : "text-muted"}`}>{enabled ? "On" : "Off"}</span>
              <FlagSwitch
                size="md"
                aria-label={`${feature.key} in ${env.name}`}
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
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(feature.defaultValue);
  const error = validateFeatureValue(feature.valueType, value);
  const update = useMutation({
    mutationFn: () => client.features.update({ id: feature.id, description: feature.description, defaultValue: value, tags: feature.tags }),
    onSuccess: (saved) => {
      cacheFeature(queryClient, saved);
      void queryClient.invalidateQueries({ queryKey: orpc.environments.key() });
      setEditing(false);
      toast.success("Default value saved");
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
            <span className="rounded-[4px] border border-border px-1.5 text-meta leading-[18px] font-medium">Default</span>
            <span className="text-label">Everyone else</span>
            <span className="hidden text-meta text-muted sm:inline">· same in every environment</span>
            {isMatched && <span className="text-meta font-medium text-focus">Matches test user</span>}
          </div>
          <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-meta text-muted">
            <span>serve</span>
            <ValuePreview valueType={feature.valueType} value={feature.defaultValue} className="min-w-0" />
          </div>
        </div>
        <Button
          isIconOnly
          size="sm"
          variant={editing ? "tertiary" : "ghost"}
          aria-label={editing ? "Close default value" : "Edit default value"}
          aria-expanded={editing}
          className="size-8 min-w-8 text-muted hover:text-foreground"
          onPress={() => {
            setValue(feature.defaultValue);
            setEditing(!editing);
          }}
        >
          <Pencil className="size-3.5" />
        </Button>
      </div>
      {editing && (
        <form
          className="flex flex-col gap-3 border-t border-border bg-surface-secondary/60 px-4 py-4 sm:px-5 sm:pl-13"
          onSubmit={(e) => {
            e.preventDefault();
            if (error === null) update.mutate();
          }}
        >
          <ValueInput valueType={feature.valueType} value={value} onChange={setValue} label="Default value" />
          {update.error !== null && <p className="text-meta text-danger">{errorMessage(update.error)}</p>}
          <div className="flex items-center justify-between gap-3">
            <p className="text-meta text-muted">Saved on its own, for every environment.</p>
            <div className="flex gap-2">
              <Button size="sm" variant="tertiary" onPress={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" type="submit" isPending={update.isPending} isDisabled={error !== null || value === feature.defaultValue}>
                Save default
              </Button>
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
          ? `${feature.key} is off in ${environment.name}, so ${running.name} gets no traffic. Turn the flag on to run it.`
          : `${feature.key} is off in ${environment.name}. These rules take effect when you turn it on.`}
      </span>
    </p>
  );
}
