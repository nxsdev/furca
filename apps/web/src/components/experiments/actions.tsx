import { type Experiment, trafficChangeNeedsNewPhase } from "@furca/core/experiments/Experiment";
import type { Feature } from "@furca/core/features/Feature";
import { Button, Description, Label, NumberField, Switch, TextArea, TextField } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Info, RotateCcw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ValuePreview } from "~/components/flags/ValueInput";
import { ConditionBuilder, type ConditionValue, conditionIssue } from "~/components/targeting/ConditionBuilder";
import { Segmented } from "~/components/ui/Segmented";
import { useEnvironment } from "~/lib/environment";
import { errorMessage, orpc } from "~/lib/rpc";
import { CoverageField, currentPhase, evenPercents, VariationSwatch } from "./parts";

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

export function TrafficEditor({ experiment, onDone }: { experiment: Experiment; onDone: () => void }) {
  const phase = currentPhase(experiment);
  const n = experiment.variations.length;
  const [coverage, setCoverage] = useState(phase?.coverage ?? experiment.coverage);
  const [even, setEven] = useState(() => (phase?.weights ?? []).every((w) => Math.abs(w - 1 / n) < 1e-3));
  const [percents, setPercents] = useState(() => (phase?.weights ?? []).map((w) => Number((w * 100).toFixed(2))));
  const [conditions, setConditions] = useState<ReadonlyArray<ConditionValue>>(phase?.conditions ?? []);
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const save = useMutation(orpc.experiments.updateTraffic.mutationOptions({ onSuccess: useSaved(onDone) }));
  if (phase === null) return null;

  const weights = even ? experiment.variations.map(() => 1 / n) : percents.map((p) => (Number.isFinite(p) ? p / 100 : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  const next = { coverage, weights, conditions };
  const changes = [
    coverage < phase.coverage - 1e-9 && "coverage goes down",
    !sameWeights(weights, phase.weights) && "the split changes",
    JSON.stringify(conditions) !== JSON.stringify(phase.conditions) && "targeting changes",
  ].filter((c): c is string => c !== false);
  const changed = changes.length > 0 || Math.abs(coverage - phase.coverage) > 1e-9;
  const newPhase = trafficChangeNeedsNewPhase(phase, next);
  const phaseNo = experiment.phases.length;
  const invalid =
    Math.abs(total - 1) > 1e-4 || weights.some((w) => w <= 0) || conditions.some((c) => conditionIssue(c) !== null) || (newPhase && reason.trim() === "");

  const apply = () => {
    setSubmitted(true);
    if (invalid || !changed) return;
    save.mutate({
      id: experiment.id,
      coverage,
      weights,
      conditions: conditions.map((c) => ({ ...c, values: [...c.values] })),
      reason: reason.trim(),
    });
  };

  return (
    <ActionPanel
      title="Change traffic"
      description={`Phase ${phaseNo} is running. Raising coverage is safe; anything else re-randomizes users.`}
      footer={
        <>
          {save.error !== null && (
            <p role="alert" className="text-label text-danger sm:mr-auto">
              {errorMessage(save.error)}
            </p>
          )}
          <Button size="sm" variant="tertiary" onPress={onDone} isDisabled={save.isPending}>
            Cancel
          </Button>
          <Button size="sm" onPress={apply} isPending={save.isPending} isDisabled={!changed || (submitted && invalid)}>
            {newPhase ? `Start phase ${phaseNo + 1}` : "Apply"}
          </Button>
        </>
      }
    >
      <CoverageField value={coverage} onChange={setCoverage} description={`Now ${Math.round(phase.coverage * 100)}%. Raising it keeps the phase.`} />
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-label font-medium">Split</p>
          <Switch
            size="sm"
            isSelected={even}
            onChange={(v) => {
              setEven(v);
              setPercents(evenPercents(n));
            }}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <span className="text-label">Even split</span>
            </Switch.Content>
          </Switch>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {experiment.variations.map((v, i) => (
            <NumberField
              key={v.key}
              value={even ? Number((100 / n).toFixed(1)) : percents[i]}
              onChange={(p) => setPercents(percents.map((x, j) => (j === i ? p : x)))}
              isDisabled={even}
              minValue={0}
              maxValue={100}
              step={0.1}
              aria-label={`${v.name} weight`}
            >
              <NumberField.Group className="grid-cols-[auto_1fr_auto]">
                <span className="flex items-center gap-2 pl-3 text-label whitespace-nowrap">
                  <VariationSwatch index={i} />
                  {v.name}
                </span>
                <NumberField.Input className="text-right tabular" />
                <span className="pr-3 text-label text-muted">%</span>
              </NumberField.Group>
            </NumberField>
          ))}
        </div>
        {Math.abs(total - 1) > 1e-4 && <p className="text-meta text-danger">Weights total {Number((total * 100).toFixed(2))}%; they must total 100%.</p>}
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-label font-medium">Who can enter</p>
        <ConditionBuilder value={conditions} onChange={setConditions} />
      </div>

      {changed && (
        <div
          className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-label ${newPhase ? "border-foreground/30 bg-surface-secondary" : "border-border"}`}
          aria-live="polite"
        >
          {newPhase ? <RotateCcw className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />}
          {newPhase ? (
            <p>
              <span className="font-medium">
                This starts phase {phaseNo + 1} and re-randomizes users; results restart.
              </span>{" "}
              <span className="text-muted">
                Because {changes.join(" and ")}, keeping users in place would bias the comparison. Phase {phaseNo}'s data stays in the record
                but is no longer analyzed.
              </span>
            </p>
          ) : (
            <p>
              <span className="font-medium">Coverage increase keeps the current phase.</span>{" "}
              <span className="text-muted">Users already in the experiment keep their variation; new users join at the same split.</span>
            </p>
          )}
        </div>
      )}
      <TextField value={reason} onChange={setReason} isRequired={newPhase} isInvalid={submitted && newPhase && reason.trim() === ""}>
        <Label>Reason{newPhase ? "" : " (optional)"}</Label>
        <TextArea rows={2} placeholder="e.g. Treatment had a checkout bug in Safari; fixed in 2.4.1" className="resize-y" />
        <Description>Shown on the phase timeline and in History.</Description>
      </TextField>
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
  const { environments } = useEnvironment();
  const [choice, setChoice] = useState(suggestion ?? "");
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const stop = useMutation(orpc.experiments.stop.mutationOptions({ onSuccess: useSaved(onDone) }));
  const shipKey = choice.startsWith("ship:") ? choice.slice(5) : null;
  const shipped = experiment.variations.find((v) => v.key === shipKey);
  const envNames = environments.filter((e) => experiment.environmentIds.includes(e.id)).map((e) => e.name).join(", ");
  const suggested = <span className="ml-1.5 rounded-sm bg-default px-1 py-px text-[11px] font-medium text-muted">Suggested</span>;
  const preview = (value: string) =>
    feature === undefined ? <code className="font-mono">{value}</code> : <ValuePreview valueType={feature.valueType} value={value} />;

  const options = [
    ...experiment.variations.slice(1).map((v, i) => ({
      value: `ship:${v.key}`,
      label: (
        <span className="inline-flex items-center gap-1.5">
          <VariationSwatch index={i + 1} />
          Ship {v.name}
          {suggestion === `ship:${v.key}` && suggested}
        </span>
      ),
      description: "Roll this variation out to everyone in the experiment.",
    })),
    {
      value: "rollback",
      label: <span>Roll back{suggestion === "rollback" && suggested}</span>,
      description: "Remove the change; keep what users had before.",
    },
    { value: "inconclusive", label: "Inconclusive", description: "No clear answer. Remove the rule and record it." },
  ];

  const submit = () => {
    setSubmitted(true);
    if (choice === "" || reason.trim() === "") return;
    stop.mutate({
      id: experiment.id,
      outcome: shipKey === null ? (choice as "rollback" | "inconclusive") : "ship",
      variationKey: shipKey,
      reason: reason.trim(),
    });
  };

  return (
    <ActionPanel
      title="Stop & decide"
      description="Stopping ends assignment and records the decision. It can't be undone; a new experiment is needed to test again."
      footer={
        <>
          {stop.error !== null && (
            <p role="alert" className="text-label text-danger sm:mr-auto">
              {errorMessage(stop.error)}
            </p>
          )}
          <Button size="sm" variant="tertiary" onPress={onDone} isDisabled={stop.isPending}>
            Cancel
          </Button>
          <Button size="sm" onPress={submit} isPending={stop.isPending} isDisabled={submitted && (choice === "" || reason.trim() === "")}>
            {shipped !== undefined ? `Stop and ship ${shipped.name}` : "Stop experiment"}
          </Button>
        </>
      }
    >
      <Segmented label="Decision" value={choice} onChange={setChoice} options={options} />
      {submitted && choice === "" && <p className="-mt-3 text-meta text-danger">Choose a decision.</p>}
      {choice !== "" && (
        <p className="rounded-lg border border-border bg-surface-secondary px-4 py-3 text-label" aria-live="polite">
          {shipped !== undefined ? (
            <>
              The flag will serve {shipped.name}'s value {preview(shipped.value)} to everyone matching the targeting in {envNames}. The
              experiment rule becomes a fixed rule you can edit on the flag later.
            </>
          ) : (
            <>
              The experiment rule is removed from <span className="font-mono">{feature?.key ?? "the flag"}</span> in {envNames}. Users get the
              flag's other rules or its default value{feature === undefined ? "" : <> {preview(feature.defaultValue)}</>}.
              {choice === "inconclusive" && " The decision is recorded as inconclusive."}
            </>
          )}
        </p>
      )}
      <TextField value={reason} onChange={setReason} isRequired isInvalid={submitted && reason.trim() === ""}>
        <Label>Why</Label>
        <TextArea rows={3} placeholder="e.g. +4.2% checkout conversion [+1.1%, +7.3%], guardrails flat, health OK after 14 days" className="resize-y" />
        <Description>Kept with the experiment so the team can find out later what was decided and why.</Description>
      </TextField>
    </ActionPanel>
  );
}
