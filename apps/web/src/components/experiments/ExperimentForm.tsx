import { type Experiment, defaultStatsSettings } from "@furca/core/experiments/Experiment";
import { type Feature, validateFeatureValue } from "@furca/core/features/Feature";
import { BUILTIN_DATA_SOURCE_ID } from "@furca/core/datasources/DataSource";
import type { Metric } from "@furca/core/metrics/Metric";
import { daysToReach, mdeForSampleSize, sampleSizePerVariation } from "@furca/stats";
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
import { Trans, useTranslation } from "react-i18next";
import { ValueInput, defaultValueFor } from "~/components/flags/ValueInput";
import { slugify } from "~/components/metrics/MetricForm";
import { formatCount, formatList, formatPercent } from "~/components/results/format";
import { ConditionBuilder, type ConditionValue, conditionIssue, conditionsSummary } from "~/components/targeting/ConditionBuilder";
import { Segmented } from "~/components/ui/Segmented";
import { i18n } from "~/i18n";
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
    { key: "control", name: i18n.t("experiments:form.defaults.control"), value: base },
    { key: "treatment", name: i18n.t("experiments:form.defaults.treatment"), value: treatment },
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
  const { t } = useTranslation(["experiments", "common"]);
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
    { id: "name", label: t("form.checks.name"), ok: d.name.trim() !== "", blocking: true, section: "step-hypothesis" },
    { id: "key", label: t("form.checks.key"), ok: isEdit || KEY_PATTERN.test(d.key), blocking: true, section: "step-hypothesis" },
    { id: "flag", label: t("form.checks.flag"), ok: feature !== undefined, blocking: true, section: "step-flag" },
    {
      id: "values",
      label: t("form.checks.values"),
      ok: feature !== undefined && d.variations.every((v) => validateFeatureValue(feature.valueType, v.value) === null),
      blocking: true,
      section: "step-flag",
    },
    {
      id: "keys",
      label: t("form.checks.keys"),
      ok: variationKeys.every((k) => KEY_PATTERN.test(k)) && new Set(variationKeys).size === variationKeys.length,
      blocking: true,
      section: "step-flag",
    },
    { id: "weights", label: t("form.checks.weights"), ok: Math.abs(totalPercent - 100) < 0.01 && weights.every((w) => w > 0), blocking: true, section: "step-flag" },
    { id: "targeting", label: t("form.checks.targeting"), ok: d.conditions.every((c) => conditionIssue(c) === null), blocking: true, section: "step-traffic" },
    { id: "envs", label: t("form.checks.envs"), ok: d.environmentIds.length > 0, blocking: true, section: "step-traffic" },
    { id: "hash", label: t("form.checks.hash"), ok: d.hashAttribute.trim() !== "", blocking: true, section: "step-traffic" },
    { id: "primary", label: t("form.checks.primary"), ok: primary !== undefined, blocking: false, section: "step-metrics" },
    { id: "plan", label: t("form.checks.plan"), ok: plan.perVariation !== null, blocking: false, section: "step-plan" },
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
      variations: [...d.variations, { key: `treatment-${n}`, name: t("form.defaults.treatmentN", { n }), value }],
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
        <Step n={1} id="step-hypothesis" title={t("form.hypothesis.title")} description={t("form.hypothesis.description")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              value={d.name}
              onChange={(name) => set({ name, key: d.keyEdited ? d.key : slugify(name) })}
              isInvalid={submitted && d.name.trim() === ""}
              isRequired
              autoFocus={!isEdit}
            >
              <Label>{t("form.hypothesis.name")}</Label>
              <Input placeholder={t("form.hypothesis.namePlaceholder")} />
              <FieldError>{t("form.hypothesis.nameError")}</FieldError>
            </TextField>
            <TextField
              value={d.key}
              onChange={(key) => set({ key, keyEdited: true })}
              isInvalid={!isEdit && d.key !== "" && !KEY_PATTERN.test(d.key)}
              isReadOnly={isEdit}
              isRequired={!isEdit}
            >
              <Label>{t("form.hypothesis.key")}</Label>
              <Input placeholder="one-page-checkout" spellCheck={false} className="font-mono" />
              <Description>{isEdit ? t("form.hypothesis.keyLocked") : t("form.hypothesis.keyHelp")}</Description>
              <FieldError>{t("form.hypothesis.keyError")}</FieldError>
            </TextField>
          </div>
          <TextField value={d.hypothesis} onChange={(hypothesis) => set({ hypothesis })}>
            <Label>{t("form.hypothesis.hypothesis")}</Label>
            <TextArea rows={3} className="resize-y" placeholder={t("form.hypothesis.hypothesisPlaceholder")} />
            <Description>{t("form.hypothesis.hypothesisHelp")}</Description>
          </TextField>
        </Step>

        <Step n={2} id="step-flag" title={t("form.flag.title")} description={t("form.flag.description")}>
          <ComboBox
            value={d.featureId}
            onChange={(k) => setFeature(typeof k === "string" ? k : null)}
            isInvalid={submitted && feature === undefined}
            className="sm:max-w-md"
          >
            <Label>{t("form.flag.label")}</Label>
            <ComboBox.InputGroup>
              <Input placeholder={featuresQuery.isPending ? t("form.flag.loading") : t("form.flag.search")} className="font-mono placeholder:font-sans" />
              <ComboBox.Trigger />
            </ComboBox.InputGroup>
            <ComboBox.Popover>
              <ListBox renderEmptyState={() => <p className="px-3 py-4 text-label text-muted">{t("form.flag.noMatch")}</p>}>
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
                <Trans
                  t={t}
                  i18nKey="form.flag.noFlags"
                  components={{ link: <Link to="/flags" search={{ new: "1" }} className="text-link hover:underline" /> }}
                />
              </Description>
            ) : (
              <FieldError>{t("form.flag.error")}</FieldError>
            )}
          </ComboBox>

          {feature !== undefined && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-label font-medium">{t("form.flag.variations")}</p>
                <Switch size="sm" isSelected={d.evenSplit} onChange={toggleEven}>
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <span className="text-label">{t("form.flag.evenSplit")}</span>
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
                          aria-label={t("form.flag.variationName", { n: i + 1 })}
                          value={v.name}
                          onChange={(name) => setVariation(i, { name })}
                          className="min-w-0 flex-1 basis-32"
                        >
                          <Input placeholder={i === 0 ? t("form.defaults.control") : t("form.defaults.treatment")} />
                        </TextField>
                        <TextField
                          aria-label={t("form.flag.variationKey", { n: i + 1 })}
                          value={v.key}
                          onChange={(key) => setVariation(i, { key })}
                          isInvalid={!KEY_PATTERN.test(v.key) || dupe}
                          className="min-w-0 flex-1 basis-32"
                        >
                          <Input className="font-mono" spellCheck={false} />
                          <FieldError>{dupe ? t("form.flag.keyUsed") : t("form.flag.keyFormat")}</FieldError>
                        </TextField>
                        <NumberField
                          aria-label={t("form.flag.variationWeight", { n: i + 1 })}
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
                          aria-label={t("form.flag.remove", { name: v.name || t("form.flag.variationN", { n: i + 1 }) })}
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
                          label={i === 0 ? t("form.flag.valueBaseline") : t("form.flag.value")}
                        />
                        {i > 0 && v.value === d.variations[0]?.value && (
                          <p className="mt-1 text-meta text-muted">
                            {t("form.flag.sameValue", { name: d.variations[0]?.name || t("form.flag.controlFallback") })}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button size="sm" variant="outline" onPress={addVariation} isDisabled={d.variations.length >= MAX_VARIATIONS}>
                  <Plus className="size-4" />
                  {t("form.flag.add")}
                </Button>
                <p className={`font-mono text-label tabular ${Math.abs(totalPercent - 100) < 0.01 ? "text-muted" : "text-danger"}`} aria-live="polite">
                  {t(Math.abs(totalPercent - 100) < 0.01 ? "form.flag.total" : "form.flag.totalInvalid", { percent: Number(totalPercent.toFixed(2)) })}
                </p>
              </div>
            </div>
          )}
        </Step>

        <Step n={3} id="step-traffic" title={t("form.traffic.title")} description={t("form.traffic.description")}>
          <div className="flex flex-col gap-2">
            <p className="text-label font-medium">{t("form.traffic.whoCanEnter")}</p>
            <ConditionBuilder value={d.conditions} onChange={(conditions) => set({ conditions })} />
          </div>
          <CoverageField
            value={d.coverage}
            onChange={(coverage) => set({ coverage })}
            description={t("form.traffic.coverageHelp")}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <CheckboxGroup value={[...d.environmentIds]} onChange={setEnvironments}>
              <Label>{t("form.traffic.environments")}</Label>
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
              <Description>{t("form.traffic.environmentsHelp")}</Description>
            </CheckboxGroup>
            <div className="flex flex-col gap-4">
              <Select
                value={d.analysisEnvironmentId || null}
                onChange={(k) => typeof k === "string" && set({ analysisEnvironmentId: k })}
                isDisabled={d.environmentIds.length === 0}
              >
                <Label>{t("form.traffic.analyzeFrom")}</Label>
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
                <Description>{t("form.traffic.analyzeHelp")}</Description>
              </Select>
              <TextField value={d.hashAttribute} onChange={(hashAttribute) => set({ hashAttribute })} isRequired>
                <Label>{t("form.traffic.assignBy")}</Label>
                <Input className="font-mono" spellCheck={false} />
                <Description>{t("form.traffic.assignByHelp")}</Description>
              </TextField>
            </div>
          </div>
          {offIn.length > 0 && (
            <p className="flex items-start gap-2 rounded-md border border-border bg-surface-secondary px-3 py-2 text-label">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden="true" />
              <span>
                <Trans
                  t={t}
                  i18nKey="form.traffic.flagOff"
                  values={{ flag: feature?.key ?? "", environments: formatList(offIn.map((e) => e.name)) }}
                  components={{ code: <span className="font-mono" /> }}
                />
              </span>
            </p>
          )}
        </Step>

        <Step
          n={4}
          id="step-metrics"
          title={t("form.metrics.title")}
          description={t("form.metrics.description")}
          actions={
            <a href="/metrics?new=1" target="_blank" rel="noreferrer" className="button button--ghost button--sm shrink-0 text-muted">
              {t("form.metrics.newMetric")}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          }
        >
          <ComboBox value={d.primaryMetricId} onChange={(k) => set({ primaryMetricId: typeof k === "string" ? k : null })} className="sm:max-w-md">
            <Label>{t("form.metrics.primary")}</Label>
            <ComboBox.InputGroup>
              <Input placeholder={metricsQuery.isPending ? t("form.metrics.loading") : t("form.metrics.search")} />
              <ComboBox.Trigger />
            </ComboBox.InputGroup>
            <ComboBox.Popover>
              <ListBox renderEmptyState={() => <p className="px-3 py-4 text-label text-muted">{t("form.metrics.noMatch")}</p>}>
                {metrics.map((m) => (
                  <ListBox.Item key={m.id} id={m.id} textValue={m.name}>
                    <span className="flex-1 truncate">{m.name}</span>
                    <span className="text-meta text-muted">{t(`form.metrics.types.${m.type}`)}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </ComboBox.Popover>
            <Description>
              {metrics.length === 0 && !metricsQuery.isPending
                ? t("form.metrics.noMetrics")
                : t("form.metrics.primaryHelp")}
            </Description>
          </ComboBox>
          <div className="grid gap-4 sm:grid-cols-2">
            <MetricMultiSelect
              label={t("form.metrics.secondary")}
              description={t("form.metrics.secondaryHelp")}
              value={d.secondaryMetricIds}
              onChange={(secondaryMetricIds) => set({ secondaryMetricIds })}
              options={sameSource.filter((m) => m.id !== d.primaryMetricId && !d.guardrailMetricIds.includes(m.id))}
            />
            <MetricMultiSelect
              label={t("form.metrics.guardrails")}
              description={t("form.metrics.guardrailsHelp")}
              value={d.guardrailMetricIds}
              onChange={(guardrailMetricIds) => set({ guardrailMetricIds })}
              options={sameSource.filter((m) => m.id !== d.primaryMetricId && !d.secondaryMetricIds.includes(m.id))}
            />
          </div>
        </Step>

        <Step n={5} id="step-plan" title={t("form.plan.title")} description={t("form.plan.description")}>
          <PowerPlanner d={d} set={set} plan={plan} primary={primary} variations={d.variations.length} />
        </Step>

        <Disclosure className="rounded-[10px] border border-border bg-surface">
          <Disclosure.Heading>
            <Disclosure.Trigger className="flex w-full items-center justify-between px-5 py-4 text-left">
              <span>
                <span className="block text-body font-medium">{t("form.stats.title")}</span>
                <span className="block text-label font-normal text-muted">
                  {[
                    d.stats.engine === "bayesian" ? t("form.stats.bayesian") : d.stats.sequential ? t("form.stats.sequential") : t("form.stats.fixed"),
                    `${Math.round((1 - d.stats.alpha) * 100)}%`,
                    d.stats.cuped ? t("form.stats.cupedOn") : t("form.stats.cupedOff"),
                    isEdit ? null : t("form.stats.lockedOnStart"),
                  ]
                    .filter((p) => p !== null)
                    .join(" · ")}
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
          <h2 className="text-meta font-medium text-muted">{t("form.summary.title")}</h2>
          <p className="mt-1 truncate text-body font-medium">{d.name.trim() || t("form.summary.untitled")}</p>
          {!isEdit && d.key !== "" && <p className="truncate font-mono text-meta text-muted">{d.key}</p>}
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-border pt-3 text-label">
          <dt className="text-muted">{t("form.summary.flag")}</dt>
          <dd className="truncate font-mono">{feature?.key ?? "–"}</dd>
          <dt className="text-muted">{t("form.summary.split")}</dt>
          <dd className="flex items-center gap-1.5 tabular">
            {d.variations.map((v, i) => (
              <span key={i} className="inline-flex items-center gap-1" title={v.name}>
                <VariationSwatch index={i} />
                {weightLabel(weights[i] ?? 0)}
              </span>
            ))}
          </dd>
          <dt className="text-muted">{t("form.summary.traffic")}</dt>
          <dd className="truncate" title={conditionsSummary(d.conditions)}>
            {t(d.conditions.length === 0 ? "form.summary.ofEveryone" : "form.summary.ofMatching", { percent: formatPercent(d.coverage, 0) })}
          </dd>
          <dt className="text-muted">{t("form.summary.runsIn")}</dt>
          <dd className="truncate">{formatList(environments.filter((e) => d.environmentIds.includes(e.id)).map((e) => e.name)) || "–"}</dd>
          <dt className="text-muted">{t("form.summary.primary")}</dt>
          <dd className="truncate">{primary?.name ?? "–"}</dd>
          <dt className="text-muted">{t("form.summary.plan")}</dt>
          <dd className="tabular">
            {plan.perVariation === null
              ? "–"
              : [
                  t("form.summary.perVariation", { n: formatCount(plan.perVariation) }),
                  plan.days === null ? null : t("form.summary.days", { count: plan.days }),
                ]
                  .filter((p) => p !== null)
                  .join(" · ")}
          </dd>
        </dl>
        <ul className="flex flex-col gap-1 border-t border-border pt-3" aria-label={t("form.checks.label")}>
          {checks.map((c) => (
            <li key={c.id}>
              <a
                href={`#${c.section}`}
                className={`flex items-center gap-2 rounded-sm text-label outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus ${
                  c.ok ? "text-muted" : submitted && c.blocking ? "text-danger" : "text-foreground"
                }`}
              >
                {c.ok ? (
                  <Check className="size-3.5 shrink-0 text-win" aria-label={t("form.checks.done")} />
                ) : (
                  <Circle className={`size-3.5 shrink-0 ${c.blocking ? "" : "text-muted"}`} aria-label={c.blocking ? t("form.checks.required") : t("form.checks.recommended")} />
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
            {isEdit ? t("form.summary.save") : t("form.summary.create")}
          </Button>
          <Button size="sm" variant="ghost" fullWidth onPress={onCancel} isDisabled={save.isPending}>
            {t("common:actions.cancel")}
          </Button>
          <p className="text-center text-meta text-muted">{isEdit ? t("form.summary.editNote") : t("form.summary.createNote")}</p>
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
  const { t } = useTranslation(["experiments", "common"]);
  return (
    <Select
      selectionMode="multiple"
      value={[...value]}
      onChange={(keys) => onChange((keys as Array<string | number>).map(String))}
      placeholder={t("common:states.none")}
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value className="truncate" />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox renderEmptyState={() => <p className="px-3 py-4 text-label text-muted">{t("form.metrics.noOthers")}</p>}>
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
  const { t } = useTranslation("experiments");
  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]">
      <div className="grid content-start gap-4 sm:grid-cols-2">
        {plan.kind === "proportion" ? (
          <PlanNumber
            label={t("form.plan.baselineRate")}
            value={d.baselineRate}
            onChange={(baselineRate) => set({ baselineRate })}
            suffix="%"
            step={0.1}
            description={primary === undefined ? t("form.plan.baselineRateHelp") : t("form.plan.baselineRateOf", { metric: primary.name })}
          />
        ) : (
          <>
            <PlanNumber label={t("form.plan.baselineMean")} value={d.baselineMean} onChange={(baselineMean) => set({ baselineMean })} step={0.1} />
            <PlanNumber
              label={t("form.plan.stdDev")}
              value={d.baselineStdDev}
              onChange={(baselineStdDev) => set({ baselineStdDev })}
              step={0.1}
              description={t("form.plan.stdDevHelp")}
            />
          </>
        )}
        <PlanNumber
          label={t("form.plan.dailyUsers")}
          value={d.dailyTraffic}
          onChange={(dailyTraffic) => set({ dailyTraffic })}
          suffix={t("form.plan.perDay")}
          description={t("form.plan.dailyUsersHelp")}
        />
        <PlanNumber
          label={t("form.plan.mde")}
          value={d.mdePercent}
          onChange={(mdePercent) => set({ mdePercent })}
          suffix={t("form.plan.relative")}
          step={0.5}
          description={t("form.plan.mdeHelp")}
        />
      </div>
      <div className="flex flex-col gap-3 rounded-lg bg-surface-secondary p-4" aria-live="polite">
        <div>
          <p className="text-meta text-muted">{t("form.plan.usersPerVariation")}</p>
          <p className="text-figure font-semibold tracking-tight tabular">{plan.perVariation === null ? "–" : formatCount(plan.perVariation)}</p>
          {plan.total !== null && (
            <p className="text-meta text-muted">{t("form.plan.acrossVariations", { total: formatCount(plan.total), n: variations })}</p>
          )}
        </div>
        <div>
          <p className="text-meta text-muted">{t("form.plan.duration")}</p>
          <p className="text-section font-medium tabular">
            {plan.days === null ? "–" : t("form.plan.days", { count: plan.days, days: formatCount(plan.days) })}
          </p>
          {plan.days !== null && plan.days < 7 && <p className="text-meta text-muted">{t("form.plan.minWeek")}</p>}
        </div>
        {plan.mdeIn14 !== null && (
          <p className="border-t border-border pt-3 text-meta text-muted">
            <Trans
              t={t}
              i18nKey="form.plan.in14Days"
              values={{ mde: formatPercent(plan.mdeIn14) }}
              components={{ value: <span className="font-mono text-foreground tabular" /> }}
            />
          </p>
        )}
        <p className="text-meta text-muted">
          {plan.perVariation === null
            ? t("form.plan.fillIn")
            : t("form.plan.assumptions")}
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
  const { t } = useTranslation("experiments");
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
        label={t("form.stats.engine")}
        value={stats.engine}
        onChange={(engine) => patch({ engine })}
        options={[
          { value: "frequentist", label: t("form.stats.frequentist"), description: t("form.stats.frequentistHelp") },
          { value: "bayesian", label: t("form.stats.bayesian"), description: t("form.stats.bayesianHelp") },
        ]}
      />
      {toggle(
        t("form.stats.sequentialTesting"),
        frequentist ? t("form.stats.sequentialHelp") : t("form.stats.frequentistOnly"),
        stats.sequential,
        (sequential) => patch({ sequential }),
        !frequentist,
      )}
      {toggle(
        t("form.stats.cuped"),
        t("form.stats.cupedHelp"),
        stats.cuped,
        (cuped) => patch({ cuped }),
      )}
      {toggle(
        t("form.stats.holm"),
        frequentist ? t("form.stats.holmHelp") : t("form.stats.frequentistOnly"),
        stats.correction === "holm",
        (on) => patch({ correction: on ? "holm" : "none" }),
        !frequentist,
      )}
      <Segmented
        label={t("form.stats.confidence")}
        value={String(stats.alpha) as "0.01" | "0.05" | "0.1"}
        onChange={(a) => patch({ alpha: Number(a) })}
        options={[
          { value: "0.1", label: "90%" },
          { value: "0.05", label: "95%" },
          { value: "0.01", label: "99%" },
        ]}
        description={t("form.stats.confidenceHelp")}
      />
    </>
  );
}
