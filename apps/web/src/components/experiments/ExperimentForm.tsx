import { Key } from "@furca/api/contract";
import { Schema } from "effect";
import type { Experiment } from "@furca/core/experiments/Experiment";
import type { Feature } from "@furca/core/features/Feature";
import type { Metric } from "@furca/core/metrics/Metric";
import { Button, ComboBox, Description, FieldError, Input, Label, ListBox } from "@heroui/react";
import { useStore } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Plus, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { setServerError, submitHandler, useAppForm } from "~/components/form/form";
import { type MetricTemplate, suggestedName, templateFields, toInput as metricInput, toValues as metricValues, validate as metricIssues } from "~/components/metrics/metricValues";
import { suggestKey } from "~/components/metrics/slugify";
import { formatList } from "~/components/results/format";
import { HelpTip } from "~/components/ui/HelpTip";
import { Panel } from "~/components/ui/primitives";
import { Segmented } from "~/components/ui/Segmented";
import { useEnvironment } from "~/lib/environment";
import { client, errorMessage, orpc } from "~/lib/rpc";
import { defaultEnvironments, newDraft, toInput, variationsFor } from "./draft";

const code = <code className="font-mono text-foreground" />;
const isKey = Schema.is(Key);

/**
 * Creating asks only what has no sensible default: a name, the flag and the primary metric. The
 * rest (variations from the flag type, even split, everyone, environments the flag is on in, default
 * statistics) is filled in and shown as one sentence each on the draft page
 */
export function CreateExperimentForm({
  initialFeatureId = null,
  onCreated,
  onCancel,
}: {
  initialFeatureId?: string | null;
  onCreated: (experiment: Experiment) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["experiments", "common"]);
  const queryClient = useQueryClient();
  const { environments } = useEnvironment();
  const featuresQuery = useQuery(orpc.features.list.queryOptions({ input: { includeArchived: false } }));
  const metricsQuery = useQuery({ ...orpc.metrics.list.queryOptions({ input: { includeArchived: false } }), refetchOnWindowFocus: true });
  const features = featuresQuery.data ?? [];
  const metrics = metricsQuery.data ?? [];

  const form = useAppForm({
    defaultValues: { name: "", key: "", featureId: initialFeatureId, primaryMetricId: null as string | null },
    onSubmit: async ({ value, formApi }) => {
      const feature = features.find((f) => f.id === value.featureId);
      const draft = newDraft({ name: value.name.trim(), key: value.key, feature, primaryMetricId: value.primaryMetricId, environments });
      let created: Experiment;
      try {
        created = await client.experiments.create({ key: value.key, ...toInput(draft, metrics.find((m) => m.id === value.primaryMetricId)) });
      } catch (error) {
        setServerError(formApi, error);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: orpc.experiments.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.features.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
      onCreated(created);
    },
  });
  const featureId = useStore(form.store, (s) => s.values.featureId);
  const attempted = useStore(form.store, (s) => s.submissionAttempts > 0);
  const feature = features.find((f) => f.id === featureId);

  return (
    <form noValidate onSubmit={submitHandler(form)} className="max-w-2xl">
      <Panel>
        <div className="flex flex-col gap-6 px-5 py-5">
          <div className="flex flex-col gap-2">
            <form.AppField
              name="name"
              validators={{ onChange: ({ value }) => (value.trim() === "" ? t(($) => $.form.hypothesis.nameError) : undefined) }}
              listeners={{
                onChange: ({ value }) => {
                  // The key follows the name until the user edits it; Japanese names get "exp-" + a short hash
                  if (form.getFieldMeta("key")?.isDirty !== true) form.setFieldValue("key", suggestKey(value, "exp"), { dontUpdateMeta: true });
                },
              }}
            >
              {(field) => <field.TextField label={t(($) => $.create.name)} description={t(($) => $.create.nameHelp)} />}
            </form.AppField>
            <form.AppField
              name="key"
              validators={{
                // An empty name already has its own error; the key follows it
                onChange: ({ value, fieldApi }) =>
                  value === "" && fieldApi.form.getFieldValue("name").trim() === "" ? undefined : isKey(value) ? undefined : t(($) => $.form.hypothesis.keyError),
              }}
            >
              {(field) => <field.KeyField label={t(($) => $.form.hypothesis.key)} description={t(($) => $.form.hypothesis.keyHelp)} format={(v) => v.toLowerCase()} />}
            </form.AppField>
          </div>

          <form.AppField name="featureId" validators={{ onChange: ({ value }) => (value === null ? t(($) => $.form.flag.error) : undefined) }}>
            {(field) => (
              <div className="flex flex-col gap-2">
                <FlagPicker
                  value={field.state.value}
                  onChange={field.handleChange}
                  onBlur={field.handleBlur}
                  error={attempted || field.state.meta.isBlurred ? (field.state.meta.errors[0] as string | undefined) : undefined}
                  features={features}
                  isPending={featuresQuery.isPending}
                  loadError={featuresQuery.error === null ? null : errorMessage(featuresQuery.error)}
                />
                {feature !== undefined && <DefaultsPreview feature={feature} />}
              </div>
            )}
          </form.AppField>

          <form.AppField name="primaryMetricId">
            {(field) => (
              <MetricPicker
                label={t(($) => $.form.metrics.primary)}
                description={t(($) => $.create.primaryHelp)}
                help={t(($) => $.draft.help.primary)}
                value={field.state.value}
                onChange={field.handleChange}
                metrics={metrics}
                isPending={metricsQuery.isPending}
              />
            )}
          </form.AppField>
        </div>
        <div className="flex flex-col-reverse gap-3 border-t border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-meta text-muted">{t(($) => $.create.note)}</p>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="ghost" onPress={onCancel}>
              {t(($) => $.actions.cancel, { ns: "common" })}
            </Button>
            <form.AppForm>
              <form.SubmitButton size="sm" label={t(($) => $.create.submit)} />
            </form.AppForm>
          </div>
        </div>
        <form.AppForm>
          <form.FormError className="mx-5 mb-4" />
        </form.AppForm>
      </Panel>
    </form>
  );
}

/** "Serves false to control and true to treatment, evenly, in production and staging": the defaults a flag gives */
function DefaultsPreview({ feature }: { feature: Feature }) {
  const { t } = useTranslation("experiments");
  const { environments } = useEnvironment();
  const [control, treatment] = variationsFor(feature);
  const envs = defaultEnvironments(feature, environments).environmentIds;
  const names = formatList(environments.filter((e) => envs.includes(e.id)).map((e) => e.name));
  return (
    <p className="rounded-md bg-surface-secondary px-3 py-2 text-label text-muted">
      <Trans
        t={t}
        i18nKey={($) => (feature.valueType === "boolean" ? $.create.defaultsBoolean : $.create.defaultsOther)}
        values={{ control: control?.value ?? "", treatment: treatment?.value ?? "", environments: names }}
        components={{ code }}
      />
    </p>
  );
}

/** Flag combobox, searchable by key */
export function FlagPicker({
  value,
  onChange,
  onBlur,
  error,
  features,
  isPending,
  loadError,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  onBlur?: () => void;
  error?: string | undefined;
  features: ReadonlyArray<Feature>;
  isPending: boolean;
  loadError: string | null;
}) {
  const { t } = useTranslation("experiments");
  return (
    <ComboBox
      value={value}
      onChange={(k) => onChange(typeof k === "string" ? k : null)}
      onBlur={onBlur}
      isInvalid={error !== undefined}
      isRequired
      className="sm:max-w-md"
    >
      <Label>{t(($) => $.form.flag.label)}</Label>
      <ComboBox.InputGroup>
        <Input className="font-mono placeholder:font-sans" placeholder={isPending ? t(($) => $.form.flag.loading) : undefined} />
        <ComboBox.Trigger />
      </ComboBox.InputGroup>
      <ComboBox.Popover>
        <ListBox renderEmptyState={() => <p className="px-3 py-4 text-label text-muted">{t(($) => $.form.flag.noMatch)}</p>}>
          {features.map((f) => (
            <ListBox.Item key={f.id} id={f.id} textValue={f.key}>
              <span className="flex-1 truncate font-mono text-label">{f.key}</span>
              <span className="text-meta text-muted">{f.valueType}</span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </ComboBox.Popover>
      {loadError !== null ? (
        <p className="text-meta text-danger">{loadError}</p>
      ) : features.length === 0 && !isPending ? (
        <Description>
          <Trans t={t} i18nKey={($) => $.form.flag.noFlags} components={{ link: <Link to="/flags" search={{ new: "1" }} className="text-link hover:underline" /> }} />
        </Description>
      ) : (
        <Description>{t(($) => $.form.flag.help)}</Description>
      )}
      <FieldError>{error}</FieldError>
    </ComboBox>
  );
}

/** Metrics match by name or key; ComboBox filters on the item text (the name), so keys are looked up by it */
const metricFilter = (metrics: ReadonlyArray<Metric>) => {
  const keys = new Map<string, string>();
  for (const m of metrics) keys.set(m.name, `${keys.get(m.name) ?? ""} ${m.key}`);
  return (text: string, input: string) => {
    const q = input.trim().toLowerCase();
    return q === "" || text.toLowerCase().includes(q) || (keys.get(text) ?? "").toLowerCase().includes(q);
  };
};

function MetricItems({ metrics }: { metrics: ReadonlyArray<Metric> }) {
  const { t } = useTranslation("experiments");
  return (
    <ListBox renderEmptyState={() => <p className="px-3 py-4 text-label text-muted">{t(($) => $.form.metrics.noMatch)}</p>}>
      {metrics.map((m) => (
        <ListBox.Item key={m.id} id={m.id} textValue={m.name} className="gap-3">
          <span className="min-w-0 flex-1 truncate">{m.name}</span>
          <span className="hidden max-w-40 truncate font-mono text-meta text-muted sm:inline">{m.key}</span>
          <span className="shrink-0 text-meta text-muted">{t(($) => $.form.metrics.types[m.type])}</span>
          <ListBox.ItemIndicator />
        </ListBox.Item>
      ))}
    </ListBox>
  );
}

function LabelRow({ children, help, term }: { children: ReactNode; help?: ReactNode; term: string }) {
  return (
    <div className="flex items-center gap-0.5">
      {children}
      {help !== undefined && <HelpTip term={term}>{help}</HelpTip>}
    </div>
  );
}

/** One metric (the primary), searchable by name and key, with inline creation */
export function MetricPicker({
  label,
  description,
  help,
  value,
  onChange,
  metrics,
  isPending,
}: {
  label: string;
  description: ReactNode;
  help?: ReactNode;
  value: string | null;
  onChange: (id: string | null) => void;
  metrics: ReadonlyArray<Metric>;
  isPending: boolean;
}) {
  const { t } = useTranslation("experiments");
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <ComboBox value={value} onChange={(k) => onChange(typeof k === "string" ? k : null)} defaultFilter={metricFilter(metrics)} className="sm:max-w-md">
        <LabelRow help={help} term={label}>
          <Label>{label}</Label>
        </LabelRow>
        <ComboBox.InputGroup>
          <Input placeholder={isPending ? t(($) => $.form.metrics.loading) : undefined} />
          <ComboBox.Trigger />
        </ComboBox.InputGroup>
        <ComboBox.Popover>
          <MetricItems metrics={metrics} />
        </ComboBox.Popover>
        <Description>{metrics.length === 0 && !isPending ? t(($) => $.form.metrics.noMetricsInline) : description}</Description>
      </ComboBox>
      {creating ? (
        <NewMetricInline
          metrics={metrics}
          onCreated={(m) => {
            onChange(m.id);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <NewMetricButton onPress={() => setCreating(true)} />
      )}
    </div>
  );
}

/**
 * Several metrics (secondary, guardrails): the chosen ones as a list with remove buttons, plus a
 * combobox to add one. Only metrics of the primary's data source can be added
 */
export function MetricListPicker({
  label,
  description,
  help,
  value,
  onChange,
  options,
  all,
  canCreate,
}: {
  label: string;
  description: ReactNode;
  help?: ReactNode;
  value: ReadonlyArray<string>;
  onChange: (ids: ReadonlyArray<string>) => void;
  /** Metrics that may be added */
  options: ReadonlyArray<Metric>;
  /** Every metric, to name the chosen ones */
  all: ReadonlyArray<Metric>;
  /** Inline creation makes built-in metrics; off when the experiment reads a warehouse */
  canCreate: boolean;
}) {
  const { t } = useTranslation("experiments");
  const [input, setInput] = useState("");
  const [creating, setCreating] = useState(false);
  const addable = options.filter((m) => !value.includes(m.id));
  return (
    <div className="flex flex-col gap-2">
      <ComboBox
        selectedKey={null}
        inputValue={input}
        onInputChange={setInput}
        onSelectionChange={(k) => {
          if (typeof k === "string") onChange([...value, k]);
          setInput("");
        }}
        defaultFilter={metricFilter(addable)}
        className="sm:max-w-md"
      >
        <LabelRow help={help} term={label}>
          <Label>{label}</Label>
        </LabelRow>
        <ComboBox.InputGroup>
          <Input placeholder={t(($) => $.form.metrics.addPlaceholder)} />
          <ComboBox.Trigger />
        </ComboBox.InputGroup>
        <ComboBox.Popover>
          <MetricItems metrics={addable} />
        </ComboBox.Popover>
        <Description>{description}</Description>
      </ComboBox>
      {value.length > 0 && (
        <ul aria-label={label} className="flex flex-col divide-y divide-border rounded-md border border-border sm:max-w-md">
          {value.map((id) => {
            const m = all.find((x) => x.id === id);
            const name = m?.name ?? t(($) => $.setup.deletedMetric);
            return (
              <li key={id} className="flex items-center gap-3 py-1 pr-1 pl-3 text-label">
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {m !== undefined && <span className="hidden max-w-40 truncate font-mono text-meta text-muted sm:inline">{m.key}</span>}
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  aria-label={t(($) => $.form.metrics.remove, { name })}
                  onPress={() => onChange(value.filter((x) => x !== id))}
                  className="text-muted"
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {!canCreate ? (
        <a href="/metrics?new=1" target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 text-label text-link hover:underline">
          {t(($) => $.form.metrics.newMetric)}
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      ) : creating ? (
        <NewMetricInline
          metrics={all}
          onCreated={(m) => {
            onChange([...value, m.id]);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <NewMetricButton onPress={() => setCreating(true)} />
      )}
    </div>
  );
}

function NewMetricButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation("experiments");
  return (
    <Button size="sm" variant="ghost" onPress={onPress} className="w-fit px-1.5 text-label">
      <Plus className="size-3.5" aria-hidden="true" />
      {t(($) => $.newMetric.open)}
    </Button>
  );
}

const TEMPLATES: ReadonlyArray<Exclude<MetricTemplate, "custom">> = ["conversion", "revenue", "lowerIsBetter"];

/**
 * A built-in event metric made without leaving the experiment: template, event and name (the key
 * follows the name). Filters, windows and capping stay at their defaults; the metric page edits them.
 * Not a <form>: it sits inside the experiment's form
 */
function NewMetricInline({ metrics, onCreated, onCancel }: { metrics: ReadonlyArray<Metric>; onCreated: (m: Metric) => void; onCancel: () => void }) {
  const { t } = useTranslation(["experiments", "common", "metrics"]);
  const queryClient = useQueryClient();
  const { current } = useEnvironment();
  const events = useQuery({ ...orpc.events.names.queryOptions({ input: { environmentId: current?.id ?? "" } }), enabled: current !== null });
  const keys = new Set(metrics.map((m) => m.key));
  const values = (v: { template: Exclude<MetricTemplate, "custom">; name: string; event: string }) => {
    const base = suggestKey(v.name, "metric");
    let key = base;
    for (let i = 2; keys.has(key); i++) key = `${base.slice(0, 60)}-${i}`;
    const fixed = templateFields(v.template);
    const d = metricValues(undefined);
    return {
      ...d,
      template: v.template,
      name: v.name,
      key,
      type: fixed?.type ?? d.type,
      inverse: fixed?.inverse ?? d.inverse,
      num: { ...d.num, event: v.event, aggregation: fixed?.aggregation ?? d.num.aggregation },
    };
  };
  const form = useAppForm({
    defaultValues: { template: "conversion" as Exclude<MetricTemplate, "custom">, name: "", event: "" },
    validators: {
      onChange: ({ value }) => {
        const e = metricIssues(values(value), false, false);
        const fields: Record<string, string> = {};
        if (e.name !== undefined) fields.name = e.name;
        if (e["num.event"] !== undefined) fields.event = e["num.event"];
        return Object.keys(fields).length === 0 ? undefined : { fields };
      },
    },
    onSubmit: async ({ value, formApi }) => {
      const v = values(value);
      try {
        const metric = await client.metrics.create({ key: v.key, ...metricInput(v, false) });
        void queryClient.invalidateQueries({ queryKey: orpc.metrics.key() });
        onCreated(metric);
      } catch (error) {
        setServerError(formApi, error);
      }
    },
  });
  const template = useStore(form.store, (s) => s.values.template);
  // The name follows the event and template until the user types one
  const suggestName = () => {
    const { template: tpl, event } = form.state.values;
    if (form.getFieldMeta("name")?.isDirty !== true)
      form.setFieldValue("name", suggestedName(tpl, event), { dontUpdateMeta: true });
  };
  const attempted = useStore(form.store, (s) => s.submissionAttempts > 0);
  // Enter inside this group creates the metric instead of submitting the experiment form around it
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.defaultPrevented || !(e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    void form.handleSubmit();
  };
  return (
    <div role="group" aria-label={t(($) => $.newMetric.title)} onKeyDown={onKeyDown} className="flex flex-col gap-4 rounded-lg border border-border bg-surface-secondary p-4 sm:max-w-xl">
      <div>
        <p className="text-label font-medium">{t(($) => $.newMetric.title)}</p>
        <p className="text-meta text-muted">{t(($) => $.newMetric.description)}</p>
      </div>
      <form.AppField name="template" listeners={{ onChange: suggestName }}>
        {(field) => (
          <Segmented
            label={t(($) => $.form.templates.label, { ns: "metrics" })}
            value={field.state.value}
            onChange={field.handleChange}
            options={TEMPLATES.map((x) => ({ value: x, label: t(($) => $.form.templates[x].label, { ns: "metrics" }), description: t(($) => $.form.templates[x].description, { ns: "metrics" }) }))}
          />
        )}
      </form.AppField>
      <form.AppField name="event" listeners={{ onChange: suggestName }}>
        {(field) => {
          const error = attempted || field.state.meta.isBlurred ? (field.state.meta.errors[0] as string | undefined) : undefined;
          return (
            <ComboBox
              allowsCustomValue
              menuTrigger="focus"
              inputValue={field.state.value}
              onInputChange={field.handleChange}
              onBlur={field.handleBlur}
              isInvalid={error !== undefined}
              className="sm:max-w-sm"
            >
              <Label>{t(($) => $.newMetric.event)}</Label>
              <ComboBox.InputGroup>
                <Input spellCheck={false} autoComplete="off" className="font-mono" />
                <ComboBox.Trigger />
              </ComboBox.InputGroup>
              <ComboBox.Popover>
                <ListBox renderEmptyState={() => <p className="px-3 py-4 text-label text-muted">{t(($) => $.newMetric.noEvents)}</p>}>
                  {(events.data ?? []).map((n) => (
                    <ListBox.Item key={n.name} id={n.name} textValue={n.name}>
                      <span className="font-mono text-label">{n.name}</span>
                    </ListBox.Item>
                  ))}
                </ListBox>
              </ComboBox.Popover>
              <Description>{t(($) => (template === "lowerIsBetter" ? $.newMetric.eventHelpValue : template === "revenue" ? $.newMetric.eventHelpSum : $.newMetric.eventHelp))}</Description>
              <FieldError>{error}</FieldError>
            </ComboBox>
          );
        }}
      </form.AppField>
      <form.AppField name="name">
        {(field) => <field.TextField label={t(($) => $.newMetric.name)} description={t(($) => $.newMetric.nameHelp)} className="sm:max-w-sm" />}
      </form.AppField>
      <form.AppForm>
        <form.FormError />
      </form.AppForm>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onPress={onCancel}>
          {t(($) => $.actions.cancel, { ns: "common" })}
        </Button>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button size="sm" onPress={() => void form.handleSubmit()} isPending={isSubmitting}>
              {t(($) => $.newMetric.create)}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </div>
  );
}
