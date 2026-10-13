import type { Environment } from "@furca/core/environments/Environment";
import type { Experiment } from "@furca/core/experiments/Experiment";
import type { FeatureRule, FeatureValueType } from "@furca/core/features/Feature";
import { Button, Dropdown, Input, Label, NumberField, Separator, Slider, TextField } from "@heroui/react";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Ellipsis, FlaskConical, Pencil, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { withForm } from "~/components/form/form";
import { ConditionBuilder, conditionIssue, conditionsSummary } from "~/components/targeting/ConditionBuilder";
import { i18n } from "~/i18n";
import { FlagSwitch } from "./FlagSwitch";
import { defaultValueFor, ValueInput, ValuePreview, valueIssue } from "./ValueInput";

/** A rule as sent to features.saveRules (Effect Schema TaggedClass encoding) */
export type Rule = typeof FeatureRule.Encoded;
type ValueRule = Extract<Rule, { _tag: "force" | "rollout" }>;

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** "Enter a value" → "enter a value" after "Condition: " (no-op for Japanese) */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Why a rule can't be saved yet, or null */
export const ruleIssue = (rule: Rule, valueType: FeatureValueType): string | null => {
  if (rule._tag === "experiment") return null;
  for (const c of rule.conditions) {
    const issue = conditionIssue(c);
    if (issue !== null) return i18n.t("flags:rules.issues.condition", { issue: lowerFirst(issue) });
  }
  const valueError = valueIssue(valueType, rule.value);
  if (valueError !== null) return i18n.t("flags:rules.issues.value", { issue: lowerFirst(valueError) });
  if (rule._tag === "rollout") {
    if (!(rule.coverage >= 0 && rule.coverage <= 1)) return i18n.t("flags:rules.issues.coverage");
    if (rule.hashAttribute.trim() === "") return i18n.t("flags:rules.issues.hashAttribute");
  }
  return null;
};

/** New force / rollout rule. Boolean flags start by serving the opposite of the default */
export const newRule = (kind: "force" | "rollout", valueType: FeatureValueType, defaultValue: string): ValueRule => {
  const value = valueType === "boolean" ? (defaultValue === "true" ? "false" : "true") : defaultValue || defaultValueFor(valueType);
  const base = { id: crypto.randomUUID(), description: "", enabled: true, conditions: [], value };
  return kind === "force"
    ? { _tag: "force", ...base }
    : { _tag: "rollout", ...base, coverage: 0.1, hashAttribute: "id", seed: crypto.randomUUID() };
};

/** Unsaved rules of every environment (one form, so drafts survive switching environments) */
export interface RulesDraft {
  envs: Array<{ environmentId: string; rules: Array<Rule> }>;
}

const rulesDraft = { envs: [] } as RulesDraft;

/** Ordered rules of `envs[envIndex]`, edited in place (inline rule editor, toggle, reorder, delete) */
export const RulesList = withForm({
  defaultValues: rulesDraft,
  props: {} as {
    envIndex: number;
    valueType: FeatureValueType;
    environment: Environment;
    experimentsById: ReadonlyMap<string, Experiment>;
    editingId: string | null;
    onEditingChange: (id: string | null) => void;
    matchedRuleId: string | null;
    attributeSuggestions: ReadonlyArray<string>;
    footer: ReactNode;
  },
  render: function RulesList({
    form,
    envIndex,
    valueType,
    environment,
    experimentsById,
    editingId,
    onEditingChange,
    matchedRuleId,
    attributeSuggestions,
    footer,
  }) {
    const { t } = useTranslation("flags");
    return (
      <form.AppField name={`envs[${envIndex}].rules`}>
        {(field) => {
          const rules = field.state.value;
          return (
            <ol aria-label={t("shared.rulesIn", { environment: environment.name })}>
              {rules.length === 0 && (
                <li className="border-b border-border px-4 py-6 text-center text-label text-muted sm:px-5">
                  {t("rules.empty", { environment: environment.name })}
                </li>
              )}
              {rules.map((rule, i) => {
                const editing = editingId === rule.id;
                const matched = matchedRuleId === rule.id;
                const issue = ruleIssue(rule, valueType);
                const experiment = rule._tag === "experiment" ? experimentsById.get(rule.experimentId) : undefined;
                return (
                  <li
                    key={rule.id}
                    className={`relative border-b border-border transition-colors duration-150 ${matched ? "bg-focus/[0.06]" : ""}`}
                  >
                    {matched && <span className="absolute inset-y-0 left-0 w-0.5 bg-focus" aria-hidden="true" />}
                    <div className="flex items-start gap-3 px-4 py-3 sm:px-5">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[0.6875rem] text-muted tabular">
                        {i + 1}
                      </span>
                      <div className={`min-w-0 flex-1 ${rule.enabled ? "" : "opacity-55"}`}>
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-border px-1.5 text-meta leading-[18px] font-medium">
                            {rule._tag === "experiment" && <FlaskConical className="size-3 text-muted" aria-hidden="true" />}
                            {t(`rules.types.${rule._tag}`)}
                          </span>
                          {rule._tag === "experiment" ? (
                            <span className="min-w-0 truncate text-label">
                              <Trans
                                t={t}
                                i18nKey="rules.managedBy"
                                values={{ name: experiment?.name ?? "…" }}
                                components={{
                                  link: (
                                    <Link
                                      to="/experiments/$experimentId"
                                      params={{ experimentId: rule.experimentId }}
                                      className="rounded-sm font-medium text-foreground underline decoration-border underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-focus"
                                    />
                                  ),
                                }}
                              />
                            </span>
                          ) : (
                            <span className="min-w-0 break-words text-label">{conditionsSummary(rule.conditions)}</span>
                          )}
                          {!rule.enabled && <span className="text-meta text-muted">{t("shared.off")}</span>}
                          {matched && <span className="text-meta font-medium text-focus">{t("shared.matchesTestUser")}</span>}
                        </div>
                        {rule._tag !== "experiment" && rule.description !== "" && (
                          <p className="mt-0.5 truncate text-meta text-muted">{rule.description}</p>
                        )}
                        {rule._tag === "experiment" && experiment !== undefined && <ExperimentFacts experiment={experiment} />}
                        {rule._tag !== "experiment" && (
                          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-meta whitespace-nowrap text-muted">
                            {rule._tag === "rollout" && (
                              <span>
                                <Trans
                                  t={t}
                                  i18nKey="rules.rolloutOf"
                                  values={{ percent: pct(rule.coverage), attribute: rule.hashAttribute }}
                                  components={{ pct: <span className="font-mono tabular text-foreground" /> }}
                                />
                              </span>
                            )}
                            {rule._tag === "rollout" && <span aria-hidden="true">·</span>}
                            <Trans
                              t={t}
                              i18nKey="shared.serve"
                              components={{ value: <ValuePreview valueType={valueType} value={rule.value} className="min-w-0" /> }}
                            />
                          </div>
                        )}
                        {issue !== null && !editing && <p className="mt-1 text-meta text-danger">{issue}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <FlagSwitch
                          aria-label={t("rules.ruleEnabled", { number: i + 1 })}
                          isSelected={rule.enabled}
                          onChange={(enabled) => form.setFieldValue(`envs[${envIndex}].rules[${i}].enabled`, enabled)}
                          className="mr-1"
                        />
                        {rule._tag !== "experiment" && (
                          <Button
                            isIconOnly
                            size="sm"
                            variant={editing ? "tertiary" : "ghost"}
                            aria-label={editing ? t("rules.closeRule", { number: i + 1 }) : t("rules.editRule", { number: i + 1 })}
                            aria-expanded={editing}
                            className="size-8 min-w-8 text-muted hover:text-foreground"
                            onPress={() => onEditingChange(editing ? null : rule.id)}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                        )}
                        <Dropdown>
                          <Button isIconOnly size="sm" variant="ghost" aria-label={t("rules.moreActions", { number: i + 1 })} className="size-8 min-w-8 text-muted hover:text-foreground">
                            <Ellipsis className="size-4" />
                          </Button>
                          <Dropdown.Popover placement="bottom end" className="min-w-44">
                            <Dropdown.Menu
                              aria-label={t("rules.ruleActions", { number: i + 1 })}
                              disabledKeys={[...(i === 0 ? ["up"] : []), ...(i === rules.length - 1 ? ["down"] : [])]}
                              onAction={(key) => {
                                if (key === "up") field.moveValue(i, i - 1);
                                else if (key === "down") field.moveValue(i, i + 1);
                                else if (key === "delete") field.removeValue(i);
                              }}
                            >
                              <Dropdown.Item id="up" textValue={t("rules.moveUp")}>
                                <ArrowUp className="size-4" />
                                <Label>{t("rules.moveUp")}</Label>
                              </Dropdown.Item>
                              <Dropdown.Item id="down" textValue={t("rules.moveDown")}>
                                <ArrowDown className="size-4" />
                                <Label>{t("rules.moveDown")}</Label>
                              </Dropdown.Item>
                              {rule._tag !== "experiment" && (
                                <>
                                  <Separator />
                                  <Dropdown.Item id="delete" textValue={t("rules.deleteRule")} variant="danger">
                                    <Trash2 className="size-4" />
                                    <Label>{t("rules.deleteRule")}</Label>
                                  </Dropdown.Item>
                                </>
                              )}
                            </Dropdown.Menu>
                          </Dropdown.Popover>
                        </Dropdown>
                      </div>
                    </div>
                    {editing && rule._tag !== "experiment" && (
                      <RuleEditor
                        form={form}
                        name={`envs[${envIndex}].rules[${i}]`}
                        rule={rule}
                        valueType={valueType}
                        issue={issue}
                        attributeSuggestions={attributeSuggestions}
                        onDone={() => onEditingChange(null)}
                      />
                    )}
                  </li>
                );
              })}
              {footer}
            </ol>
          );
        }}
      </form.AppField>
    );
  },
});

function ExperimentFacts({ experiment }: { experiment: Experiment }) {
  const { t } = useTranslation("flags");
  const phase = experiment.phases.at(-1);
  const coverage = phase?.coverage ?? experiment.coverage;
  const status = t(`rules.experimentStatus.${experiment.status}`);
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-meta text-muted">
      <span className={experiment.status === "running" ? "text-foreground" : ""}>{status}</span>
      <span aria-hidden="true">·</span>
      <span>
        <Trans t={t} i18nKey="rules.ofMatchingUsers" values={{ percent: pct(coverage) }} components={{ pct: <span className="font-mono tabular" /> }} />
      </span>
      <span aria-hidden="true">·</span>
      <span>{t("rules.variations", { count: experiment.variations.length })}</span>
    </p>
  );
}

/** Inline editor of one force / rollout rule; every input is a field of the rules form */
const RuleEditor = withForm({
  defaultValues: rulesDraft,
  props: {} as {
    name: `envs[${number}].rules[${number}]`;
    rule: ValueRule;
    valueType: FeatureValueType;
    issue: string | null;
    attributeSuggestions: ReadonlyArray<string>;
    onDone: () => void;
  },
  render: function RuleEditor({ form, name, rule, valueType, issue, attributeSuggestions, onDone }) {
    const { t } = useTranslation("flags");
    return (
      <div className="flex flex-col gap-5 border-t border-border bg-surface-secondary/60 px-4 py-4 sm:px-5 sm:pl-13">
        <section className="flex flex-col gap-2">
          <h3 className="text-label font-medium">{t("ruleEditor.who")}</h3>
          <form.AppField name={`${name}.conditions`}>
            {(field) => (
              <ConditionBuilder value={field.state.value} onChange={field.handleChange} attributeSuggestions={attributeSuggestions} />
            )}
          </form.AppField>
        </section>
        {rule._tag === "rollout" && (
          <section className="flex flex-col gap-2">
            <h3 className="text-label font-medium">{t("ruleEditor.howMany")}</h3>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <form.AppField name={`${name}.coverage`}>
                {(field) => {
                  const percent = Math.round(field.state.value * 1000) / 10;
                  const setPercent = (p: number) => Number.isFinite(p) && field.handleChange(Math.min(100, Math.max(0, p)) / 100);
                  return (
                    <>
                      <Slider
                        aria-label={t("ruleEditor.coverage")}
                        value={percent}
                        onChange={(v) => setPercent(Array.isArray(v) ? (v[0] ?? 0) : v)}
                        minValue={0}
                        maxValue={100}
                        step={1}
                        className="w-full max-w-72"
                      >
                        <Slider.Track className="h-1.5">
                          <Slider.Fill />
                          <Slider.Thumb className="w-4 bg-transparent after:size-4 after:rounded-full after:bg-white after:shadow-[0_0_0_1px_oklch(0_0_0/0.15),0_1px_3px_oklch(0_0_0/0.25)] data-[focus-visible=true]:ring-0 data-[focus-visible=true]:after:ring-2 data-[focus-visible=true]:after:ring-focus" />
                        </Slider.Track>
                      </Slider>
                      <NumberField
                        aria-label={t("ruleEditor.coveragePercent")}
                        value={percent}
                        onChange={setPercent}
                        onBlur={field.handleBlur}
                        minValue={0}
                        maxValue={100}
                        step={0.1}
                        formatOptions={{ maximumFractionDigits: 1 }}
                      >
                        <NumberField.Group className="h-8 w-24 grid-cols-[minmax(0,1fr)_auto]">
                          <NumberField.Input className="py-1 pr-1 font-mono text-base sm:text-label tabular" />
                          <span className="pr-2.5 text-label text-muted">%</span>
                        </NumberField.Group>
                      </NumberField>
                    </>
                  );
                }}
              </form.AppField>
              <span className="text-label text-muted">{t("ruleEditor.bucketedBy")}</span>
              <form.AppField name={`${name}.hashAttribute`}>
                {(field) => (
                  <TextField
                    aria-label={t("ruleEditor.bucketBy")}
                    value={field.state.value}
                    onChange={(v) => field.handleChange(v.trim())}
                    onBlur={field.handleBlur}
                  >
                    <Input className="h-8 w-28 py-1 font-mono text-base sm:text-label" placeholder="id" />
                  </TextField>
                )}
              </form.AppField>
            </div>
            <p className="text-meta text-muted">
              {t("ruleEditor.stickyHelp", { attribute: rule.hashAttribute || "id" })}
            </p>
          </section>
        )}
        <section className="flex flex-col gap-2">
          <h3 className="text-label font-medium">{t("ruleEditor.serve")}</h3>
          <form.AppField name={`${name}.value`}>
            {(field) => <ValueInput valueType={valueType} value={field.state.value} onChange={field.handleChange} />}
          </form.AppField>
        </section>
        <form.AppField name={`${name}.description`}>
          {(field) => (
            <TextField value={field.state.value} onChange={field.handleChange} onBlur={field.handleBlur} className="max-w-md">
              <Label className="text-label font-medium">
                {t("ruleEditor.note")} <span className="font-normal text-muted">{t("shared.optional")}</span>
              </Label>
              <Input className="h-8 py-1 text-base sm:text-label" placeholder={t("ruleEditor.notePlaceholder")} />
            </TextField>
          )}
        </form.AppField>
        <div className="flex items-center justify-between gap-3">
          <p className={`text-meta ${issue === null ? "text-muted" : "text-danger"}`}>{issue ?? t("ruleEditor.keptUntilSave")}</p>
          <Button size="sm" variant="tertiary" onPress={onDone}>
            {t("ruleEditor.done")}
          </Button>
        </div>
      </div>
    );
  },
});

/** "Add rule" menu: force value or percentage rollout */
export function AddRuleButton({ onAdd }: { onAdd: (kind: "force" | "rollout") => void }) {
  const { t } = useTranslation("flags");
  return (
    <Dropdown>
      <Button size="sm" variant="outline">
        <Plus className="size-4" />
        {t("addRule.button")}
      </Button>
      <Dropdown.Popover placement="bottom start" className="min-w-64">
        <Dropdown.Menu aria-label={t("addRule.menu")} onAction={(key) => (key === "force" || key === "rollout") && onAdd(key)}>
          <Dropdown.Item id="force" textValue={t("addRule.force")}>
            <div className="flex flex-col">
              <Label>{t("addRule.force")}</Label>
              <span className="text-meta text-muted">{t("addRule.forceHelp")}</span>
            </div>
          </Dropdown.Item>
          <Dropdown.Item id="rollout" textValue={t("addRule.rollout")}>
            <div className="flex flex-col">
              <Label>{t("addRule.rollout")}</Label>
              <span className="text-meta text-muted">{t("addRule.rolloutHelp")}</span>
            </div>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
