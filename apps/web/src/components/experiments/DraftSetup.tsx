import { BUILTIN_DATA_SOURCE_ID } from "@furca/core/datasources/DataSource";
import { defaultStatsSettings, type Experiment } from "@furca/core/experiments/Experiment";
import type { Feature } from "@furca/core/features/Feature";
import { Button, Checkbox, CheckboxGroup, Description, FieldError, Input, Label, NumberField, Switch, TextField, toast } from "@heroui/react";
import { useStore } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Circle, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ValueInput, ValuePreview, defaultValueFor } from "~/components/flags/ValueInput";
import { errorText, setServerError, submitHandler, useAppForm } from "~/components/form/form";
import { formatCount, formatList, formatPercent } from "~/components/results/format";
import { ConditionBuilder, TagInput, useConditionsSummary } from "~/components/targeting/ConditionBuilder";
import { NamespaceSlice } from "~/components/namespaces/NamespaceSlice";
import { HelpTip } from "~/components/ui/HelpTip";
import { Panel } from "~/components/ui/primitives";
import { Segmented } from "~/components/ui/Segmented";
import { i18n } from "~/i18n";
import { useEnvironment } from "~/lib/environment";
import { usePermissions } from "~/lib/permissions";
import { client, errorMessage, orpc } from "~/lib/rpc";
import {
  draftIssues,
  LONG_PLAN_DAYS,
  planOf,
  savedPlanDays,
  type SectionId,
  startChecks,
  toInput,
  toValues,
  totalPercent,
  variationsFor,
} from "./draft";
import { FlagPicker, MetricListPicker, MetricPicker } from "./ExperimentForm";
import { CoverageField, evenPercents, MAX_VARIATIONS, shownError, VariationSwatch, weightLabel } from "./parts";

const BASELINE_DAYS = 28;

/**
 * The draft's setup as one sentence per section, each with a "Change" button that opens its editor
 * in place (one at a time), beside a checklist that separates what blocks starting from advice
 */
export function DraftSetup({ experiment: x, feature: loadedFeature }: { experiment: Experiment; feature: Feature | undefined }) {
  const { t } = useTranslation(["experiments", "common"]);
  const queryClient = useQueryClient();
  const { canEdit } = usePermissions();
  const { environments } = useEnvironment();
  const conditionsSummary = useConditionsSummary();
  const featuresQuery = useQuery(orpc.features.list.queryOptions({ input: { includeArchived: false } }));
  const metricsQuery = useQuery({ ...orpc.metrics.list.queryOptions({ input: { includeArchived: true } }), refetchOnWindowFocus: true });
  const namespacesQuery = useQuery(orpc.namespaces.list.queryOptions());
  const [open, setOpen] = useState<SectionId | null>(null);

  const features = featuresQuery.data ?? [];
  const allMetrics = metricsQuery.data ?? [];
  const metrics = allMetrics.filter((m) => !m.archived);
  const featureOf = (id: string | null) => features.find((f) => f.id === id) ?? (loadedFeature?.id === id ? loadedFeature : undefined);
  const metricOf = (id: string | null) => allMetrics.find((m) => m.id === id);

  // Stable defaults: each section's open / cancel / save resets the form to the saved draft explicitly
  const [initial] = useState(() => toValues(x));
  const form = useAppForm({
    defaultValues: initial,
    validators: {
      // One pass over the whole draft: several checks span fields (unique variation keys, weights)
      onChange: ({ value }) => {
        const fields: Record<string, string> = {};
        for (const issue of draftIssues(value, { isEdit: true, valueType: featureOf(value.featureId)?.valueType })) fields[issue.field] ??= issue.message;
        return Object.keys(fields).length === 0 ? undefined : { fields };
      },
    },
    onSubmit: async ({ value, formApi }) => {
      try {
        const next = await client.experiments.update({ id: x.id, ...toInput(value, metricOf(value.primaryMetricId)) });
        queryClient.setQueryData(orpc.experiments.get.queryKey({ input: { id: next.id } }), next);
        void queryClient.invalidateQueries({ queryKey: orpc.experiments.list.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.features.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        formApi.reset(toValues(next));
        setOpen(null);
        toast.success(i18n.t("experiments:detail.toast.saved"));
      } catch (error) {
        setServerError(formApi, error);
      }
    },
  });
  const d = useStore(form.store, (s) => s.values);
  const attempted = useStore(form.store, (s) => s.submissionAttempts > 0);
  const isSubmitting = useStore(form.store, (s) => s.isSubmitting);

  // Opening a section starts from the saved draft, so a cancelled edit never leaks into the next one
  const openSection = (id: SectionId) => {
    form.reset(toValues(x));
    setOpen(id);
    requestAnimationFrame(() => document.getElementById(`section-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  const cancel = () => {
    form.reset(toValues(x));
    setOpen(null);
  };

  // ---- Saved state: summaries and the checklist describe what Start would use
  const feature = featureOf(x.featureId);
  const envName = (id: string) => environments.find((e) => e.id === id)?.name ?? t("setup.deletedEnvironment");
  const flagOffIn = x.environmentIds.filter((id) => feature !== undefined && feature.environments.find((c) => c.environmentId === id)?.enabled !== true).map(envName);
  const saved = toValues(x);
  const planDays = savedPlanDays(x);
  const checks = startChecks(saved, { valueType: feature?.valueType, flagOffIn, planDays, planned: x.plan.sampleSizePerVariation !== null });
  const flagged = new Set([...checks.blockers, ...checks.advice.filter((a) => a.id === "sameValue" || a.id === "flagOff" || a.id === "longPlan")].map((c) => c.section));

  // ---- Planner: prefill the baseline from real data when the primary is a built-in proportion / mean metric
  const primary = metricOf(d.primaryMetricId);
  const measurable = primary !== undefined && primary.dataSourceId === BUILTIN_DATA_SOURCE_ID && primary.definition._tag === "event" && primary.type !== "ratio";
  const baseline = useQuery({
    ...orpc.metrics.baseline.queryOptions({ input: { metricId: primary?.id ?? "", environmentId: d.analysisEnvironmentId, days: BASELINE_DAYS } }),
    enabled: open === "plan" && measurable && d.analysisEnvironmentId !== "",
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    const b = baseline.data;
    if (open !== "plan" || b == null) return;
    const fill = (name: "baselineRate" | "baselineMean" | "baselineStdDev" | "dailyTraffic", v: number | null) => {
      if (v !== null && Number.isFinite(v) && !Number.isFinite(form.getFieldValue(name))) form.setFieldValue(name, v, { dontUpdateMeta: true });
    };
    fill("baselineRate", b.rate === null ? null : Number((b.rate * 100).toFixed(2)));
    fill("baselineMean", b.mean === null ? null : Number(b.mean.toPrecision(4)));
    fill("baselineStdDev", b.stdDev === null ? null : Number(b.stdDev.toPrecision(4)));
    fill("dailyTraffic", Math.round(b.dailyUsers));
  }, [baseline.data, open, form]);

  const plan = planOf(d, primary);
  const sameSource = metrics.filter((m) => m.dataSourceId === (primary?.dataSourceId ?? BUILTIN_DATA_SOURCE_ID));
  const editFeature = featureOf(d.featureId);

  // ---- One sentence per section
  const variationSummary = (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <code className="font-mono">{feature?.key ?? t("detail.flagFallback")}</code>
      <span aria-hidden="true" className="text-muted">·</span>
      {x.variations.map((v, i) => (
        <span key={v.key} className="inline-flex items-baseline gap-1.5">
          <VariationSwatch index={i} />
          {v.name}
          {feature === undefined ? <code className="font-mono">{v.value}</code> : <ValuePreview valueType={feature.valueType} value={v.value} />}
          {i < x.variations.length - 1 && <span aria-hidden="true" className="text-muted">·</span>}
        </span>
      ))}
      <span className="text-muted">{saved.evenSplit ? t("draft.summary.even") : `(${x.weights.map(weightLabel).join(" / ")})`}</span>
    </span>
  );
  const targetingSummary = [
    x.conditions.length === 0 ? t("draft.summary.everyone") : conditionsSummary(x.conditions),
    formatPercent(x.coverage, 0),
    formatList(x.environmentIds.map(envName)) || "–",
  ].join(" · ");
  const metricName = (id: string) => metricOf(id)?.name ?? t("setup.deletedMetric");
  const metricsSummary = [
    x.primaryMetricId === null ? t("draft.summary.primaryMissing") : t("draft.summary.primary", { name: metricName(x.primaryMetricId) }),
    x.guardrailMetricIds.length === 0 ? t("draft.summary.noGuardrails") : t("draft.summary.guardrails", { names: formatList(x.guardrailMetricIds.map(metricName)) }),
    x.secondaryMetricIds.length === 0 ? null : t("draft.summary.secondary", { names: formatList(x.secondaryMetricIds.map(metricName)) }),
  ]
    .filter((p) => p !== null)
    .join(" · ");
  const planSummary =
    x.plan.sampleSizePerVariation === null
      ? t("draft.summary.planUnset")
      : [
          t("draft.summary.mde", { mde: formatPercent(x.plan.mde) }),
          t("draft.summary.perVariation", { n: formatCount(x.plan.sampleSizePerVariation) }),
          planDays === null ? null : t("draft.summary.days", { count: planDays }),
        ]
          .filter((p) => p !== null)
          .join(" · ");
  const namespaceName = (id: string) => namespacesQuery.data?.find((n) => n.namespace.id === id)?.namespace.name ?? "…";
  const statsSummary = (s: Experiment["stats"]) =>
    [
      s.engine === "bayesian" ? t("form.stats.bayesian") : s.sequential ? t("form.stats.sequential") : t("form.stats.fixed"),
      `${Math.round((1 - s.alpha) * 100)}%`,
      s.cuped ? t("form.stats.cupedOn") : t("form.stats.cupedOff"),
      s.engine === "frequentist" ? (s.correction === "holm" ? t("draft.summary.holmOn") : t("draft.summary.holmOff")) : null,
    ]
      .filter((p) => p !== null)
      .join(" · ");
  const defaults = defaultStatsSettings();
  const statsAreDefault = (["engine", "sequential", "alpha", "cuped", "correction"] as const).every((k) => x.stats[k] === defaults[k]);

  const section = (
    id: SectionId,
    props: { title: string; help?: ReactNode; summary: ReactNode; hint?: ReactNode; muted?: boolean },
    editor: () => ReactNode,
  ) => (
    <Section
      key={id}
      id={id}
      {...props}
      attention={flagged.has(id)}
      isOpen={open === id}
      canEdit={canEdit}
      isLocked={open !== null && open !== id}
      onOpen={() => openSection(id)}
      onCancel={cancel}
      isSubmitting={isSubmitting}
      footer={
        <form.AppForm>
          <form.FormError />
        </form.AppForm>
      }
    >
      {open === id && editor()}
    </Section>
  );

  return (
    <form noValidate onSubmit={submitHandler(form)} className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel>
          <ul className="divide-y divide-border">
            {section(
              "hypothesis",
              {
                title: t("draft.sections.hypothesis"),
                summary: x.hypothesis.trim() === "" ? t("draft.summary.noHypothesis") : <span className="line-clamp-3 whitespace-pre-wrap">{x.hypothesis}</span>,
                muted: x.hypothesis.trim() === "",
                hint: x.hypothesis.trim() === "" ? t("draft.summary.hypothesisHint") : undefined,
              },
              () => (
                <>
                  <form.AppField name="name">{(field) => <field.TextField label={t("form.hypothesis.name")} className="sm:max-w-md" />}</form.AppField>
                  <form.AppField name="hypothesis">
                    {(field) => (
                      <field.TextAreaField
                        label={t("form.hypothesis.hypothesis")}
                        description={t("form.hypothesis.hypothesisHelp")}
                        placeholder={t("form.hypothesis.hypothesisPlaceholder")}
                        rows={4}
                      />
                    )}
                  </form.AppField>
                </>
              ),
            )}
            {section("variations", { title: t("draft.sections.variations"), summary: variationSummary }, () => (
              <>
                <form.AppField
                  name="featureId"
                  listeners={{
                    onChange: ({ value }) => {
                      const fresh = variationsFor(featureOf(value));
                      form.setFieldValue("variations", (vs) => vs.map((v, i) => ({ ...v, value: fresh[Math.min(i, 1)]?.value ?? "" })));
                    },
                  }}
                >
                  {(field) => (
                    <FlagPicker
                      value={field.state.value}
                      onChange={field.handleChange}
                      onBlur={field.handleBlur}
                      error={shownError(field.state.meta) ?? undefined}
                      features={features}
                      isPending={featuresQuery.isPending}
                      loadError={featuresQuery.error === null ? null : errorMessage(featuresQuery.error)}
                    />
                  )}
                </form.AppField>
                {editFeature !== undefined && (
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
                                <div className="flex items-center justify-between gap-2">
                                  <p className="flex items-center gap-2 text-label font-medium">
                                    <VariationSwatch index={i} />
                                    {i === 0 ? t("draft.variations.control") : t("form.flag.variationN", { n: i + 1 })}
                                  </p>
                                  <Button
                                    isIconOnly
                                    size="sm"
                                    variant="ghost"
                                    aria-label={t("form.flag.remove", { name: v.name || t("form.flag.variationN", { n: i + 1 }) })}
                                    isDisabled={i === 0 || d.variations.length <= 2}
                                    onPress={() => variationsField.removeValue(i)}
                                    className="text-muted"
                                  >
                                    <X className="size-4" />
                                  </Button>
                                </div>
                                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem]">
                                  <form.AppField name={`variations[${i}].name`}>
                                    {(field) => (
                                      <TextField value={field.state.value} onChange={field.handleChange} onBlur={field.handleBlur}>
                                        <Label>{t("draft.variations.name")}</Label>
                                        <Input />
                                      </TextField>
                                    )}
                                  </form.AppField>
                                  <form.AppField name={`variations[${i}].key`}>
                                    {(field) => {
                                      // Shown while typing: these keys start valid, so any message is about the current edit
                                      const error = errorText(field.state.meta.errors);
                                      return (
                                        <TextField value={field.state.value} onChange={field.handleChange} onBlur={field.handleBlur} isInvalid={error !== ""}>
                                          <Label>{t("draft.variations.key")}</Label>
                                          <Input className="font-mono" spellCheck={false} />
                                          <FieldError>{error}</FieldError>
                                        </TextField>
                                      );
                                    }}
                                  </form.AppField>
                                  <form.AppField name={`variations[${i}].percent`}>
                                    {(field) => (
                                      <NumberField
                                        value={d.evenSplit ? Number((100 / d.variations.length).toFixed(1)) : field.state.value}
                                        onChange={field.handleChange}
                                        isDisabled={d.evenSplit}
                                        minValue={0}
                                        maxValue={100}
                                        step={0.1}
                                      >
                                        <Label>{t("draft.variations.weight")}</Label>
                                        <NumberField.Group className="grid-cols-[1fr_auto]">
                                          <NumberField.Input className="text-right tabular" />
                                          <span className="pr-3 text-label text-muted">%</span>
                                        </NumberField.Group>
                                      </NumberField>
                                    )}
                                  </form.AppField>
                                </div>
                                <div>
                                  <form.AppField name={`variations[${i}].value`}>
                                    {(field) => (
                                      <ValueInput
                                        valueType={editFeature.valueType}
                                        value={field.state.value}
                                        onChange={field.handleChange}
                                        label={i === 0 ? t("form.flag.valueBaseline") : t("form.flag.value")}
                                      />
                                    )}
                                  </form.AppField>
                                  {i > 0 && v.value === d.variations[0]?.value && (
                                    <p className="mt-1 flex items-center gap-1.5 text-meta text-foreground">
                                      <AlertTriangle className="size-3.5 shrink-0 text-health" aria-hidden="true" />
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
                                  value: d.variations[n - 1]?.value ?? defaultValueFor(editFeature.valueType),
                                  // Even split ignores it; switching even split off spreads the percentages again
                                  percent: 0,
                                });
                              }}
                              isDisabled={d.variations.length >= MAX_VARIATIONS}
                            >
                              <Plus className="size-4" />
                              {t("form.flag.add")}
                            </Button>
                            <p
                              className={`font-mono text-label tabular ${Math.abs(totalPercent(d) - 100) < 0.01 ? "text-muted" : "text-danger"}`}
                              aria-live="polite"
                            >
                              {t(Math.abs(totalPercent(d) - 100) < 0.01 ? "form.flag.total" : "form.flag.totalInvalid", { percent: Number(totalPercent(d).toFixed(2)) })}
                            </p>
                          </div>
                        </>
                      )}
                    </form.AppField>
                  </div>
                )}
              </>
            ))}
            {section("targeting", { title: t("draft.sections.targeting"), summary: targetingSummary }, () => (
              <>
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
                            <div className="flex items-center gap-0.5">
                              <Label>{t("form.traffic.assignBy")}</Label>
                              <HelpTip term={t("form.traffic.assignBy")}>{t("draft.help.hashAttribute")}</HelpTip>
                            </div>
                            <Input className="font-mono" spellCheck={false} />
                            <Description>{t("form.traffic.assignByHelp")}</Description>
                            <FieldError>{error}</FieldError>
                          </TextField>
                        );
                      }}
                    </form.AppField>
                  </div>
                </div>
              </>
            ))}
            {section(
              "metrics",
              { title: t("draft.sections.metrics"), help: t("draft.help.metrics"), summary: metricsSummary, hint: x.guardrailMetricIds.length === 0 ? t("draft.summary.guardrailsHint") : undefined },
              () => (
                <>
                  <form.AppField name="primaryMetricId">
                    {(field) => (
                      <MetricPicker
                        label={t("form.metrics.primary")}
                        description={t("form.metrics.primaryHelp")}
                        help={t("draft.help.primary")}
                        value={field.state.value}
                        onChange={field.handleChange}
                        metrics={metrics}
                        isPending={metricsQuery.isPending}
                      />
                    )}
                  </form.AppField>
                  <form.AppField name="guardrailMetricIds">
                    {(field) => (
                      <MetricListPicker
                        label={t("form.metrics.guardrails")}
                        description={t("form.metrics.guardrailsHelp")}
                        help={t("draft.help.guardrail")}
                        value={field.state.value}
                        onChange={field.handleChange}
                        options={sameSource.filter((m) => m.id !== d.primaryMetricId && !d.secondaryMetricIds.includes(m.id))}
                        all={allMetrics}
                        canCreate={(primary?.dataSourceId ?? BUILTIN_DATA_SOURCE_ID) === BUILTIN_DATA_SOURCE_ID}
                      />
                    )}
                  </form.AppField>
                  <form.AppField name="secondaryMetricIds">
                    {(field) => (
                      <MetricListPicker
                        label={t("form.metrics.secondary")}
                        description={t("form.metrics.secondaryHelp")}
                        value={field.state.value}
                        onChange={field.handleChange}
                        options={sameSource.filter((m) => m.id !== d.primaryMetricId && !d.guardrailMetricIds.includes(m.id))}
                        all={allMetrics}
                        canCreate={(primary?.dataSourceId ?? BUILTIN_DATA_SOURCE_ID) === BUILTIN_DATA_SOURCE_ID}
                      />
                    )}
                  </form.AppField>
                </>
              ),
            )}
            {section(
              "plan",
              {
                title: t("draft.sections.plan"),
                help: t("draft.help.plan"),
                summary: planSummary,
                muted: x.plan.sampleSizePerVariation === null,
                hint: x.plan.sampleSizePerVariation === null ? t("draft.summary.planHint") : undefined,
              },
              () => (
                <>
                  <PowerPlanner plan={plan} variations={d.variations.length} onUseMde={(mde) => form.setFieldValue("mdePercent", mde)}>
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
                            <PlanNumber label={t("form.plan.stdDev")} value={field.state.value} onChange={field.handleChange} step={0.1} description={t("form.plan.stdDevHelp")} />
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
                  <p className="text-meta text-muted" aria-live="polite">
                    {primary === undefined
                      ? t("draft.plan.noPrimary")
                      : !measurable
                        ? primary.dataSourceId === BUILTIN_DATA_SOURCE_ID
                          ? t("draft.plan.ratio")
                          : t("draft.plan.warehouse")
                        : baseline.isPending
                          ? t("draft.plan.loading")
                          : baseline.data == null
                            ? t("draft.plan.noData", { environment: envName(d.analysisEnvironmentId) })
                            : t("draft.plan.fromData", {
                                count: baseline.data.days,
                                environment: envName(d.analysisEnvironmentId),
                                users: formatCount(baseline.data.users),
                              })}
                  </p>
                </>
              ),
            )}
          </ul>
        </Panel>

        <Panel>
          <div className="border-b border-border px-5 py-3">
            <h2 className="text-label font-medium">{t("draft.sections.advanced")}</h2>
            <p className="text-meta text-muted">{t("draft.sections.advancedDescription")}</p>
          </div>
          <ul className="divide-y divide-border">
            {section(
              "breakdowns",
              {
                title: t("draft.sections.breakdowns"),
                summary: x.dimensions.length === 0 ? t("draft.summary.breakdownsDefault") : <span className="font-mono">{formatList(x.dimensions)}</span>,
                muted: x.dimensions.length === 0,
                hint: t("draft.summary.breakdownsHint"),
              },
              () => (
                <form.AppField name="dimensions">
                  {(field) => (
                    <Breakdowns
                      value={field.state.value}
                      onChange={field.handleChange}
                      // Targeting attributes are what users differ by; the hash attribute is unique per user
                      suggestions={d.conditions.map((c) => c.attribute.trim()).filter((a) => a !== "" && a !== d.hashAttribute)}
                      warehouse={(primary?.dataSourceId ?? BUILTIN_DATA_SOURCE_ID) !== BUILTIN_DATA_SOURCE_ID}
                    />
                  )}
                </form.AppField>
              ),
            )}
            {section(
              "namespace",
              {
                title: t("draft.sections.namespace"),
                help: t("draft.help.namespace"),
                summary:
                  x.namespace === null
                    ? t("draft.summary.namespaceDefault")
                    : `${namespaceName(x.namespace.namespaceId)} · ${formatPercent(x.namespace.start, 0)}–${formatPercent(x.namespace.end, 0)}`,
                muted: x.namespace === null,
                hint: t("draft.summary.namespaceHint"),
              },
              () => (
                <form.AppField name="namespace">
                  {(field) => <NamespaceSlice value={field.state.value} onChange={field.handleChange} experimentId={x.id} />}
                </form.AppField>
              ),
            )}
            {section(
              "stats",
              {
                title: t("draft.sections.stats"),
                summary: statsAreDefault ? t("draft.summary.statsDefault", { settings: statsSummary(x.stats) }) : statsSummary(x.stats),
                muted: statsAreDefault,
                hint: t("draft.summary.statsHint"),
              },
              () => <form.AppField name="stats">{(field) => <StatsFields stats={field.state.value} onChange={field.handleChange} />}</form.AppField>,
            )}
          </ul>
        </Panel>
      </div>

      {/* Links only while no editor is open: opening another section would drop unsaved edits */}
      <Checklist checks={checks} onOpen={canEdit && open === null ? openSection : undefined} />
    </form>
  );
}

function Section({
  id,
  title,
  help,
  summary,
  hint,
  muted = false,
  attention,
  isOpen,
  isLocked,
  canEdit,
  onOpen,
  onCancel,
  isSubmitting,
  footer,
  children,
}: {
  id: SectionId;
  title: string;
  help?: ReactNode;
  summary: ReactNode;
  hint?: ReactNode;
  muted?: boolean;
  /** Something here blocks starting or needs a look */
  attention: boolean;
  isOpen: boolean;
  /** Another section is open */
  isLocked: boolean;
  canEdit: boolean;
  onOpen: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  footer: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation(["experiments", "common"]);
  return (
    <li id={`section-${id}`} aria-labelledby={`section-${id}-title`} className="scroll-mt-8">
      <div className="flex items-start gap-3 px-5 py-4">
        <div className="min-w-0 flex-1 sm:flex sm:gap-4">
          <div className="flex items-center gap-0.5 sm:w-36 sm:shrink-0">
            <h3 id={`section-${id}-title`} className="text-label font-medium">
              {title}
            </h3>
            {help !== undefined && <HelpTip term={title}>{help}</HelpTip>}
            {attention && !isOpen && <AlertTriangle className="ml-1 size-3.5 shrink-0 text-health" aria-label={t("draft.needsAttention")} />}
          </div>
          {!isOpen && (
            <div className="mt-1 min-w-0 flex-1 sm:mt-0">
              <div className={`text-body ${muted ? "text-muted" : ""}`}>{summary}</div>
              {hint !== undefined && <p className="mt-0.5 text-meta text-muted">{hint}</p>}
            </div>
          )}
        </div>
        {canEdit && !isOpen && (
          <Button size="sm" variant="outline" onPress={onOpen} isDisabled={isLocked} aria-label={t("draft.changeSection", { section: title })} className="shrink-0">
            {t("common:actions.change")}
          </Button>
        )}
      </div>
      {isOpen && (
        <div className="flex flex-col gap-5 px-5 pb-5">
          {children}
          {footer}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button size="sm" variant="ghost" onPress={onCancel} isDisabled={isSubmitting}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" size="sm" isPending={isSubmitting}>
              {t("common:actions.save")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Blockers (can't start yet) apart from advice (never blocks); each item opens its section */
function Checklist({ checks, onOpen }: { checks: ReturnType<typeof startChecks>; onOpen: ((id: SectionId) => void) | undefined }) {
  const { t } = useTranslation("experiments");
  const warn = new Set(["sameValue", "flagOff", "longPlan"]);
  const item = (key: string, section: SectionId, icon: ReactNode, message: string) => (
    <li key={key}>
      {onOpen === undefined ? (
        <span className="flex items-start gap-2 text-label">
          {icon}
          {message}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(section)}
          className="flex w-full items-start gap-2 rounded-sm text-left text-label outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
        >
          {icon}
          {message}
        </button>
      )}
    </li>
  );
  return (
    <aside aria-labelledby="draft-checklist" className="flex flex-col gap-4 rounded-[10px] border border-border bg-surface p-5 lg:sticky lg:top-8">
      <div>
        <h2 id="draft-checklist" className="text-label font-medium">
          {t("draft.checks.title")}
        </h2>
        {checks.blockers.length === 0 ? (
          <p className="mt-2 flex items-center gap-2 text-label">
            <Check className="size-3.5 shrink-0 text-win" aria-hidden="true" />
            {t("draft.checks.ready")}
          </p>
        ) : (
          <>
            <p className="mt-1 text-meta text-muted">{t("draft.checks.blocked")}</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {checks.blockers.map((c) =>
                item(c.id, c.section, <Circle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-label={t("form.checks.required")} />, c.message),
              )}
            </ul>
          </>
        )}
      </div>
      <div className="border-t border-border pt-4">
        <h3 className="text-label font-medium">{t("draft.checks.adviceTitle")}</h3>
        {checks.advice.length === 0 ? (
          <p className="mt-2 flex items-center gap-2 text-label text-muted">
            <Check className="size-3.5 shrink-0 text-win" aria-hidden="true" />
            {t("draft.checks.adviceDone")}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {checks.advice.map((c) =>
              item(
                c.id,
                c.section,
                warn.has(c.id) ? (
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-health" aria-label={t("draft.needsAttention")} />
                ) : (
                  <Circle className="mt-0.5 size-3.5 shrink-0 text-muted" aria-label={t("form.checks.recommended")} />
                ),
                c.message,
              ),
            )}
          </ul>
        )}
      </div>
    </aside>
  );
}

const MAX_DIMENSIONS = 5;

/** Attribute names whose values the SDK sends with exposures, so results can be split by them */
function Breakdowns({
  value,
  onChange,
  suggestions,
  warehouse,
}: {
  value: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
  suggestions: ReadonlyArray<string>;
  warehouse: boolean;
}) {
  const { t } = useTranslation("experiments");
  const full = value.length >= MAX_DIMENSIONS;
  const suggested = [...new Set(suggestions)].filter((a) => !value.includes(a));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <p id="breakdowns-label" className="text-label font-medium">
          {t("form.breakdowns.title")}
        </p>
        <span className="font-mono text-meta text-muted tabular">
          {value.length} / {MAX_DIMENSIONS}
        </span>
      </div>
      <TagInput aria-label={t("form.breakdowns.title")} values={value} onChange={(next) => onChange(next.slice(0, MAX_DIMENSIONS))} className="font-mono" />
      {suggested.length > 0 && !full && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-meta text-muted">{t("form.breakdowns.suggested")}</span>
          {suggested.map((a) => (
            <Button key={a} size="sm" variant="outline" className="h-6 px-2 font-mono text-meta" onPress={() => onChange([...value, a])}>
              <Plus className="size-3" aria-hidden="true" />
              {a}
            </Button>
          ))}
        </div>
      )}
      <p className="text-meta text-muted">
        {t("form.breakdowns.description")}
        {warehouse && ` ${t("form.breakdowns.warehouse")}`}
      </p>
    </div>
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

/** Planner inputs (children) beside the resulting sample size and duration; long plans get shorter alternatives */
function PowerPlanner({
  plan,
  variations,
  onUseMde,
  children,
}: {
  plan: ReturnType<typeof planOf>;
  variations: number;
  onUseMde: (percent: number) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("experiments");
  const long = plan.days !== null && plan.days > LONG_PLAN_DAYS;
  const option = (mde: number | null, weeks: 2 | 4) =>
    mde === null ? null : (
      <Button size="sm" variant="outline" onPress={() => onUseMde(Number((mde * 100).toFixed(1)))}>
        {t("draft.plan.useMde", { mde: formatPercent(mde), weeks })}
      </Button>
    );
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]">
        <div className="grid content-start gap-4 sm:grid-cols-2">{children}</div>
        <div className="flex flex-col gap-3 rounded-lg bg-surface-secondary p-4" aria-live="polite">
          <div>
            <p className="text-meta text-muted">{t("form.plan.usersPerVariation")}</p>
            <p className="text-figure font-semibold tracking-tight tabular">{plan.perVariation === null ? "–" : formatCount(plan.perVariation)}</p>
            {plan.total !== null && <p className="text-meta text-muted">{t("form.plan.acrossVariations", { total: formatCount(plan.total), n: variations })}</p>}
          </div>
          <div>
            <p className="text-meta text-muted">{t("form.plan.duration")}</p>
            <p className={`text-section font-medium tabular ${long ? "text-health" : ""}`}>
              {plan.days === null ? "–" : t("form.plan.days", { count: plan.days, days: formatCount(plan.days) })}
            </p>
            {plan.days !== null && plan.days < 7 && <p className="text-meta text-muted">{t("form.plan.minWeek")}</p>}
          </div>
          {plan.mdeIn14 !== null && !long && (
            <p className="border-t border-border pt-3 text-meta text-muted">
              <Trans
                t={t}
                i18nKey="form.plan.in14Days"
                values={{ mde: formatPercent(plan.mdeIn14) }}
                components={{ value: <span className="font-mono text-foreground tabular" /> }}
              />
            </p>
          )}
          <p className="text-meta text-muted">{plan.perVariation === null ? t("form.plan.fillIn") : t("form.plan.assumptions")}</p>
        </div>
      </div>
      {long && (
        <div role="status" className="flex flex-col gap-3 rounded-[10px] border border-health/40 bg-health/8 px-4 py-3">
          <p className="flex items-start gap-2 text-label">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-health" aria-hidden="true" />
            <span>
              <span className="block font-medium">{t("draft.plan.long", { count: plan.days ?? 0 })}</span>
              {plan.mdeIn14 !== null || plan.mdeIn28 !== null ? t("draft.plan.longSuggest") : t("draft.plan.longNoSuggest")}
            </span>
          </p>
          {(plan.mdeIn14 !== null || plan.mdeIn28 !== null) && (
            <div className="flex flex-wrap gap-2 pl-5.5">
              {option(plan.mdeIn14, 2)}
              {option(plan.mdeIn28, 4)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatsFields({ stats, onChange }: { stats: Experiment["stats"]; onChange: (stats: Experiment["stats"]) => void }) {
  const { t } = useTranslation("experiments");
  const patch = (p: Partial<Experiment["stats"]>) => onChange({ ...stats, ...p });
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
        tilesClassName="sm:grid-cols-2"
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
      {toggle(t("form.stats.cuped"), t("form.stats.cupedHelp"), stats.cuped, (cuped) => patch({ cuped }))}
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
