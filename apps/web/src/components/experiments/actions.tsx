import { type Experiment, trafficChangeNeedsNewPhase } from "@furca/core/experiments/Experiment";
import type { Feature } from "@furca/core/features/Feature";
import { Button, Description, FieldError, Label, NumberField, Switch, TextArea, TextField } from "@heroui/react";
import { useStore } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { Info, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ValuePreview } from "~/components/flags/ValueInput";
import { errorText, setServerError, useAppForm, useRequired } from "~/components/form/form";
import { formatList } from "~/components/results/format";
import { ConditionBuilder, type ConditionValue, conditionIssue } from "~/components/targeting/ConditionBuilder";
import { Segmented } from "~/components/ui/Segmented";
import { intlLocale } from "~/i18n";
import { useEnvironment } from "~/lib/environment";
import { client, orpc } from "~/lib/rpc";
import { CoverageField, currentPhase, evenPercents, shownError, VariationSwatch } from "./parts";

/** Puts the saved experiment in the cache and refreshes everything derived from it */
function useSaved(onDone: () => void) {
  const queryClient = useQueryClient();
  return (saved: Experiment) => {
    queryClient.setQueryData(orpc.experiments.get.queryKey({ input: { id: saved.id } }), saved);
    void queryClient.invalidateQueries({ queryKey: orpc.experiments.list.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.results.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.features.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
    onDone();
  };
}

/** Inline panel shell used by the running-experiment actions (no modal: the evidence stays visible) */
function ActionPanel({ title, description, children, footer }: { title: string; description: ReactNode; children: ReactNode; footer: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-[10px] border border-foreground/20 bg-surface shadow-[0_0_0_3px_var(--default)]">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-section font-medium">{title}</h2>
        <p className="mt-0.5 text-label text-muted">{description}</p>
      </header>
      <div className="flex flex-col gap-5 px-5 py-5">{children}</div>
      <footer className="flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-end">{footer}</footer>
    </section>
  );
}

const sameWeights = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) =>
  a.length === b.length && a.every((w, i) => Math.abs(w - (b[i] ?? 0)) < 1e-9);

interface TrafficValues {
  coverage: number;
  /** Even split ignores percents; toggling it resets them to an even spread */
  even: boolean;
  percents: ReadonlyArray<number>;
  conditions: ReadonlyArray<ConditionValue>;
  reason: string;
}

export function TrafficEditor({ experiment, onDone }: { experiment: Experiment; onDone: () => void }) {
  const { t } = useTranslation(["experiments", "common"]);
  const onSaved = useSaved(onDone);
  const phase = currentPhase(experiment);
  const n = experiment.variations.length;
  const weightsOf = (v: TrafficValues) => (v.even ? experiment.variations.map(() => 1 / n) : v.percents.map((p) => (Number.isFinite(p) ? p / 100 : 0)));
  const needsNewPhase = (v: TrafficValues) =>
    phase !== null && trafficChangeNeedsNewPhase(phase, { coverage: v.coverage, weights: weightsOf(v), conditions: v.conditions });
  const defaultValues: TrafficValues = {
    coverage: phase?.coverage ?? experiment.coverage,
    even: (phase?.weights ?? []).every((w) => Math.abs(w - 1 / n) < 1e-3),
    percents: (phase?.weights ?? []).map((w) => Number((w * 100).toFixed(2))),
    conditions: phase?.conditions ?? [],
    reason: "",
  };
  const form = useAppForm({
    defaultValues,
    validators: {
      onChange: ({ value }) => {
        const weights = weightsOf(value);
        const total = weights.reduce((a, b) => a + b, 0);
        const fields = {
          percents:
            Math.abs(total - 1) > 1e-4
              ? t("traffic.weightsTotal", { percent: Number((total * 100).toFixed(2)) })
              : weights.some((w) => w <= 0)
                ? t("traffic.weightZero")
                : undefined,
          conditions: value.conditions.map((c) => conditionIssue(c)).find((m) => m !== null) ?? undefined,
          reason: needsNewPhase(value) && value.reason.trim() === "" ? t("common:form.required") : undefined,
        };
        return Object.values(fields).some((m) => m !== undefined) ? { fields } : undefined;
      },
    },
    onSubmit: async ({ value, formApi }) => {
      const saved = await client.experiments
        .updateTraffic({
          id: experiment.id,
          coverage: value.coverage,
          weights: weightsOf(value),
          conditions: value.conditions.map((c) => ({ ...c, values: [...c.values] })),
          reason: value.reason.trim(),
        })
        .catch((error: unknown) => {
          setServerError(formApi, error);
          return null;
        });
      if (saved !== null) onSaved(saved);
    },
  });
  const { values: v, submissionAttempts, isFieldsValid, isSubmitting } = useStore(form.store, (s) => s);
  if (phase === null) return null;

  const weights = weightsOf(v);
  const changes = [
    v.coverage < phase.coverage - 1e-9 && t("traffic.changes.coverageDown"),
    !sameWeights(weights, phase.weights) && t("traffic.changes.split"),
    JSON.stringify(v.conditions) !== JSON.stringify(phase.conditions) && t("traffic.changes.targeting"),
  ].filter((c): c is string => c !== false);
  const changed = changes.length > 0 || Math.abs(v.coverage - phase.coverage) > 1e-9;
  const newPhase = needsNewPhase(v);
  const phaseNo = experiment.phases.length;

  return (
    <ActionPanel
      title={t("traffic.title")}
      description={t("traffic.description", { phase: phaseNo })}
      footer={
        <>
          <form.AppForm>
            <form.FormError className="sm:mr-auto" />
          </form.AppForm>
          <Button size="sm" variant="tertiary" onPress={onDone} isDisabled={isSubmitting}>
            {t("common:actions.cancel")}
          </Button>
          {/* No <form>: Enter in a number field must not apply a change that can re-randomize users */}
          <Button size="sm" onPress={() => void form.handleSubmit()} isPending={isSubmitting} isDisabled={!changed || (submissionAttempts > 0 && !isFieldsValid)}>
            {newPhase ? t("traffic.startPhase", { phase: phaseNo + 1 }) : t("traffic.apply")}
          </Button>
        </>
      }
    >
      <form.AppField name="coverage">
        {(field) => (
          <CoverageField
            value={field.state.value}
            onChange={field.handleChange}
            description={t("traffic.coverageHelp", { percent: Math.round(phase.coverage * 100) })}
          />
        )}
      </form.AppField>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-label font-medium">{t("traffic.split")}</p>
          <form.AppField name="even" listeners={{ onChange: () => form.setFieldValue("percents", evenPercents(n)) }}>
            {(field) => (
              <Switch size="sm" isSelected={field.state.value} onChange={field.handleChange}>
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <span className="text-label">{t("traffic.evenSplit")}</span>
                </Switch.Content>
              </Switch>
            )}
          </form.AppField>
        </div>
        <form.AppField name="percents">
          {(field) => {
            const error = shownError(field.state.meta);
            return (
              <>
                <div className="grid gap-2 sm:grid-cols-2">
                  {experiment.variations.map((variation, i) => (
                    <NumberField
                      key={variation.key}
                      value={v.even ? Number((100 / n).toFixed(1)) : field.state.value[i]}
                      onChange={(p) => field.handleChange(field.state.value.map((x, j) => (j === i ? p : x)))}
                      isDisabled={v.even}
                      minValue={0}
                      maxValue={100}
                      step={0.1}
                      aria-label={t("traffic.weight", { name: variation.name })}
                    >
                      <NumberField.Group className="grid-cols-[auto_1fr_auto]">
                        <span className="flex items-center gap-2 pl-3 text-label whitespace-nowrap">
                          <VariationSwatch index={i} />
                          {variation.name}
                        </span>
                        <NumberField.Input className="text-right tabular" />
                        <span className="pr-3 text-label text-muted">%</span>
                      </NumberField.Group>
                    </NumberField>
                  ))}
                </div>
                {error !== null && <p className="text-meta text-danger">{error}</p>}
              </>
            );
          }}
        </form.AppField>
      </div>
      <form.AppField name="conditions">
        {(field) => (
          <div className="flex flex-col gap-2">
            <p className="text-label font-medium">{t("traffic.whoCanEnter")}</p>
            <ConditionBuilder value={field.state.value} onChange={field.handleChange} />
            {/* Format problems show inline in the builder; missing parts are reported once a save was tried */}
            {submissionAttempts > 0 && field.state.meta.errors.length > 0 && <p className="text-meta text-danger">{errorText(field.state.meta.errors)}</p>}
          </div>
        )}
      </form.AppField>

      {changed && (
        <div
          className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-label ${newPhase ? "border-foreground/30 bg-surface-secondary" : "border-border"}`}
          aria-live="polite"
        >
          {newPhase ? <RotateCcw className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />}
          {newPhase ? (
            <p>
              <span className="font-medium">{t("traffic.newPhase", { phase: phaseNo + 1 })}</span>{" "}
              <span className="text-muted">
                {t("traffic.newPhaseWhy", {
                  changes: new Intl.ListFormat(intlLocale(), { type: "conjunction" }).format(changes),
                  current: phaseNo,
                })}
              </span>
            </p>
          ) : (
            <p>
              <span className="font-medium">{t("traffic.keepsPhase")}</span>{" "}
              <span className="text-muted">{t("traffic.keepsPhaseWhy")}</span>
            </p>
          )}
        </div>
      )}
      <form.AppField name="reason">
        {(field) => {
          const error = shownError(field.state.meta);
          return (
            <TextField
              value={field.state.value}
              onChange={field.handleChange}
              onBlur={field.handleBlur}
              isRequired={newPhase}
              isInvalid={error !== null}
            >
              <Label>{newPhase ? t("traffic.reason") : t("traffic.reasonOptional")}</Label>
              <TextArea rows={2} placeholder={t("traffic.reasonPlaceholder")} className="resize-y" />
              <Description>{t("traffic.reasonHelp")}</Description>
              <FieldError>{error}</FieldError>
            </TextField>
          );
        }}
      </form.AppField>
    </ActionPanel>
  );
}

export function StopPanel({
  experiment,
  feature,
  suggestion,
  onDone,
}: {
  experiment: Experiment;
  feature: Feature | undefined;
  /** "ship:<key>" when the primary metric is winning, "rollback" when losing; only with healthy data */
  suggestion: string | null;
  onDone: () => void;
}) {
  const { t } = useTranslation(["experiments", "common"]);
  const { environments } = useEnvironment();
  const required = useRequired();
  const onSaved = useSaved(onDone);
  const shipKeyOf = (choice: string) => (choice.startsWith("ship:") ? choice.slice(5) : null);
  const form = useAppForm({
    defaultValues: { choice: suggestion ?? "", reason: "" },
    onSubmit: async ({ value, formApi }) => {
      const shipKey = shipKeyOf(value.choice);
      const saved = await client.experiments
        .stop({
          id: experiment.id,
          outcome: shipKey === null ? (value.choice as "rollback" | "inconclusive") : "ship",
          variationKey: shipKey,
          reason: value.reason.trim(),
        })
        .catch((error: unknown) => {
          setServerError(formApi, error);
          return null;
        });
      if (saved !== null) onSaved(saved);
    },
  });
  const { values, submissionAttempts, isFieldsValid, isSubmitting } = useStore(form.store, (s) => s);
  const choice = values.choice;
  const shipped = experiment.variations.find((v) => v.key === shipKeyOf(choice));
  const envNames = formatList(environments.filter((e) => experiment.environmentIds.includes(e.id)).map((e) => e.name));
  const suggested = <span className="ml-1.5 rounded-sm bg-default px-1 py-px text-[11px] font-medium text-muted">{t("stop.suggested")}</span>;
  const preview = (value: string) =>
    feature === undefined ? <code className="font-mono">{value}</code> : <ValuePreview valueType={feature.valueType} value={value} />;

  const options = [
    ...experiment.variations.slice(1).map((v, i) => ({
      value: `ship:${v.key}`,
      label: (
        <span className="inline-flex items-center gap-1.5">
          <VariationSwatch index={i + 1} />
          {t("stop.ship", { name: v.name })}
          {suggestion === `ship:${v.key}` && suggested}
        </span>
      ),
      description: t("stop.shipHelp"),
    })),
    {
      value: "rollback",
      label: (
        <span>
          {t("stop.rollback")}
          {suggestion === "rollback" && suggested}
        </span>
      ),
      description: t("stop.rollbackHelp"),
    },
    { value: "inconclusive", label: t("stop.inconclusive"), description: t("stop.inconclusiveHelp") },
  ];

  return (
    <ActionPanel
      title={t("stop.title")}
      description={t("stop.description")}
      footer={
        <>
          <form.AppForm>
            <form.FormError className="sm:mr-auto" />
          </form.AppForm>
          <Button size="sm" variant="tertiary" onPress={onDone} isDisabled={isSubmitting}>
            {t("common:actions.cancel")}
          </Button>
          {/* No <form>: stopping can't be undone, so only this button submits */}
          <Button size="sm" onPress={() => void form.handleSubmit()} isPending={isSubmitting} isDisabled={submissionAttempts > 0 && !isFieldsValid}>
            {shipped !== undefined ? t("stop.stopAndShip", { name: shipped.name }) : t("stop.stopExperiment")}
          </Button>
        </>
      }
    >
      <form.AppField name="choice" validators={{ onChange: ({ value }) => (value === "" ? t("stop.chooseDecision") : undefined) }}>
        {(field) => {
          const error = shownError(field.state.meta);
          return (
            <>
              <Segmented label={t("stop.decision")} value={field.state.value} onChange={field.handleChange} options={options} />
              {error !== null && <p className="-mt-3 text-meta text-danger">{error}</p>}
            </>
          );
        }}
      </form.AppField>
      {choice !== "" && (
        <p className="rounded-lg border border-border bg-surface-secondary px-4 py-3 text-label" aria-live="polite">
          {shipped !== undefined ? (
            <Trans
              t={t}
              i18nKey="stop.shipSummary"
              values={{ name: shipped.name, environments: envNames }}
              components={{ value: preview(shipped.value) }}
            />
          ) : (
            <>
              <Trans
                t={t}
                i18nKey={feature === undefined ? "stop.removeSummaryNoValue" : "stop.removeSummary"}
                values={{ flag: feature?.key ?? t("theFlag"), environments: envNames }}
                components={{ code: <span className="font-mono" />, value: feature === undefined ? <></> : preview(feature.defaultValue) }}
              />
              {choice === "inconclusive" && t("stop.recordedInconclusive")}
            </>
          )}
        </p>
      )}
      <form.AppField name="reason" validators={{ onChange: required }}>
        {(field) => {
          const error = shownError(field.state.meta);
          return (
            <TextField value={field.state.value} onChange={field.handleChange} onBlur={field.handleBlur} isRequired isInvalid={error !== null}>
              <Label>{t("stop.why")}</Label>
              <TextArea rows={3} placeholder={t("stop.whyPlaceholder")} className="resize-y" />
              <Description>{t("stop.whyHelp")}</Description>
              <FieldError>{error}</FieldError>
            </TextField>
          );
        }}
      </form.AppField>
    </ActionPanel>
  );
}
