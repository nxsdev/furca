import { type Experiment, defaultStatsSettings } from "@furca/core/experiments/Experiment";
import type { Feature } from "@furca/core/features/Feature";
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
import { useStore } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, Circle, ExternalLink, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ValueInput, defaultValueFor } from "~/components/flags/ValueInput";
import { errorText, setServerError, submitHandler, useAppForm } from "~/components/form/form";
import { slugify } from "~/components/metrics/slugify";
import { formatCount, formatList, formatPercent } from "~/components/results/format";
import { ConditionBuilder, conditionsSummary } from "~/components/targeting/ConditionBuilder";
import { Segmented } from "~/components/ui/Segmented";
import { i18n } from "~/i18n";
import { useEnvironment } from "~/lib/environment";
import { client, errorMessage, orpc } from "~/lib/rpc";
import { type CheckId, draftIssues, type ExperimentValues, totalPercent, type VariationValues, weightsOf } from "./draft";
import { CoverageField, evenPercents, MAX_VARIATIONS, shownError, VariationSwatch, weightLabel } from "./parts";

const variationsFor = (feature: Feature | undefined): Array<VariationValues> => {
  const base = feature === undefined ? "" : feature.defaultValue;
  const treatment = feature?.valueType === "boolean" ? (base === "true" ? "false" : "true") : base;
  return [
    { key: "control", name: i18n.t("experiments:form.defaults.control"), value: base, percent: 50 },
    { key: "treatment", name: i18n.t("experiments:form.defaults.treatment"), value: treatment, percent: 50 },
  ];
};

const toValues = (x: Experiment | undefined, envId: string, featureId: string | null): ExperimentValues => {
  const n = x?.variations.length ?? 2;
  return {
    name: x?.name ?? "",
    key: x?.key ?? "",
    hypothesis: x?.hypothesis ?? "",
    featureId: x?.featureId ?? featureId,
    variations:
      x === undefined
        ? variationsFor(undefined)
        : x.variations.map((v, i) => ({ key: v.key, name: v.name, value: v.value, percent: Number(((x.weights[i] ?? 0) * 100).toFixed(2)) })),
    evenSplit: x === undefined || x.weights.every((w) => Math.abs(w - 1 / n) < 1e-3),
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
function planOf(d: ExperimentValues, primary: Metric | undefined) {
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

interface Check {
  readonly id: CheckId | "primary" | "plan";
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

  const featuresQuery = useQuery(orpc.features.list.queryOptions({ input: { includeArchived: false } }));
  const metricsQuery = useQuery({
    ...orpc.metrics.list.queryOptions({ input: { includeArchived: false } }),
    refetchOnWindowFocus: true,
  });
  const features = featuresQuery.data ?? [];
  const metrics = metricsQuery.data ?? [];
  const featureOf = (id: string | null) => features.find((f) => f.id === id);
  const issuesOf = (v: ExperimentValues) => draftIssues(v, { isEdit, valueType: featureOf(v.featureId)?.valueType });

  const toInput = (v: ExperimentValues) => {
    const primary = metrics.find((m) => m.id === v.primaryMetricId);
    const plan = planOf(v, primary);
    return {
      name: v.name.trim(),
      hypothesis: v.hypothesis.trim(),
      featureId: v.featureId ?? "",
      environmentIds: [...v.environmentIds],
      analysisEnvironmentId: v.environmentIds.includes(v.analysisEnvironmentId) ? v.analysisEnvironmentId : (v.environmentIds[0] ?? ""),
      hashAttribute: v.hashAttribute.trim(),
      variations: v.variations.map((x) => ({ key: x.key, name: x.name.trim() || x.key, value: x.value })),
      coverage: v.coverage,
      weights: weightsOf(v),
      conditions: v.conditions.map((c) => ({ ...c, values: [...c.values] })),
      dataSourceId: primary?.dataSourceId ?? BUILTIN_DATA_SOURCE_ID,
      primaryMetricId: v.primaryMetricId,
      secondaryMetricIds: [...v.secondaryMetricIds],
      guardrailMetricIds: [...v.guardrailMetricIds],
      stats: { ...v.stats, sequentialTuning: plan.total ?? v.stats.sequentialTuning },
      plan: {
        mde: v.mdePercent / 100,
        sampleSizePerVariation: plan.perVariation,
        dailyTraffic: Number.isFinite(v.dailyTraffic) ? v.dailyTraffic : null,
      },
    };
  };

  const [defaultValues] = useState(() => toValues(experiment, current?.id ?? "", initialFeatureId));
  const form = useAppForm({
    defaultValues,
    validators: {
      // One pass over the whole draft: several checks span fields (unique variation keys, weights)
      onChange: ({ value }) => {
        const fields: Record<string, string> = {};
        for (const issue of issuesOf(value)) fields[issue.field] ??= issue.message;
        return Object.keys(fields).length === 0 ? undefined : { fields };
      },
    },
    onSubmit: async ({ value, formApi }) => {
      let saved: Experiment;
      try {
        saved =
          experiment === undefined
            ? await client.experiments.create({ key: value.key, ...toInput(value) })
            : await client.experiments.update({ id: experiment.id, ...toInput(value) });
      } catch (error) {
        // "An experiment with key … already exists" belongs under the key field
        setServerError(formApi, error, !isEdit && /already exists/i.test(errorMessage(error)) ? "key" : undefined);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: orpc.experiments.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.features.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
      onSaved(saved);
    },
  });
  const d = useStore(form.store, (s) => s.values);
  const attempted = useStore(form.store, (s) => s.submissionAttempts > 0);
  const isSubmitting = useStore(form.store, (s) => s.isSubmitting);

  useEffect(() => {
    // Draft environments default to the selected one once environments load
    if (!isEdit && current !== null && form.getFieldValue("environmentIds").length === 0 && form.getFieldValue("analysisEnvironmentId") === "") {
      form.setFieldValue("environmentIds", [current.id]);
      form.setFieldValue("analysisEnvironmentId", current.id);
    }
    // The checks read the loaded flags too: errors computed before they arrived are stale
    if (form.state.isTouched) void form.validate("change");
  }, [featuresQuery.data, current, isEdit, form]);

  const feature = featureOf(d.featureId);
  const primary = metrics.find((m) => m.id === d.primaryMetricId);
  const dataSourceId = primary?.dataSourceId ?? BUILTIN_DATA_SOURCE_ID;
  const plan = planOf(d, primary);
  const weights = weightsOf(d);
  const total = totalPercent(d);

  const offIn = environments.filter(
    (e) => d.environmentIds.includes(e.id) && feature !== undefined && feature.environments.find((c) => c.environmentId === e.id)?.enabled !== true,
  );
  const issues = issuesOf(d);
  const blocking: ReadonlyArray<[CheckId, string]> = [
    ["name", "step-hypothesis"],
    ["key", "step-hypothesis"],
    ["flag", "step-flag"],
    ["values", "step-flag"],
    ["keys", "step-flag"],
    ["weights", "step-flag"],
    ["targeting", "step-traffic"],
    ["envs", "step-traffic"],
    ["hash", "step-traffic"],
  ];
  const checks: Array<Check> = [
    ...blocking.map(([id, section]) => ({ id, label: t(`form.checks.${id}`), ok: !issues.some((i) => i.check === id), blocking: true, section })),
    { id: "primary", label: t("form.checks.primary"), ok: primary !== undefined, blocking: false, section: "step-metrics" },
    { id: "plan", label: t("form.checks.plan"), ok: plan.perVariation !== null, blocking: false, section: "step-plan" },
  ];
  const blocked = issues.length > 0;
  const sameSource = metrics.filter((m) => m.dataSourceId === dataSourceId);

  return (
    <form noValidate onSubmit={submitHandler(form)} className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Step n={1} id="step-hypothesis" title={t("form.hypothesis.title")} description={t("form.hypothesis.description")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <form.AppField
              name="name"
              listeners={{
                onChange: ({ value }) => {
                  // Suggest the key until the user edits it; a name with no Latin spelling gives "" and leaves the key alone
                  const slug = slugify(value);
                  if (!isEdit && slug !== "" && form.getFieldMeta("key")?.isDirty !== true) form.setFieldValue("key", slug, { dontUpdateMeta: true });
                },
              }}
            >
              {(field) => {
                const error = shownError(field.state.meta);
                return (
                  <TextField
                    value={field.state.value}
                    onChange={field.handleChange}
                    onBlur={field.handleBlur}
                    isInvalid={error !== null}
                    isRequired
                    autoFocus={!isEdit}
                  >
                    <Label>{t("form.hypothesis.name")}</Label>
                    <Input placeholder={t("form.hypothesis.namePlaceholder")} />
                    <FieldError>{error}</FieldError>
                  </TextField>
                );
              }}
            </form.AppField>
            <form.AppField name="key">
              {(field) => {
                const error = shownError(field.state.meta);
                return (
                  <TextField
                    value={field.state.value}
                    onChange={field.handleChange}
                    onBlur={field.handleBlur}
                    isInvalid={error !== null}
                    isReadOnly={isEdit}
                    isRequired={!isEdit}
                  >
                    <Label>{t("form.hypothesis.key")}</Label>
                    <Input placeholder="one-page-checkout" spellCheck={false} className="font-mono" />
                    <Description>{isEdit ? t("form.hypothesis.keyLocked") : t("form.hypothesis.keyHelp")}</Description>
                    <FieldError>{error}</FieldError>
                  </TextField>
                );
              }}
            </form.AppField>
          </div>
          <form.AppField name="hypothesis">
            {(field) => (
              <TextField value={field.state.value} onChange={field.handleChange} onBlur={field.handleBlur}>
                <Label>{t("form.hypothesis.hypothesis")}</Label>
                <TextArea rows={3} className="resize-y" placeholder={t("form.hypothesis.hypothesisPlaceholder")} />
                <Description>{t("form.hypothesis.hypothesisHelp")}</Description>
              </TextField>
            )}
          </form.AppField>
        </Step>

        <Step n={2} id="step-flag" title={t("form.flag.title")} description={t("form.flag.description")}>
          <form.AppField
            name="featureId"
            listeners={{
              onChange: ({ value }) => {
                const fresh = variationsFor(featureOf(value));
                form.setFieldValue("variations", (vs) => vs.map((v, i) => ({ ...v, value: fresh[Math.min(i, 1)]?.value ?? "" })));
              },
            }}
          >
            {(field) => {
              const error = shownError(field.state.meta);
              return (
                <ComboBox
                  value={field.state.value}
                  onChange={(k) => field.handleChange(typeof k === "string" ? k : null)}
                  onBlur={field.handleBlur}
                  isInvalid={error !== null}
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
                    <FieldError>{error}</FieldError>
                  )}
                </ComboBox>
              );
            }}
          </form.AppField>

          {feature !== undefined && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-label font-medium">{t("form.flag.variations")}</p>
                <form.AppField
                  name="evenSplit"
                  listeners={{
                    onChange: () =>
                      form.setFieldValue("variations", (vs) => {
                        const even = evenPercents(vs.length);
                        return vs.map((v, i) => ({ ...v, percent: even[i] ?? 0 }));
                      }),
                  }}
                >
                  {(field) => (
                    <Switch size="sm" isSelected={field.state.value} onChange={field.handleChange}>
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                        <span className="text-label">{t("form.flag.evenSplit")}</span>
                      </Switch.Content>
                    </Switch>
                  )}
                </form.AppField>
              </div>
              <form.AppField name="variations" mode="array">
                {(variationsField) => (
                  <>
                    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                      {d.variations.map((v, i) => (
                        <li key={i} className="flex flex-col gap-3 p-3 sm:p-4">
                          <div className="flex flex-wrap items-start gap-2">
                            <span className="mt-3.5 mr-1">
                              <VariationSwatch index={i} />
                            </span>
                            <form.AppField name={`variations[${i}].name`}>
                              {(field) => (
                                <TextField
                                  aria-label={t("form.flag.variationName", { n: i + 1 })}
                                  value={field.state.value}
                                  onChange={field.handleChange}
                                  onBlur={field.handleBlur}
                                  className="min-w-0 flex-1 basis-32"
                                >
                                  <Input placeholder={i === 0 ? t("form.defaults.control") : t("form.defaults.treatment")} />
                                </TextField>
                              )}
                            </form.AppField>
                            <form.AppField name={`variations[${i}].key`}>
                              {(field) => {
                                // Shown while typing: these keys start valid, so any message is about the current edit
                                const error = errorText(field.state.meta.errors);
                                return (
                                  <TextField
                                    aria-label={t("form.flag.variationKey", { n: i + 1 })}
                                    value={field.state.value}
                                    onChange={field.handleChange}
                                    onBlur={field.handleBlur}
                                    isInvalid={error !== ""}
                                    className="min-w-0 flex-1 basis-32"
                                  >
                                    <Input className="font-mono" spellCheck={false} />
                                    <FieldError>{error}</FieldError>
                                  </TextField>
                                );
                              }}
                            </form.AppField>
                            <form.AppField name={`variations[${i}].percent`}>
                              {(field) => (
                                <NumberField
                                  aria-label={t("form.flag.variationWeight", { n: i + 1 })}
                                  value={d.evenSplit ? Number((100 / d.variations.length).toFixed(1)) : field.state.value}
                                  onChange={field.handleChange}
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
                              )}
                            </form.AppField>
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={t("form.flag.remove", { name: v.name || t("form.flag.variationN", { n: i + 1 }) })}
                              isDisabled={i === 0 || d.variations.length <= 2}
                              onPress={() => variationsField.removeValue(i)}
                              className="mt-0.5 text-muted"
                            >
                              <X className="size-4" />
                            </Button>
                          </div>
                          <div className="sm:pl-5.5">
                            <form.AppField name={`variations[${i}].value`}>
                              {(field) => (
                                <ValueInput
                                  valueType={feature.valueType}
                                  value={field.state.value}
                                  onChange={field.handleChange}
                                  label={i === 0 ? t("form.flag.valueBaseline") : t("form.flag.value")}
                                />
                              )}
                            </form.AppField>
                            {i > 0 && v.value === d.variations[0]?.value && (
                              <p className="mt-1 text-meta text-muted">
                                {t("form.flag.sameValue", { name: d.variations[0]?.name || t("form.flag.controlFallback") })}
                              </p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <Button
                        size="sm"
                        variant="outline"
                        onPress={() => {
                          const n = d.variations.length;
                          variationsField.pushValue({
                            key: `treatment-${n}`,
                            name: t("form.defaults.treatmentN", { n }),
                            value: d.variations[n - 1]?.value ?? defaultValueFor(feature.valueType),
                            // Even split ignores it; switching even split off spreads the percentages again
                            percent: 0,
                          });
                        }}
                        isDisabled={d.variations.length >= MAX_VARIATIONS}
                      >
                        <Plus className="size-4" />
                        {t("form.flag.add")}
                      </Button>
                      <p className={`font-mono text-label tabular ${Math.abs(total - 100) < 0.01 ? "text-muted" : "text-danger"}`} aria-live="polite">
                        {t(Math.abs(total - 100) < 0.01 ? "form.flag.total" : "form.flag.totalInvalid", { percent: Number(total.toFixed(2)) })}
                      </p>
                    </div>
                  </>
                )}
              </form.AppField>
            </div>
          )}
        </Step>

        <Step n={3} id="step-traffic" title={t("form.traffic.title")} description={t("form.traffic.description")}>
          <form.AppField name="conditions">
            {(field) => (
              <div className="flex flex-col gap-2">
                <p className="text-label font-medium">{t("form.traffic.whoCanEnter")}</p>
                <ConditionBuilder value={field.state.value} onChange={field.handleChange} />
                {/* Format problems show inline in the builder; missing parts are reported once a save was tried */}
                {attempted && field.state.meta.errors.length > 0 && <p className="text-meta text-danger">{errorText(field.state.meta.errors)}</p>}
              </div>
            )}
          </form.AppField>
          <form.AppField name="coverage">
            {(field) => <CoverageField value={field.state.value} onChange={field.handleChange} description={t("form.traffic.coverageHelp")} />}
          </form.AppField>
          <div className="grid gap-4 sm:grid-cols-2">
            <form.AppField
              name="environmentIds"
              listeners={{
                onChange: ({ value }) => {
                  // Never back to "": that would re-trigger the default-environment fill
                  const analysis = form.getFieldValue("analysisEnvironmentId");
                  if (!value.includes(analysis) && value[0] !== undefined) form.setFieldValue("analysisEnvironmentId", value[0]);
                },
              }}
            >
              {(field) => {
                const error = shownError(field.state.meta);
                return (
                  <CheckboxGroup value={[...field.state.value]} onChange={field.handleChange} isInvalid={error !== null}>
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
                    <FieldError>{error}</FieldError>
                  </CheckboxGroup>
                );
              }}
            </form.AppField>
            <div className="flex flex-col gap-4">
              <form.AppField name="analysisEnvironmentId">
                {(field) => (
                  <field.SelectField
                    label={t("form.traffic.analyzeFrom")}
                    description={t("form.traffic.analyzeHelp")}
                    isDisabled={d.environmentIds.length === 0}
                    options={environments.filter((e) => d.environmentIds.includes(e.id)).map((e) => ({ id: e.id, label: e.name, textValue: e.name }))}
                  />
                )}
              </form.AppField>
              <form.AppField name="hashAttribute">
                {(field) => {
                  const error = shownError(field.state.meta);
                  return (
                    <TextField value={field.state.value} onChange={field.handleChange} onBlur={field.handleBlur} isInvalid={error !== null} isRequired>
                      <Label>{t("form.traffic.assignBy")}</Label>
                      <Input className="font-mono" spellCheck={false} />
                      <Description>{t("form.traffic.assignByHelp")}</Description>
                      <FieldError>{error}</FieldError>
                    </TextField>
                  );
                }}
              </form.AppField>
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
          <form.AppField name="primaryMetricId">
            {(field) => (
              <ComboBox value={field.state.value} onChange={(k) => field.handleChange(typeof k === "string" ? k : null)} className="sm:max-w-md">
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
                  {metrics.length === 0 && !metricsQuery.isPending ? t("form.metrics.noMetrics") : t("form.metrics.primaryHelp")}
                </Description>
              </ComboBox>
            )}
          </form.AppField>
          <div className="grid gap-4 sm:grid-cols-2">
            <form.AppField name="secondaryMetricIds">
              {(field) => (
                <MetricMultiSelect
                  label={t("form.metrics.secondary")}
                  description={t("form.metrics.secondaryHelp")}
                  value={field.state.value}
                  onChange={field.handleChange}
                  options={sameSource.filter((m) => m.id !== d.primaryMetricId && !d.guardrailMetricIds.includes(m.id))}
                />
              )}
            </form.AppField>
            <form.AppField name="guardrailMetricIds">
              {(field) => (
                <MetricMultiSelect
                  label={t("form.metrics.guardrails")}
                  description={t("form.metrics.guardrailsHelp")}
                  value={field.state.value}
                  onChange={field.handleChange}
                  options={sameSource.filter((m) => m.id !== d.primaryMetricId && !d.secondaryMetricIds.includes(m.id))}
                />
              )}
            </form.AppField>
          </div>
        </Step>

        <Step n={5} id="step-plan" title={t("form.plan.title")} description={t("form.plan.description")}>
          <PowerPlanner plan={plan} variations={d.variations.length}>
            {plan.kind === "proportion" ? (
              <form.AppField name="baselineRate">
                {(field) => (
                  <PlanNumber
                    label={t("form.plan.baselineRate")}
                    value={field.state.value}
                    onChange={field.handleChange}
                    suffix="%"
                    step={0.1}
                    description={primary === undefined ? t("form.plan.baselineRateHelp") : t("form.plan.baselineRateOf", { metric: primary.name })}
                  />
                )}
              </form.AppField>
            ) : (
              <>
                <form.AppField name="baselineMean">
                  {(field) => <PlanNumber label={t("form.plan.baselineMean")} value={field.state.value} onChange={field.handleChange} step={0.1} />}
                </form.AppField>
                <form.AppField name="baselineStdDev">
                  {(field) => (
                    <PlanNumber
                      label={t("form.plan.stdDev")}
                      value={field.state.value}
                      onChange={field.handleChange}
                      step={0.1}
                      description={t("form.plan.stdDevHelp")}
                    />
                  )}
                </form.AppField>
              </>
            )}
            <form.AppField name="dailyTraffic">
              {(field) => (
                <PlanNumber
                  label={t("form.plan.dailyUsers")}
                  value={field.state.value}
                  onChange={field.handleChange}
                  suffix={t("form.plan.perDay")}
                  description={t("form.plan.dailyUsersHelp")}
                />
              )}
            </form.AppField>
            <form.AppField name="mdePercent">
              {(field) => (
                <PlanNumber
                  label={t("form.plan.mde")}
                  value={field.state.value}
                  onChange={field.handleChange}
                  suffix={t("form.plan.relative")}
                  step={0.5}
                  description={t("form.plan.mdeHelp")}
                />
              )}
            </form.AppField>
          </PowerPlanner>
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
              <form.AppField name="stats">{(field) => <StatsFields stats={field.state.value} onChange={field.handleChange} />}</form.AppField>
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
                  c.ok ? "text-muted" : attempted && c.blocking ? "text-danger" : "text-foreground"
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
        <form.AppForm>
          <form.FormError />
        </form.AppForm>
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <Button type="submit" size="sm" fullWidth isPending={isSubmitting} isDisabled={attempted && blocked}>
            {isEdit ? t("form.summary.save") : t("form.summary.create")}
          </Button>
          <Button size="sm" variant="ghost" fullWidth onPress={onCancel} isDisabled={isSubmitting}>
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

/** Planner inputs (children) beside the resulting sample size and duration */
function PowerPlanner({ plan, variations, children }: { plan: ReturnType<typeof planOf>; variations: number; children: ReactNode }) {
  const { t } = useTranslation("experiments");
  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]">
      <div className="grid content-start gap-4 sm:grid-cols-2">{children}</div>
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
