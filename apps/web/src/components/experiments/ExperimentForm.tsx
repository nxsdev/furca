import { type Experiment, defaultStatsSettings } from "@kuji/core/experiments/Experiment";
import { type Feature, validateFeatureValue } from "@kuji/core/features/Feature";
import { BUILTIN_DATA_SOURCE_ID } from "@kuji/core/datasources/DataSource";
import type { Metric } from "@kuji/core/metrics/Metric";
import { daysToReach, mdeForSampleSize, sampleSizePerVariation } from "@kuji/stats";
import {
  Button,
  Checkbox,
  CheckboxGroup,
  ComboBox,
  Description,
  Disclosure,
  FieldError,
  Input,
  Label,
  ListBox,
  NumberField,
  Select,
  Switch,
  TextArea,
  TextField,
} from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, Circle, ExternalLink, Plus, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ValueInput, defaultValueFor } from "~/components/flags/ValueInput";
import { slugify } from "~/components/metrics/MetricForm";
import { formatCount, formatPercent } from "~/components/results/format";
import { ConditionBuilder, type ConditionValue, conditionIssue, conditionsSummary } from "~/components/targeting/ConditionBuilder";
import { Segmented } from "~/components/ui/Segmented";
import { useEnvironment } from "~/lib/environment";
import { errorMessage, orpc } from "~/lib/rpc";
import { CoverageField, evenPercents, MAX_VARIATIONS, VariationSwatch, weightLabel } from "./parts";

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface VariationDraft {
  readonly key: string;
  readonly name: string;
  readonly value: string;
}

interface Draft {
  name: string;
  key: string;
  keyEdited: boolean;
  hypothesis: string;
  featureId: string | null;
  variations: ReadonlyArray<VariationDraft>;
  evenSplit: boolean;
  /** Percent per variation, used when evenSplit is off */
  percents: ReadonlyArray<number>;
  hashAttribute: string;
  conditions: ReadonlyArray<ConditionValue>;
  coverage: number;
  environmentIds: ReadonlyArray<string>;
  analysisEnvironmentId: string;
  primaryMetricId: string | null;
  secondaryMetricIds: ReadonlyArray<string>;
  guardrailMetricIds: ReadonlyArray<string>;
  stats: ReturnType<typeof defaultStatsSettings>;
  mdePercent: number;
  dailyTraffic: number;
  baselineRate: number;
  baselineMean: number;
  baselineStdDev: number;
}


const variationsFor = (feature: Feature | undefined): Array<VariationDraft> => {
  const base = feature === undefined ? "" : feature.defaultValue;
  const treatment = feature?.valueType === "boolean" ? (base === "true" ? "false" : "true") : base;
  return [
    { key: "control", name: "Control", value: base },
    { key: "treatment", name: "Treatment", value: treatment },
  ];
};

const toDraft = (x: Experiment | undefined, envId: string, featureId: string | null): Draft => {
  const n = x?.variations.length ?? 2;
  const even = x === undefined || x.weights.every((w) => Math.abs(w - 1 / n) < 1e-3);
  return {
    name: x?.name ?? "",
    key: x?.key ?? "",
    keyEdited: x !== undefined,
    hypothesis: x?.hypothesis ?? "",
    featureId: x?.featureId ?? featureId,
    variations: x?.variations.map((v) => ({ key: v.key, name: v.name, value: v.value })) ?? variationsFor(undefined),
    evenSplit: even,
    percents: x === undefined ? evenPercents(2) : x.weights.map((w) => Number((w * 100).toFixed(2))),
    hashAttribute: x?.hashAttribute ?? "id",
    conditions: x?.conditions ?? [],
    coverage: x?.coverage ?? 1,
    environmentIds: x?.environmentIds ?? (envId === "" ? [] : [envId]),
    analysisEnvironmentId: x?.analysisEnvironmentId ?? envId,
    primaryMetricId: x?.primaryMetricId ?? null,
    secondaryMetricIds: x?.secondaryMetricIds ?? [],
    guardrailMetricIds: x?.guardrailMetricIds ?? [],
    stats: x?.stats ?? defaultStatsSettings(),
    mdePercent: x === undefined ? 5 : Number((x.plan.mde * 100).toFixed(2)) || 5,
    dailyTraffic: x?.plan.dailyTraffic ?? Number.NaN,
    baselineRate: Number.NaN,
    baselineMean: Number.NaN,
    baselineStdDev: Number.NaN,
  };
};

/** Power analysis for the planner; null fields when inputs are incomplete */
function planOf(d: Draft, primary: Metric | undefined) {
  const kind = primary === undefined || primary.type === "proportion" ? "proportion" : "mean";
  const baselineMean = kind === "proportion" ? d.baselineRate / 100 : d.baselineMean;
  const power = { kind, baselineMean, baselineStdDev: d.baselineStdDev, alpha: d.stats.alpha } as const;
  const perVariation = sampleSizePerVariation({ ...power, mde: d.mdePercent / 100 });
  const weights = weightsOf(d);
  const minWeight = Math.min(...weights);
  // daysToReach assumes an equal split; 1 / smallest weight gives the arm that fills slowest
  const traffic = { variations: 1 / minWeight, dailyTraffic: d.dailyTraffic, coverage: d.coverage };
  const days = perVariation === null || !(d.dailyTraffic > 0) ? null : daysToReach({ usersPerVariation: perVariation, ...traffic });
  const twoWeekUsers = d.dailyTraffic * d.coverage * minWeight * 14;
  const mdeIn14 = twoWeekUsers > 0 ? mdeForSampleSize({ ...power, usersPerVariation: twoWeekUsers }) : null;
  return { kind, perVariation, total: perVariation === null ? null : perVariation * weights.length, days, mdeIn14 };
}

const weightsOf = (d: Draft) =>
  d.evenSplit ? d.variations.map(() => 1 / d.variations.length) : d.percents.map((p) => (Number.isFinite(p) ? p / 100 : 0));

interface Check {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  /** Blocking checks gate saving; the rest are needed before start */
  readonly blocking: boolean;
  readonly section: string;
}

export function ExperimentForm({
  experiment,
  initialFeatureId = null,
  onSaved,
  onCancel,
}: {
  experiment?: Experiment;
  initialFeatureId?: string | null;
  onSaved: (experiment: Experiment) => void;
  onCancel: () => void;
}) {
  const isEdit = experiment !== undefined;
  const queryClient = useQueryClient();
  const { environments, current } = useEnvironment();
  const [d, setDraft] = useState(() => toDraft(experiment, current?.id ?? "", initialFeatureId));
  const [submitted, setSubmitted] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...patch }));

  const featuresQuery = useQuery(orpc.features.list.queryOptions({ input: { includeArchived: false } }));
  const metricsQuery = useQuery({
    ...orpc.metrics.list.queryOptions({ input: { includeArchived: false } }),
    refetchOnWindowFocus: true,
  });
  const features = featuresQuery.data ?? [];
  const metrics = metricsQuery.data ?? [];
  const feature = features.find((f) => f.id === d.featureId);
  const primary = metrics.find((m) => m.id === d.primaryMetricId);
  const dataSourceId = primary?.dataSourceId ?? BUILTIN_DATA_SOURCE_ID;
  const plan = planOf(d, primary);
  const weights = weightsOf(d);
  const totalPercent = d.evenSplit ? 100 : d.percents.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

  // Draft environments default to the selected one once environments load
  if (d.environmentIds.length === 0 && d.analysisEnvironmentId === "" && current !== null && !isEdit) {
    set({ environmentIds: [current.id], analysisEnvironmentId: current.id });
  }

  const onSuccess = (saved: Experiment) => {
    void queryClient.invalidateQueries({ queryKey: orpc.experiments.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.features.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
    onSaved(saved);
  };
  const create = useMutation(orpc.experiments.create.mutationOptions({ onSuccess }));
  const update = useMutation(orpc.experiments.update.mutationOptions({ onSuccess }));
  const save = isEdit ? update : create;

  const variationKeys = d.variations.map((v) => v.key);
  const offIn = environments.filter(
    (e) => d.environmentIds.includes(e.id) && feature !== undefined && feature.environments.find((c) => c.environmentId === e.id)?.enabled !== true,
  );
  const checks: Array<Check> = [
    { id: "name", label: "Name", ok: d.name.trim() !== "", blocking: true, section: "step-hypothesis" },
    { id: "key", label: "Valid key", ok: isEdit || KEY_PATTERN.test(d.key), blocking: true, section: "step-hypothesis" },
    { id: "flag", label: "Flag selected", ok: feature !== undefined, blocking: true, section: "step-flag" },
    {
      id: "values",
      label: "Variation values valid",
      ok: feature !== undefined && d.variations.every((v) => validateFeatureValue(feature.valueType, v.value) === null),
      blocking: true,
      section: "step-flag",
    },
    {
      id: "keys",
      label: "Unique variation keys",
      ok: variationKeys.every((k) => KEY_PATTERN.test(k)) && new Set(variationKeys).size === variationKeys.length,
      blocking: true,
      section: "step-flag",
    },
    { id: "weights", label: "Weights total 100%", ok: Math.abs(totalPercent - 100) < 0.01 && weights.every((w) => w > 0), blocking: true, section: "step-flag" },
    { id: "targeting", label: "Targeting complete", ok: d.conditions.every((c) => conditionIssue(c) === null), blocking: true, section: "step-traffic" },
    { id: "envs", label: "At least one environment", ok: d.environmentIds.length > 0, blocking: true, section: "step-traffic" },
    { id: "hash", label: "Hash attribute", ok: d.hashAttribute.trim() !== "", blocking: true, section: "step-traffic" },
    { id: "primary", label: "Primary metric (needed to start)", ok: primary !== undefined, blocking: false, section: "step-metrics" },
    { id: "plan", label: "Sample size planned", ok: plan.perVariation !== null, blocking: false, section: "step-plan" },
  ];
  const blocked = checks.some((c) => c.blocking && !c.ok);

  const toInput = () => ({
    name: d.name.trim(),
    hypothesis: d.hypothesis.trim(),
    featureId: d.featureId ?? "",
    environmentIds: [...d.environmentIds],
    analysisEnvironmentId: d.environmentIds.includes(d.analysisEnvironmentId) ? d.analysisEnvironmentId : (d.environmentIds[0] ?? ""),
    hashAttribute: d.hashAttribute.trim(),
    variations: d.variations.map((v) => ({ ...v, name: v.name.trim() || v.key })),
    coverage: d.coverage,
    weights,
    conditions: d.conditions.map((c) => ({ ...c, values: [...c.values] })),
    dataSourceId,
    primaryMetricId: d.primaryMetricId,
    secondaryMetricIds: [...d.secondaryMetricIds],
    guardrailMetricIds: [...d.guardrailMetricIds],
    stats: { ...d.stats, sequentialTuning: plan.total ?? d.stats.sequentialTuning },
    plan: {
      mde: d.mdePercent / 100,
      sampleSizePerVariation: plan.perVariation,
      dailyTraffic: Number.isFinite(d.dailyTraffic) ? d.dailyTraffic : null,
    },
  });

  const submit = () => {
    setSubmitted(true);
    if (blocked) return;
    if (experiment !== undefined) update.mutate({ id: experiment.id, ...toInput() });
    else create.mutate({ key: d.key, ...toInput() });
  };

  const setFeature = (id: string | null) => {
    const f = features.find((x) => x.id === id);
    const fresh = variationsFor(f);
    set({
      featureId: id,
      variations: d.variations.map((v, i) => ({ ...v, value: (fresh[Math.min(i, 1)] ?? fresh[0])?.value ?? "" })),
    });
  };
  const setVariation = (i: number, patch: Partial<VariationDraft>) =>
    set({ variations: d.variations.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  const addVariation = () => {
    const n = d.variations.length;
    const value = feature === undefined ? "" : (d.variations[n - 1]?.value ?? defaultValueFor(feature.valueType));
    set({
      variations: [...d.variations, { key: `treatment-${n}`, name: `Treatment ${n}`, value }],
      percents: d.evenSplit ? evenPercents(n + 1) : [...d.percents, 0],
    });
  };
  const removeVariation = (i: number) =>
    set({
      variations: d.variations.filter((_, j) => j !== i),
      percents: d.evenSplit ? evenPercents(d.variations.length - 1) : d.percents.filter((_, j) => j !== i),
    });
  const toggleEven = (even: boolean) => set({ evenSplit: even, percents: evenPercents(d.variations.length) });
  const setEnvironments = (ids: ReadonlyArray<string>) =>
    set({
      environmentIds: ids,
      // Never back to "": that would re-trigger the default-environment fill above
      analysisEnvironmentId: ids.includes(d.analysisEnvironmentId) ? d.analysisEnvironmentId : (ids[0] ?? d.analysisEnvironmentId),
    });
  const sameSource = metrics.filter((m) => m.dataSourceId === dataSourceId);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <Step n={1} id="step-hypothesis" title="Hypothesis" description="What you change, what you expect, and why.">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              value={d.name}
              onChange={(name) => set({ name, key: d.keyEdited ? d.key : slugify(name) })}
              isInvalid={submitted && d.name.trim() === ""}
              isRequired
              autoFocus={!isEdit}
            >
              <Label>Name</Label>
              <Input placeholder="One-page checkout" />
              <FieldError>Give the experiment a name.</FieldError>
            </TextField>
            <TextField
              value={d.key}
              onChange={(key) => set({ key, keyEdited: true })}
              isInvalid={!isEdit && d.key !== "" && !KEY_PATTERN.test(d.key)}
              isReadOnly={isEdit}
              isRequired={!isEdit}
            >
              <Label>Key</Label>
              <Input placeholder="one-page-checkout" spellCheck={false} className="font-mono" />
              <Description>{isEdit ? "Keys can't change after creation." : "Sent with every exposure. Can't change later."}</Description>
              <FieldError>Use lowercase letters, digits, - and _.</FieldError>
            </TextField>
          </div>
          <TextField value={d.hypothesis} onChange={(hypothesis) => set({ hypothesis })}>
            <Label>Hypothesis</Label>
            <TextArea
              rows={3}
              className="resize-y"
              placeholder="If we collapse checkout into one page, then more visitors will complete a purchase, because fewer steps means fewer chances to drop off."
            />
            <Description>Written before the data arrives, so the result can't change what you were testing.</Description>
          </TextField>
        </Step>

        <Step n={2} id="step-flag" title="Flag & variations" description="The experiment takes over this flag's rule; each variation serves its own value.">
          <ComboBox
            value={d.featureId}
            onChange={(k) => setFeature(typeof k === "string" ? k : null)}
            isInvalid={submitted && feature === undefined}
            className="sm:max-w-md"
          >
            <Label>Flag</Label>
            <ComboBox.InputGroup>
              <Input placeholder={featuresQuery.isPending ? "Loading flags…" : "Search flags"} className="font-mono placeholder:font-sans" />
              <ComboBox.Trigger />
            </ComboBox.InputGroup>
            <ComboBox.Popover>
              <ListBox renderEmptyState={() => <p className="px-3 py-4 text-label text-muted">No flags match.</p>}>
                {features.map((f) => (
                  <ListBox.Item key={f.id} id={f.id} textValue={f.key}>
                    <span className="flex-1 truncate font-mono text-label">{f.key}</span>
                    <span className="text-meta text-muted">{f.valueType}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </ComboBox.Popover>
            {featuresQuery.error !== null ? (
              <p className="text-meta text-danger">{errorMessage(featuresQuery.error)}</p>
            ) : features.length === 0 && !featuresQuery.isPending ? (
              <Description>
                No flags yet.{" "}
                <Link to="/flags" search={{ new: "1" }} className="text-link hover:underline">
                  Create a flag
                </Link>{" "}
                first; the experiment serves its values.
              </Description>
            ) : (
              <FieldError>Choose the flag this experiment runs on.</FieldError>
            )}
          </ComboBox>

          {feature !== undefined && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-label font-medium">Variations</p>
                <Switch size="sm" isSelected={d.evenSplit} onChange={toggleEven}>
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <span className="text-label">Even split</span>
                  </Switch.Content>
                </Switch>
              </div>
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                {d.variations.map((v, i) => {
                  const dupe = variationKeys.indexOf(v.key) !== i;
                  return (
                    <li key={i} className="flex flex-col gap-3 p-3 sm:p-4">
                      <div className="flex flex-wrap items-start gap-2">
                        <span className="mt-3.5 mr-1">
                          <VariationSwatch index={i} />
                        </span>
                        <TextField
                          aria-label={`Variation ${i + 1} name`}
                          value={v.name}
                          onChange={(name) => setVariation(i, { name })}
                          className="min-w-0 flex-1 basis-32"
                        >
                          <Input placeholder={i === 0 ? "Control" : "Treatment"} />
                        </TextField>
                        <TextField
                          aria-label={`Variation ${i + 1} key`}
                          value={v.key}
                          onChange={(key) => setVariation(i, { key })}
                          isInvalid={!KEY_PATTERN.test(v.key) || dupe}
                          className="min-w-0 flex-1 basis-32"
                        >
                          <Input className="font-mono" spellCheck={false} />
                          <FieldError>{dupe ? "Key already used" : "Lowercase letters, digits, - and _"}</FieldError>
                        </TextField>
                        <NumberField
                          aria-label={`Variation ${i + 1} weight`}
                          value={d.evenSplit ? Number((100 / d.variations.length).toFixed(1)) : d.percents[i]}
                          onChange={(p) => set({ percents: d.percents.map((x, j) => (j === i ? p : x)) })}
                          isDisabled={d.evenSplit}
                          minValue={0}
                          maxValue={100}
                          step={0.1}
                          className="w-24"
                        >
                          <NumberField.Group className="grid-cols-[1fr_auto]">
                            <NumberField.Input className="text-right tabular" />
                            <span className="pr-3 text-label text-muted">%</span>
                          </NumberField.Group>
                        </NumberField>
                        <Button
                          isIconOnly
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove ${v.name || `variation ${i + 1}`}`}
                          isDisabled={i === 0 || d.variations.length <= 2}
                          onPress={() => removeVariation(i)}
                          className="mt-0.5 text-muted"
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                      <div className="sm:pl-5.5">
                        <ValueInput
                          valueType={feature.valueType}
                          value={v.value}
                          onChange={(value) => setVariation(i, { value })}
                          label={i === 0 ? "Value (baseline)" : "Value"}
                        />
                        {i > 0 && v.value === d.variations[0]?.value && (
                          <p className="mt-1 text-meta text-muted">Same value as {d.variations[0]?.name || "control"}: this arm is an A/A check.</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button size="sm" variant="outline" onPress={addVariation} isDisabled={d.variations.length >= MAX_VARIATIONS}>
                  <Plus className="size-4" />
                  Add variation
                </Button>
                <p className={`font-mono text-label tabular ${Math.abs(totalPercent - 100) < 0.01 ? "text-muted" : "text-danger"}`} aria-live="polite">
                  Total {Number(totalPercent.toFixed(2))}%{Math.abs(totalPercent - 100) >= 0.01 && " · must be 100%"}
                </p>
              </div>
            </div>
          )}
        </Step>

        <Step n={3} id="step-traffic" title="Targeting & traffic" description="Who can enter, how many of them, and where the experiment runs.">
          <div className="flex flex-col gap-2">
            <p className="text-label font-medium">Who can enter</p>
            <ConditionBuilder value={d.conditions} onChange={(conditions) => set({ conditions })} />
          </div>
          <CoverageField
            value={d.coverage}
            onChange={(coverage) => set({ coverage })}
            description="Share of matching users who enter; the rest get the flag's other rules. You can raise it later without restarting."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <CheckboxGroup value={[...d.environmentIds]} onChange={setEnvironments}>
              <Label>Environments</Label>
              {environments.map((e) => (
                <Checkbox key={e.id} value={e.id}>
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    {e.name}
                  </Checkbox.Content>
                </Checkbox>
              ))}
              <Description>The experiment rule is added to the flag in each.</Description>
            </CheckboxGroup>
            <div className="flex flex-col gap-4">
              <Select
                value={d.analysisEnvironmentId || null}
                onChange={(k) => typeof k === "string" && set({ analysisEnvironmentId: k })}
                isDisabled={d.environmentIds.length === 0}
              >
                <Label>Analyze exposures from</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {environments
                      .filter((e) => d.environmentIds.includes(e.id))
                      .map((e) => (
                        <ListBox.Item key={e.id} id={e.id} textValue={e.name}>
                          {e.name}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                  </ListBox>
                </Select.Popover>
                <Description>Usually production; other environments are for QA.</Description>
              </Select>
              <TextField value={d.hashAttribute} onChange={(hashAttribute) => set({ hashAttribute })} isRequired>
                <Label>Assign by attribute</Label>
                <Input className="font-mono" spellCheck={false} />
                <Description>Users with the same value always get the same variation.</Description>
              </TextField>
            </div>
          </div>
          {offIn.length > 0 && (
            <p className="flex items-start gap-2 rounded-md border border-border bg-surface-secondary px-3 py-2 text-label">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden="true" />
              <span>
                <span className="font-mono">{feature?.key}</span> is off in {offIn.map((e) => e.name).join(", ")}. Turn it on before
                starting, or nobody there is assigned.
              </span>
            </p>
          )}
        </Step>

        <Step
          n={4}
          id="step-metrics"
          title="Metrics"
          description="Decide up front what counts as success, so the result can't be cherry-picked later."
          actions={
            <a href="/metrics?new=1" target="_blank" rel="noreferrer" className="button button--ghost button--sm shrink-0 text-muted">
              New metric
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          }
        >
          <ComboBox value={d.primaryMetricId} onChange={(k) => set({ primaryMetricId: typeof k === "string" ? k : null })} className="sm:max-w-md">
            <Label>Primary metric</Label>
            <ComboBox.InputGroup>
              <Input placeholder={metricsQuery.isPending ? "Loading metrics…" : "Search metrics"} />
              <ComboBox.Trigger />
            </ComboBox.InputGroup>
            <ComboBox.Popover>
              <ListBox renderEmptyState={() => <p className="px-3 py-4 text-label text-muted">No metrics match.</p>}>
                {metrics.map((m) => (
                  <ListBox.Item key={m.id} id={m.id} textValue={m.name}>
                    <span className="flex-1 truncate">{m.name}</span>
                    <span className="text-meta text-muted">{m.type === "proportion" ? "conversion" : m.type}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </ComboBox.Popover>
            <Description>
              {metrics.length === 0 && !metricsQuery.isPending
                ? "No metrics yet. Create one in a new tab; this list refreshes when you come back."
                : "The one metric that decides ship or roll back. Required to start."}
            </Description>
          </ComboBox>
          <div className="grid gap-4 sm:grid-cols-2">
            <MetricMultiSelect
              label="Secondary metrics"
              description="Explain why the primary moved."
              value={d.secondaryMetricIds}
              onChange={(secondaryMetricIds) => set({ secondaryMetricIds })}
              options={sameSource.filter((m) => m.id !== d.primaryMetricId && !d.guardrailMetricIds.includes(m.id))}
            />
            <MetricMultiSelect
              label="Guardrails"
              description="Must not get worse, e.g. errors or latency."
              value={d.guardrailMetricIds}
              onChange={(guardrailMetricIds) => set({ guardrailMetricIds })}
              options={sameSource.filter((m) => m.id !== d.primaryMetricId && !d.secondaryMetricIds.includes(m.id))}
            />
          </div>
        </Step>

        <Step n={5} id="step-plan" title="Plan" description="How many users you need to detect the effect you care about, and how long that takes.">
          <PowerPlanner d={d} set={set} plan={plan} primary={primary} variations={d.variations.length} />
        </Step>

        <Disclosure className="rounded-[10px] border border-border bg-surface">
          <Disclosure.Heading>
            <Disclosure.Trigger className="flex w-full items-center justify-between px-5 py-4 text-left">
              <span>
                <span className="block text-body font-medium">Advanced: statistics</span>
                <span className="block text-label font-normal text-muted">
                  {d.stats.engine === "bayesian" ? "Bayesian" : d.stats.sequential ? "Sequential frequentist" : "Fixed-horizon frequentist"} ·{" "}
                  {Math.round((1 - d.stats.alpha) * 100)}% · {d.stats.cuped ? "CUPED on" : "CUPED off"}
                  {isEdit ? "" : " · locked when the experiment starts"}
                </span>
              </span>
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="flex flex-col gap-5 border-t border-border px-5 py-5">
              <StatsFields stats={d.stats} onChange={(stats) => set({ stats })} />
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      </div>

      <aside className="flex flex-col gap-4 rounded-[10px] border border-border bg-surface p-5 lg:sticky lg:top-8">
        <div>
          <h2 className="text-meta font-medium text-muted">Summary</h2>
          <p className="mt-1 truncate text-body font-medium">{d.name.trim() || "Untitled experiment"}</p>
          {!isEdit && d.key !== "" && <p className="truncate font-mono text-meta text-muted">{d.key}</p>}
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-border pt-3 text-label">
          <dt className="text-muted">Flag</dt>
          <dd className="truncate font-mono">{feature?.key ?? "–"}</dd>
          <dt className="text-muted">Split</dt>
          <dd className="flex items-center gap-1.5 tabular">
            {d.variations.map((v, i) => (
              <span key={i} className="inline-flex items-center gap-1" title={v.name}>
                <VariationSwatch index={i} />
                {weightLabel(weights[i] ?? 0)}
              </span>
            ))}
          </dd>
          <dt className="text-muted">Traffic</dt>
          <dd className="truncate" title={conditionsSummary(d.conditions)}>
            {formatPercent(d.coverage, 0)} of {d.conditions.length === 0 ? "everyone" : "matching users"}
          </dd>
          <dt className="text-muted">Runs in</dt>
          <dd className="truncate">{environments.filter((e) => d.environmentIds.includes(e.id)).map((e) => e.name).join(", ") || "–"}</dd>
          <dt className="text-muted">Primary</dt>
          <dd className="truncate">{primary?.name ?? "–"}</dd>
          <dt className="text-muted">Plan</dt>
          <dd className="tabular">
            {plan.perVariation === null
              ? "–"
              : `${formatCount(plan.perVariation)}/variation${plan.days === null ? "" : ` · ~${plan.days} days`}`}
          </dd>
        </dl>
        <ul className="flex flex-col gap-1 border-t border-border pt-3" aria-label="Checklist">
          {checks.map((c) => (
            <li key={c.id}>
              <a
                href={`#${c.section}`}
                className={`flex items-center gap-2 rounded-sm text-label outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus ${
                  c.ok ? "text-muted" : submitted && c.blocking ? "text-danger" : "text-foreground"
                }`}
              >
                {c.ok ? (
                  <Check className="size-3.5 shrink-0 text-win" aria-label="Done" />
                ) : (
                  <Circle className={`size-3.5 shrink-0 ${c.blocking ? "" : "text-muted"}`} aria-label={c.blocking ? "Required" : "Recommended"} />
                )}
                {c.label}
              </a>
            </li>
          ))}
        </ul>
        {save.error !== null && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-label text-danger">
            {errorMessage(save.error)}
          </p>
        )}
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <Button type="submit" size="sm" fullWidth isPending={save.isPending} isDisabled={submitted && blocked}>
            {isEdit ? "Save changes" : "Create draft"}
          </Button>
          <Button size="sm" variant="ghost" fullWidth onPress={onCancel} isDisabled={save.isPending}>
            Cancel
          </Button>
          <p className="text-center text-meta text-muted">
            {isEdit ? "Still a draft: nothing is live until you start it." : "Drafts don't change what users see."}
          </p>
        </div>
      </aside>
    </form>
  );
}

function Step({
  n,
  id,
  title,
  description,
  actions,
  children,
}: {
  n: number;
  id: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-8 rounded-[10px] border border-border bg-surface">
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[11px] text-muted tabular">
          {n}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="text-body font-medium">
            {title}
          </h2>
          <p className="mt-0.5 text-label text-muted">{description}</p>
        </div>
        {actions}
      </header>
      <div className="flex flex-col gap-5 px-5 py-5">{children}</div>
    </section>
  );
}

function MetricMultiSelect({
  label,
  description,
  value,
  onChange,
  options,
}: {
  label: string;
  description: string;
  value: ReadonlyArray<string>;
  onChange: (ids: ReadonlyArray<string>) => void;
  options: ReadonlyArray<Metric>;
}) {
  return (
    <Select
      selectionMode="multiple"
      value={[...value]}
      onChange={(keys) => onChange((keys as Array<string | number>).map(String))}
      placeholder="None"
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value className="truncate" />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox renderEmptyState={() => <p className="px-3 py-4 text-label text-muted">No other metrics from this data source.</p>}>
          {options.map((m) => (
            <ListBox.Item key={m.id} id={m.id} textValue={m.name}>
              {m.name}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
      <Description>{description}</Description>
    </Select>
  );
}

function PlanNumber({
  label,
  value,
  onChange,
  suffix,
  description,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  suffix?: string;
  description?: string;
  step?: number;
}) {
  return (
    <NumberField value={value} onChange={onChange} minValue={0} step={step} formatOptions={{ maximumFractionDigits: 4 }}>
      <Label>{label}</Label>
      <NumberField.Group>
        <NumberField.Input className="tabular" />
        {suffix !== undefined && <span className="pr-3 text-label whitespace-nowrap text-muted">{suffix}</span>}
      </NumberField.Group>
      {description !== undefined && <Description>{description}</Description>}
    </NumberField>
  );
}

function PowerPlanner({
  d,
  set,
  plan,
  primary,
  variations,
}: {
  d: Draft;
  set: (patch: Partial<Draft>) => void;
  plan: ReturnType<typeof planOf>;
  primary: Metric | undefined;
  variations: number;
}) {
  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]">
      <div className="grid content-start gap-4 sm:grid-cols-2">
        {plan.kind === "proportion" ? (
          <PlanNumber
            label="Baseline conversion rate"
            value={d.baselineRate}
            onChange={(baselineRate) => set({ baselineRate })}
            suffix="%"
            step={0.1}
            description={primary === undefined ? "Today's rate of the primary metric." : `Today's ${primary.name}.`}
          />
        ) : (
          <>
            <PlanNumber label="Baseline mean per user" value={d.baselineMean} onChange={(baselineMean) => set({ baselineMean })} step={0.1} />
            <PlanNumber
              label="Standard deviation"
              value={d.baselineStdDev}
              onChange={(baselineStdDev) => set({ baselineStdDev })}
              step={0.1}
              description="Of the per-user value."
            />
          </>
        )}
        <PlanNumber
          label="Daily eligible users"
          value={d.dailyTraffic}
          onChange={(dailyTraffic) => set({ dailyTraffic })}
          suffix="/ day"
          description="Users who evaluate the flag and match the targeting."
        />
        <PlanNumber
          label="Minimum detectable effect"
          value={d.mdePercent}
          onChange={(mdePercent) => set({ mdePercent })}
          suffix="% relative"
          step={0.5}
          description="Smallest lift worth detecting."
        />
      </div>
      <div className="flex flex-col gap-3 rounded-lg bg-surface-secondary p-4" aria-live="polite">
        <div>
          <p className="text-meta text-muted">Users per variation</p>
          <p className="text-figure font-semibold tracking-tight tabular">{plan.perVariation === null ? "–" : formatCount(plan.perVariation)}</p>
          {plan.total !== null && <p className="text-meta text-muted">{formatCount(plan.total)} across {variations} variations</p>}
        </div>
        <div>
          <p className="text-meta text-muted">Estimated duration</p>
          <p className="text-section font-medium tabular">
            {plan.days === null ? "–" : `${formatCount(plan.days)} ${plan.days === 1 ? "day" : "days"}`}
          </p>
          {plan.days !== null && plan.days < 7 && <p className="text-meta text-muted">Run at least 7 days to cover weekly cycles.</p>}
        </div>
        {plan.mdeIn14 !== null && (
          <p className="border-t border-border pt-3 text-meta text-muted">
            In 14 days you could detect a <span className="font-mono text-foreground tabular">{formatPercent(plan.mdeIn14)}</span> lift.
          </p>
        )}
        <p className="text-meta text-muted">
          {plan.perVariation === null
            ? "Fill in the baseline and traffic to see the sample size."
            : "80% power, fixed horizon. The planned total also tunes the sequential test."}
        </p>
      </div>
    </div>
  );
}

function StatsFields({
  stats,
  onChange,
}: {
  stats: ReturnType<typeof defaultStatsSettings>;
  onChange: (stats: ReturnType<typeof defaultStatsSettings>) => void;
}) {
  const patch = (p: Partial<ReturnType<typeof defaultStatsSettings>>) => onChange({ ...stats, ...p });
  const frequentist = stats.engine === "frequentist";
  const toggle = (label: string, description: string, isSelected: boolean, change: (v: boolean) => void, isDisabled = false) => (
    <Switch isSelected={isSelected} onChange={change} isDisabled={isDisabled}>
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        {label}
      </Switch.Content>
      <Description>{description}</Description>
    </Switch>
  );
  return (
    <>
      <Segmented
        label="Engine"
        value={stats.engine}
        onChange={(engine) => patch({ engine })}
        options={[
          { value: "frequentist", label: "Frequentist", description: "p-values and confidence intervals." },
          { value: "bayesian", label: "Bayesian", description: "Chance to win and credible intervals." },
        ]}
      />
      {toggle(
        "Sequential testing",
        frequentist
          ? "Intervals stay valid however often you check results. Keep it on unless you will look exactly once."
          : "Frequentist only.",
        stats.sequential,
        (sequential) => patch({ sequential }),
        !frequentist,
      )}
      {toggle(
        "CUPED",
        "Uses each user's behavior in the 14 days before exposure to shrink intervals, so you need fewer users.",
        stats.cuped,
        (cuped) => patch({ cuped }),
      )}
      {toggle(
        "Holm correction",
        frequentist ? "Adjusts p-values when several metrics and variations are compared, to keep false wins rare." : "Frequentist only.",
        stats.correction === "holm",
        (on) => patch({ correction: on ? "holm" : "none" }),
        !frequentist,
      )}
      <Segmented
        label="Confidence level"
        value={String(stats.alpha) as "0.01" | "0.05" | "0.1"}
        onChange={(a) => patch({ alpha: Number(a) })}
        options={[
          { value: "0.1", label: "90%" },
          { value: "0.05", label: "95%" },
          { value: "0.01", label: "99%" },
        ]}
        description="A higher level means fewer false wins but needs more users."
      />
    </>
  );
}
