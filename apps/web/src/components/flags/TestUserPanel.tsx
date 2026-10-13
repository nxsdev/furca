import type { Environment } from "@kuji/core/environments/Environment";
import type { Experiment } from "@kuji/core/experiments/Experiment";
import type { Feature } from "@kuji/core/features/Feature";
import type { SdkPayload } from "@kuji/sdk";
import { Button, Input, Skeleton, TextArea, TextField } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Check, Info, Minus, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Panel, PanelHeader } from "~/components/ui/primitives";
import { errorMessage, orpc } from "~/lib/rpc";
import type { Rule } from "./RulesEditor";
import { Segmented } from "./Segmented";
import { alignRules, traceEvaluation } from "./simulate";
import { ValuePreview } from "./ValueInput";

interface Row {
  readonly id: string;
  readonly key: string;
  readonly value: string;
}

const row = (key: string, value = ""): Row => ({ id: crypto.randomUUID(), key, value });

const parsePayload = (json: string): SdkPayload | null => {
  try {
    const p: unknown = JSON.parse(json);
    return p !== null && typeof p === "object" && "features" in p ? (p as SdkPayload) : null;
  } catch {
    return null;
  }
};

const rowsToJson = (rows: ReadonlyArray<Row>) =>
  JSON.stringify(Object.fromEntries(rows.filter((r) => r.key !== "" && r.value !== "").map((r) => [r.key, r.value])), null, 2);

/**
 * State for the "Test a user" simulator: attributes, the published payload of the environment and
 * the SDK evaluation trace. Lives in the page so the rules list can highlight the matching rule
 */
export function useTestUser({
  feature,
  environment,
  savedRules,
  experimentsById,
}: {
  feature: Feature;
  environment: Environment | undefined;
  savedRules: ReadonlyArray<Rule>;
  experimentsById: ReadonlyMap<string, Experiment>;
}) {
  const [rows, setRows] = useState<ReadonlyArray<Row>>(() => {
    const used = feature.environments.flatMap((e) =>
      e.rules.flatMap((r) => (r._tag === "experiment" ? [] : [...r.conditions.map((c) => c.attribute), ...(r._tag === "rollout" ? [r.hashAttribute] : [])])),
    );
    return [...new Set(["id", ...used])].filter(Boolean).map((k) => row(k));
  });
  const [mode, setMode] = useState<"rows" | "json">("rows");
  const [json, setJson] = useState("{}");
  const payload = useQuery({
    ...orpc.environments.payload.queryOptions({ input: { id: environment?.id ?? "" } }),
    enabled: environment !== undefined,
    select: parsePayload,
  });

  const parsedJson = useMemo((): { value: Record<string, unknown> | null; error: string | null } => {
    if (mode !== "json") return { value: null, error: null };
    try {
      const v: unknown = JSON.parse(json);
      return v !== null && typeof v === "object" && !Array.isArray(v)
        ? { value: v as Record<string, unknown>, error: null }
        : { value: null, error: "Attributes must be a JSON object" };
    } catch {
      return { value: null, error: "Not valid JSON yet" };
    }
  }, [mode, json]);

  const attributes = useMemo(
    () =>
      mode === "json"
        ? parsedJson.value
        : Object.fromEntries(rows.filter((r) => r.key.trim() !== "" && r.value !== "").map((r) => [r.key.trim(), r.value])),
    [mode, rows, parsedJson.value],
  );

  const result = useMemo(() => {
    if (payload.data === undefined || attributes === null) return null;
    const trace = traceEvaluation(payload.data, feature.key, attributes);
    const keys = new Map([...experimentsById].map(([id, x]) => [id, x.key]));
    const ruleIds = alignRules(payload.data?.features[feature.key]?.rules ?? [], savedRules, keys);
    return { ...trace, ruleIds, matchedRuleId: trace.evaluation.ruleIndex >= 0 ? (ruleIds[trace.evaluation.ruleIndex] ?? null) : null };
  }, [payload.data, attributes, feature.key, savedRules, experimentsById]);

  const switchMode = (next: "rows" | "json") => {
    if (next === "json") setJson(rowsToJson(rows));
    else if (parsedJson.value !== null)
      setRows(Object.entries(parsedJson.value).map(([k, v]) => row(k, typeof v === "string" ? v : JSON.stringify(v))));
    setMode(next);
  };

  return { rows, setRows, mode, switchMode, json, setJson, jsonError: parsedJson.error, payload, result };
}

export type TestUserState = ReturnType<typeof useTestUser>;

export function TestUserPanel({
  state,
  feature,
  environment,
  ruleNumber,
  hasUnsavedChanges,
}: {
  state: TestUserState;
  feature: Feature;
  environment: Environment;
  /** 1-based position of a rule id in the list shown on the page */
  ruleNumber: (id: string | null) => number | null;
  hasUnsavedChanges: boolean;
}) {
  const { rows, setRows, mode, switchMode, json, setJson, jsonError, payload, result } = state;
  const [focusId, setFocusId] = useState<string | null>(null);
  const update = (id: string, patch: Partial<Row>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <Panel>
      <PanelHeader
        title="Test a user"
        description={`Evaluates the published ${environment.name} payload, exactly like the SDK.`}
      />
      <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-label font-medium">Attributes</span>
          <Segmented
            aria-label="Attribute editor"
            value={mode}
            onChange={switchMode}
            options={[
              { id: "rows", label: "Fields" },
              { id: "json", label: "JSON" },
            ]}
          />
        </div>
        {mode === "rows" ? (
          <div className="flex flex-col gap-1.5">
            {rows.map((r) => (
              <div key={r.id} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_2rem] gap-1.5">
                <TextField aria-label="Attribute name" value={r.key} onChange={(key) => update(r.id, { key })}>
                  <Input className="h-8 py-1 font-mono text-base sm:text-label" placeholder="attribute" spellCheck={false} autoFocus={r.id === focusId} />
                </TextField>
                <TextField aria-label={`Value of ${r.key || "attribute"}`} value={r.value} onChange={(value) => update(r.id, { value })}>
                  <Input className="h-8 py-1 font-mono text-base sm:text-label" placeholder="not set" spellCheck={false} />
                </TextField>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${r.key || "attribute"}`}
                  className="size-8 min-w-8 text-muted hover:text-foreground"
                  onPress={() => setRows(rows.filter((x) => x.id !== r.id))}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))}
            <div>
              <Button
                size="sm"
                variant="ghost"
                className="-ml-2 h-7 px-2 text-label text-muted hover:text-foreground"
                onPress={() => {
                  const added = row("");
                  setRows([...rows, added]);
                  setFocusId(added.id);
                }}
              >
                <Plus className="size-3.5" />
                Add attribute
              </Button>
            </div>
          </div>
        ) : (
          <TextField aria-label="Attributes JSON" value={json} onChange={setJson} isInvalid={jsonError !== null}>
            <TextArea rows={6} spellCheck={false} className="w-full font-mono text-base sm:text-label leading-5" />
            {jsonError !== null && <p className="mt-1 text-meta text-danger">{jsonError}</p>}
          </TextField>
        )}
      </div>
      <div className="border-t border-border bg-surface-secondary/60 px-4 py-4 sm:px-5" aria-live="polite">
        {payload.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-6 w-24 rounded-md" />
            <Skeleton className="h-4 w-48 rounded-md" />
          </div>
        ) : payload.error !== null ? (
          <div className="flex items-center justify-between gap-3 text-label">
            <span className="text-danger">Could not load the payload. {errorMessage(payload.error)}</span>
            <Button size="sm" variant="outline" onPress={() => payload.refetch()}>
              Retry
            </Button>
          </div>
        ) : result === null ? (
          <p className="text-label text-muted">Fix the attributes JSON to see the result.</p>
        ) : (
          <Result
            feature={feature}
            environment={environment}
            result={result}
            ruleNumber={ruleNumber}
          />
        )}
        {hasUnsavedChanges && (
          <p className="mt-3 flex items-start gap-1.5 text-meta text-muted">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            You have unsaved rule changes. Save them to test the new rules.
          </p>
        )}
      </div>
    </Panel>
  );
}

function Result({
  feature,
  environment,
  result,
  ruleNumber,
}: {
  feature: Feature;
  environment: Environment;
  result: NonNullable<TestUserState["result"]>;
  ruleNumber: (id: string | null) => number | null;
}) {
  const { evaluation, steps, ruleIds } = result;
  const label = (index: number) => {
    const n = ruleNumber(ruleIds[index] ?? null);
    return n === null ? `Published rule ${index + 1}` : `Rule ${n}`;
  };
  const kind = { force: "Force", rollout: "Rollout", experiment: "Experiment" } as const;

  if (evaluation.source === "unknown") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-meta font-medium text-muted">Serves</span>
        <span className="text-body font-medium">Your code's fallback</span>
        <p className="text-label text-muted">
          {feature.key} is off in {environment.name} (or not published yet), so it isn't in the payload.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-meta font-medium text-muted">Serves</span>
        <div>
          <ValuePreview valueType={feature.valueType} value={JSON.stringify(evaluation.value)} className="text-body" />
        </div>
        <p className="text-label text-muted">
          {evaluation.source === "default"
            ? "No rule matched, so the default value is served."
            : `${label(evaluation.ruleIndex)} matched${evaluation.experiment ? `: variation ${evaluation.experiment.variationKey}` : ""}.`}
        </p>
      </div>
      {steps.length > 0 && (
        <ol className="flex flex-col gap-1.5 border-t border-border pt-3" aria-label="Evaluation steps">
          {steps.map((s) => (
            <li key={s.index} className="flex items-start gap-2 text-label">
              {s.matched ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-focus" aria-label="Matched" />
              ) : (
                <Minus className="mt-0.5 size-3.5 shrink-0 text-muted" aria-label="Skipped" />
              )}
              <span className="min-w-0">
                <span className="font-medium">
                  {label(s.index)} · {kind[s.rule.type]}
                </span>
                <span className="text-muted"> — {s.reason}</span>
              </span>
            </li>
          ))}
          {evaluation.source === "default" && (
            <li className="flex items-start gap-2 text-label">
              <Check className="mt-0.5 size-3.5 shrink-0 text-focus" aria-label="Matched" />
              <span className="font-medium">Default value</span>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
