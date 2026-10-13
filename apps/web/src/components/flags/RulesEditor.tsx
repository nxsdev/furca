import type { Environment } from "@kuji/core/environments/Environment";
import type { Experiment } from "@kuji/core/experiments/Experiment";
import { type FeatureRule, type FeatureValueType, validateFeatureValue } from "@kuji/core/features/Feature";
import { Button, Dropdown, Input, Label, NumberField, Separator, Slider, TextField } from "@heroui/react";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Ellipsis, FlaskConical, Pencil, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { ConditionBuilder, conditionIssue, conditionsSummary } from "~/components/targeting/ConditionBuilder";
import { FlagSwitch } from "./FlagSwitch";
import { defaultValueFor, ValueInput, ValuePreview } from "./ValueInput";

/** A rule as sent to features.saveRules (Effect Schema TaggedClass encoding) */
export type Rule = typeof FeatureRule.Encoded;
type ValueRule = Extract<Rule, { _tag: "force" | "rollout" }>;

const typeLabel = { force: "Force", rollout: "Rollout", experiment: "Experiment" } as const;
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** Why a rule can't be saved yet, or null */
export const ruleIssue = (rule: Rule, valueType: FeatureValueType): string | null => {
  if (rule._tag === "experiment") return null;
  for (const c of rule.conditions) {
    const issue = conditionIssue(c);
    if (issue !== null) return `Condition: ${issue.toLowerCase()}`;
  }
  const valueError = validateFeatureValue(valueType, rule.value);
  if (valueError !== null) return `Value: ${valueError.toLowerCase()}`;
  if (rule._tag === "rollout") {
    if (!(rule.coverage >= 0 && rule.coverage <= 1)) return "Coverage must be between 0% and 100%";
    if (rule.hashAttribute.trim() === "") return "Choose an attribute to bucket by";
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

export function RulesList({
  rules,
  onChange,
  valueType,
  environment,
  experimentsById,
  editingId,
  onEditingChange,
  matchedRuleId,
  attributeSuggestions,
  footer,
}: {
  rules: ReadonlyArray<Rule>;
  onChange: (rules: Array<Rule>) => void;
  valueType: FeatureValueType;
  environment: Environment;
  experimentsById: ReadonlyMap<string, Experiment>;
  editingId: string | null;
  onEditingChange: (id: string | null) => void;
  matchedRuleId: string | null;
  attributeSuggestions: ReadonlyArray<string>;
  footer: ReactNode;
}) {
  const replace = (id: string, next: Rule) => onChange(rules.map((r) => (r.id === id ? next : r)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...rules];
    const [rule] = next.splice(i, 1);
    next.splice(i + by, 0, rule!);
    onChange(next);
  };

  return (
    <ol aria-label={`Rules in ${environment.name}`}>
      {rules.length === 0 && (
        <li className="border-b border-border px-4 py-6 text-center text-label text-muted sm:px-5">
          No rules in {environment.name}. Everyone gets the default value when the flag is on.
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
                    {typeLabel[rule._tag]}
                  </span>
                  {rule._tag === "experiment" ? (
                    <span className="min-w-0 truncate text-label">
                      Managed by experiment{" "}
                      <Link
                        to="/experiments/$experimentId"
                        params={{ experimentId: rule.experimentId }}
                        className="rounded-sm font-medium text-foreground underline decoration-border underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        {experiment?.name ?? "…"}
                      </Link>
                    </span>
                  ) : (
                    <span className="min-w-0 break-words text-label">{conditionsSummary(rule.conditions)}</span>
                  )}
                  {!rule.enabled && <span className="text-meta text-muted">Off</span>}
                  {matched && <span className="text-meta font-medium text-focus">Matches test user</span>}
                </div>
                {rule._tag !== "experiment" && rule.description !== "" && (
                  <p className="mt-0.5 truncate text-meta text-muted">{rule.description}</p>
                )}
                {rule._tag === "experiment" && experiment !== undefined && <ExperimentFacts experiment={experiment} />}
                {rule._tag !== "experiment" && (
                  <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-meta whitespace-nowrap text-muted">
                    {rule._tag === "rollout" && <span className="font-mono tabular text-foreground">{pct(rule.coverage)}</span>}
                    {rule._tag === "rollout" && <span>of matching users by {rule.hashAttribute}</span>}
                    {rule._tag === "rollout" && <span aria-hidden="true">·</span>}
                    <span>serve</span>
                    <ValuePreview valueType={valueType} value={rule.value} className="min-w-0" />
                  </div>
                )}
                {issue !== null && !editing && <p className="mt-1 text-meta text-danger">{issue}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <FlagSwitch
                  aria-label={`Rule ${i + 1} enabled`}
                  isSelected={rule.enabled}
                  onChange={(enabled) => replace(rule.id, { ...rule, enabled })}
                  className="mr-1"
                />
                {rule._tag !== "experiment" && (
                  <Button
                    isIconOnly
                    size="sm"
                    variant={editing ? "tertiary" : "ghost"}
                    aria-label={editing ? `Close rule ${i + 1}` : `Edit rule ${i + 1}`}
                    aria-expanded={editing}
                    className="size-8 min-w-8 text-muted hover:text-foreground"
                    onPress={() => onEditingChange(editing ? null : rule.id)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                )}
                <Dropdown>
                  <Button isIconOnly size="sm" variant="ghost" aria-label={`More actions for rule ${i + 1}`} className="size-8 min-w-8 text-muted hover:text-foreground">
                    <Ellipsis className="size-4" />
                  </Button>
                  <Dropdown.Popover placement="bottom end" className="min-w-44">
                    <Dropdown.Menu
                      aria-label={`Rule ${i + 1} actions`}
                      disabledKeys={[...(i === 0 ? ["up"] : []), ...(i === rules.length - 1 ? ["down"] : [])]}
                      onAction={(key) => {
                        if (key === "up") move(i, -1);
                        else if (key === "down") move(i, 1);
                        else if (key === "delete") onChange(rules.filter((r) => r.id !== rule.id));
                      }}
                    >
                      <Dropdown.Item id="up" textValue="Move up">
                        <ArrowUp className="size-4" />
                        <Label>Move up</Label>
                      </Dropdown.Item>
                      <Dropdown.Item id="down" textValue="Move down">
                        <ArrowDown className="size-4" />
                        <Label>Move down</Label>
                      </Dropdown.Item>
                      {rule._tag !== "experiment" && (
                        <>
                          <Separator />
                          <Dropdown.Item id="delete" textValue="Delete rule" variant="danger">
                            <Trash2 className="size-4" />
                            <Label>Delete rule</Label>
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
                rule={rule}
                valueType={valueType}
                issue={issue}
                attributeSuggestions={attributeSuggestions}
                onChange={(next) => replace(rule.id, next)}
                onDone={() => onEditingChange(null)}
              />
            )}
          </li>
        );
      })}
      {footer}
    </ol>
  );
}

function ExperimentFacts({ experiment }: { experiment: Experiment }) {
  const phase = experiment.phases.at(-1);
  const coverage = phase?.coverage ?? experiment.coverage;
  const status = { draft: "Draft · not serving yet", running: "Running", stopped: "Stopped" }[experiment.status];
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-meta text-muted">
      <span className={experiment.status === "running" ? "text-foreground" : ""}>{status}</span>
      <span aria-hidden="true">·</span>
      <span>
        <span className="font-mono tabular">{pct(coverage)}</span> of matching users
      </span>
      <span aria-hidden="true">·</span>
      <span>{experiment.variations.length} variations</span>
    </p>
  );
}

function RuleEditor({
  rule,
  valueType,
  issue,
  attributeSuggestions,
  onChange,
  onDone,
}: {
  rule: ValueRule;
  valueType: FeatureValueType;
  issue: string | null;
  attributeSuggestions: ReadonlyArray<string>;
  onChange: (rule: ValueRule) => void;
  onDone: () => void;
}) {
  const percent = rule._tag === "rollout" ? Math.round(rule.coverage * 1000) / 10 : 100;
  const setPercent = (p: number) =>
    rule._tag === "rollout" && Number.isFinite(p) && onChange({ ...rule, coverage: Math.min(100, Math.max(0, p)) / 100 });
  return (
    <div className="flex flex-col gap-5 border-t border-border bg-surface-secondary/60 px-4 py-4 sm:px-5 sm:pl-13">
      <section className="flex flex-col gap-2">
        <h3 className="text-label font-medium">Who</h3>
        <ConditionBuilder
          value={rule.conditions}
          onChange={(conditions) => onChange({ ...rule, conditions })}
          attributeSuggestions={attributeSuggestions}
        />
      </section>
      {rule._tag === "rollout" && (
        <section className="flex flex-col gap-2">
          <h3 className="text-label font-medium">How many</h3>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Slider
              aria-label="Rollout coverage"
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
              aria-label="Rollout coverage percent"
              value={percent}
              onChange={setPercent}
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
            <span className="text-label text-muted">of matching users, bucketed by</span>
            <TextField
              aria-label="Bucket by attribute"
              value={rule.hashAttribute}
              onChange={(hashAttribute) => onChange({ ...rule, hashAttribute: hashAttribute.trim() })}
            >
              <Input className="h-8 w-28 py-1 font-mono text-base sm:text-label" placeholder="id" />
            </TextField>
          </div>
          <p className="text-meta text-muted">
            The same {rule.hashAttribute || "id"} always lands in the same bucket, so raising the percentage only adds users.
          </p>
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h3 className="text-label font-medium">Serve</h3>
        <ValueInput valueType={valueType} value={rule.value} onChange={(value) => onChange({ ...rule, value })} />
      </section>
      <TextField value={rule.description} onChange={(description) => onChange({ ...rule, description })} className="max-w-md">
        <Label className="text-label font-medium">
          Note <span className="font-normal text-muted">(optional)</span>
        </Label>
        <Input className="h-8 py-1 text-base sm:text-label" placeholder="e.g. QA team, beta customers" />
      </TextField>
      <div className="flex items-center justify-between gap-3">
        <p className={`text-meta ${issue === null ? "text-muted" : "text-danger"}`}>{issue ?? "Changes are kept until you save."}</p>
        <Button size="sm" variant="tertiary" onPress={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** "Add rule" menu: force value or percentage rollout */
export function AddRuleButton({ onAdd }: { onAdd: (kind: "force" | "rollout") => void }) {
  return (
    <Dropdown>
      <Button size="sm" variant="outline">
        <Plus className="size-4" />
        Add rule
      </Button>
      <Dropdown.Popover placement="bottom start" className="min-w-64">
        <Dropdown.Menu aria-label="Rule type" onAction={(key) => (key === "force" || key === "rollout") && onAdd(key)}>
          <Dropdown.Item id="force" textValue="Force a value">
            <div className="flex flex-col">
              <Label>Force a value</Label>
              <span className="text-meta text-muted">Serve one value to everyone who matches</span>
            </div>
          </Dropdown.Item>
          <Dropdown.Item id="rollout" textValue="Percentage rollout">
            <div className="flex flex-col">
              <Label>Percentage rollout</Label>
              <span className="text-meta text-muted">Serve a value to a share of matching users</span>
            </div>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
