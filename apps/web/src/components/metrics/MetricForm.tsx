import {
  Button,
  ComboBox,
  Description,
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
import type { EventNameStat } from "@furca/api/contract";
import { BUILTIN_DATA_SOURCE_ID, type DataSource } from "@furca/core/datasources/DataSource";
import type { EventAggregation, Metric, MetricType } from "@furca/core/metrics/Metric";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { formatCount } from "~/components/results/format";
import { RelativeTime } from "~/components/ui/primitives";
import { Segmented } from "~/components/ui/Segmented";
import { useEnvironment } from "~/lib/environment";
import { type client, errorMessage, orpc } from "~/lib/rpc";
import { Direction, metricTypeLabel, MetricSentence } from "./describe";

type MetricInput = Omit<Parameters<typeof client.metrics.create>[0], "key">;
type WindowChoice = "24" | "72" | "168" | "none" | "custom";
type CapType = Metric["capping"]["type"];

interface Draft {
  name: string;
  key: string;
  keyEdited: boolean;
  description: string;
  type: MetricType;
  dataSourceId: string;
  num: { event: string; aggregation: EventAggregation };
  den: { event: string; aggregation: EventAggregation };
  numSql: string;
  denSql: string;
  inverse: boolean;
  window: WindowChoice;
  customWindow: number;
  delayHours: number;
  capType: CapType;
  capAbsolute: number;
  capPercentile: number;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

const presetWindows: ReadonlyArray<WindowChoice> = ["24", "72", "168"];

const toDraft = (m: Metric | undefined): Draft => {
  const d = m?.definition;
  const w = m?.windowHours ?? null;
  return {
    name: m?.name ?? "",
    key: m?.key ?? "",
    keyEdited: m !== undefined,
    description: m?.description ?? "",
    type: m?.type ?? "proportion",
    dataSourceId: m?.dataSourceId ?? BUILTIN_DATA_SOURCE_ID,
    num: d?._tag === "event" ? { ...d.numerator } : { event: "", aggregation: "count" },
    den: d?._tag === "event" && d.denominator !== null ? { ...d.denominator } : { event: "", aggregation: "count" },
    numSql: d?._tag === "sql" ? d.numeratorSql : "",
    denSql: d?._tag === "sql" ? (d.denominatorSql ?? "") : "",
    inverse: m?.inverse ?? false,
    window: m === undefined ? "72" : w === null ? "none" : presetWindows.includes(String(w) as WindowChoice) ? (String(w) as WindowChoice) : "custom",
    customWindow: w ?? 48,
    delayHours: m?.delayHours ?? 0,
    capType: m?.capping.type ?? "none",
    capAbsolute: m?.capping.type === "absolute" ? m.capping.value : 100,
    capPercentile: m?.capping.type === "percentile" ? Number((m.capping.value * 100).toFixed(2)) : 99,
  };
};

const windowHoursOf = (d: Draft): number | null =>
  d.window === "none" ? null : d.window === "custom" ? d.customWindow : Number(d.window);

const toInput = (d: Draft, isSql: boolean): MetricInput => ({
  name: d.name.trim(),
  description: d.description.trim(),
  type: d.type,
  dataSourceId: d.dataSourceId,
  definition: isSql
    ? { _tag: "sql", numeratorSql: d.numSql, denominatorSql: d.type === "ratio" ? d.denSql : null }
    : {
        _tag: "event",
        numerator: { event: d.num.event.trim(), aggregation: d.type === "proportion" ? "count" : d.num.aggregation },
        denominator: d.type === "ratio" ? { event: d.den.event.trim(), aggregation: d.den.aggregation } : null,
      },
  inverse: d.inverse,
  windowHours: windowHoursOf(d),
  delayHours: d.delayHours,
  capping:
    d.type === "proportion" || d.capType === "none"
      ? { type: "none" }
      : d.capType === "absolute"
        ? { type: "absolute", value: d.capAbsolute }
        : { type: "percentile", value: d.capPercentile / 100 },
});

type Errors = Partial<Record<"name" | "key" | "num" | "den" | "window" | "delay" | "cap", string>>;

const validate = (d: Draft, isSql: boolean, isEdit: boolean): Errors => {
  const e: Errors = {};
  if (d.name.trim() === "") e.name = "Give the metric a name";
  if (!isEdit && !KEY_PATTERN.test(d.key)) e.key = "Use lowercase letters, digits, - and _ (max 64)";
  if (isSql) {
    if (d.numSql.trim() === "") e.num = "Write the SQL that returns one row per event";
    if (d.type === "ratio" && d.denSql.trim() === "") e.den = "Ratio metrics need a denominator query";
  } else {
    if (d.num.event.trim() === "") e.num = "Pick or type an event name";
    if (d.type === "ratio" && d.den.event.trim() === "") e.den = "Ratio metrics need a denominator event";
  }
  const w = windowHoursOf(d);
  if (w !== null && !(w > 0)) e.window = "The window must be longer than 0 hours";
  if (!(d.delayHours >= 0)) e.delay = "Delay can't be negative";
  else if (w !== null && d.delayHours >= w) e.delay = "Delay must be shorter than the window";
  if (d.type !== "proportion") {
    if (d.capType === "absolute" && !(d.capAbsolute > 0)) e.cap = "Cap must be greater than 0";
    if (d.capType === "percentile" && !(d.capPercentile >= 50 && d.capPercentile < 100))
      e.cap = "Use a percentile between 50 and 99.99";
  }
  return e;
};

const sqlTemplate = (bq: DataSource["bigquery"], event: string) => `-- One row per event. Required columns:
--   user_id STRING, timestamp TIMESTAMP, value FLOAT64 (use 1 to count)
SELECT
  user_pseudo_id AS user_id,
  TIMESTAMP_MICROS(event_timestamp) AS timestamp,
  1 AS value
FROM \`${bq?.projectId || "<project>"}.${bq?.dataset || "<dataset>"}.events_*\`
WHERE event_name = '${event}'`;

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 border-b border-border px-5 py-5">
      <div>
        <h3 className="text-body font-medium">{title}</h3>
        {description !== undefined && <p className="mt-0.5 text-label text-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function EventField({
  label,
  value,
  onChange,
  names,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  names: ReadonlyArray<EventNameStat>;
  error?: string;
}) {
  return (
    <ComboBox
      allowsCustomValue
      menuTrigger="focus"
      inputValue={value}
      onInputChange={onChange}
      items={names}
      isInvalid={error !== undefined}
      className="min-w-0 flex-1"
    >
      <Label>{label}</Label>
      <ComboBox.InputGroup>
        <Input placeholder="purchase" spellCheck={false} autoComplete="off" className="font-mono" />
        <ComboBox.Trigger />
      </ComboBox.InputGroup>
      <ComboBox.Popover className="min-w-[min(420px,calc(100vw-32px))]">
        <ListBox>
          {(n: EventNameStat) => (
            <ListBox.Item id={n.name} textValue={n.name} className="gap-4">
              <span className="min-w-0 flex-1 truncate font-mono text-label">{n.name}</span>
              <span className="shrink-0 text-meta text-muted tabular">
                {formatCount(n.count)} · <RelativeTime date={n.lastSeenAt} />
              </span>
            </ListBox.Item>
          )}
        </ListBox>
      </ComboBox.Popover>
      <FieldError>{error}</FieldError>
    </ComboBox>
  );
}

const aggregationHelp: Record<EventAggregation, ReactNode> = {
  count: "Counts each track() call.",
  sum: (
    <>
      Adds up the <code className="font-mono">value</code> passed to{" "}
      <code className="font-mono">track(name, value)</code>, e.g. revenue in cents.
    </>
  ),
};

function AggregationField({ value, onChange }: { value: EventAggregation; onChange: (v: EventAggregation) => void }) {
  return (
    <Segmented
      label="Aggregate"
      value={value}
      onChange={onChange}
      options={[
        { value: "count", label: "Count" },
        { value: "sum", label: "Sum of value" },
      ]}
      description={aggregationHelp[value]}
    />
  );
}

function SqlField({
  label,
  value,
  onChange,
  onTemplate,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onTemplate: () => void;
  error?: string;
}) {
  return (
    <TextField value={value} onChange={onChange} isInvalid={error !== undefined} className="w-full">
      <div className="flex items-end justify-between gap-3">
        <Label>{label}</Label>
        <Button size="sm" variant="ghost" className="h-7 text-label" onPress={onTemplate}>
          Insert template
        </Button>
      </div>
      <TextArea
        rows={9}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        placeholder="SELECT user_id, timestamp, value FROM …"
        className="w-full resize-y font-mono text-[0.8125rem] leading-5"
      />
      <Description>
        One row per event with columns <code className="font-mono">user_id</code> STRING,{" "}
        <code className="font-mono">timestamp</code> TIMESTAMP, <code className="font-mono">value</code> FLOAT64 (use 1 to
        count). furca joins it to exposures by <code className="font-mono">user_id</code>.
      </Description>
      <FieldError>{error}</FieldError>
    </TextField>
  );
}

/** Create or edit a metric. Explains each choice in plain words and previews the result as a sentence */
export function MetricForm({
  metric,
  onSaved,
  onCancel,
}: {
  metric?: Metric;
  onSaved: (metric: Metric) => void;
  onCancel: () => void;
}) {
  const isEdit = metric !== undefined;
  const queryClient = useQueryClient();
  const { current: env } = useEnvironment();
  const [d, setDraft] = useState(() => toDraft(metric));
  const [submitted, setSubmitted] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...patch }));

  const sources = useQuery(orpc.dataSources.list.queryOptions());
  const names = useQuery({
    ...orpc.events.names.queryOptions({ input: { environmentId: env?.id ?? "" } }),
    enabled: env !== null,
  });
  const sourceList = sources.data ?? [];
  const source = sourceList.find((s) => s.id === d.dataSourceId);
  const isSql = d.dataSourceId !== BUILTIN_DATA_SOURCE_ID && source?.type !== "builtin";
  const eventNames = names.data ?? [];

  const onSuccess = (saved: Metric) => {
    void queryClient.invalidateQueries({ queryKey: orpc.metrics.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
    onSaved(saved);
  };
  const create = useMutation(orpc.metrics.create.mutationOptions({ onSuccess }));
  const update = useMutation(orpc.metrics.update.mutationOptions({ onSuccess }));
  const save = isEdit ? update : create;

  const errors = submitted ? validate(d, isSql, isEdit) : {};
  const input = toInput(d, isSql);

  const submit = () => {
    setSubmitted(true);
    if (Object.keys(validate(d, isSql, isEdit)).length > 0) return;
    if (isEdit) update.mutate({ id: metric.id, ...input });
    else create.mutate({ key: d.key, ...input });
  };

  const changeType = (type: MetricType) =>
    set({ type, num: type === "proportion" ? { ...d.num, aggregation: "count" } : d.num });

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]"
    >
      <section className="min-w-0 rounded-[10px] border border-border bg-surface">
        <Section title="Basics">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              value={d.name}
              onChange={(name) => set({ name, key: d.keyEdited ? d.key : slugify(name) })}
              isInvalid={errors.name !== undefined}
              isRequired
              autoFocus={!isEdit}
            >
              <Label>Name</Label>
              <Input placeholder="Checkout conversion" />
              <FieldError>{errors.name}</FieldError>
            </TextField>
            <TextField
              value={d.key}
              onChange={(key) => set({ key, keyEdited: true })}
              isInvalid={errors.key !== undefined}
              isReadOnly={isEdit}
              isRequired={!isEdit}
            >
              <Label>Key</Label>
              <Input placeholder="checkout-conversion" spellCheck={false} className="font-mono" />
              <Description>{isEdit ? "Keys can't change once created." : "Used in URLs and the API."}</Description>
              <FieldError>{errors.key}</FieldError>
            </TextField>
          </div>
          <TextField value={d.description} onChange={(description) => set({ description })}>
            <Label>Description</Label>
            <TextArea rows={2} placeholder="Optional. What this metric tells you and when to use it." className="resize-y" />
          </TextField>
        </Section>

        <Section title="What to measure">
          <Segmented
            label="Type"
            value={d.type}
            onChange={changeType}
            options={[
              { value: "proportion", label: "Conversion", description: "Share of users who did X at least once." },
              { value: "mean", label: "Mean", description: "Average count or sum of X per user." },
              { value: "ratio", label: "Ratio", description: "Sum of X ÷ sum of Y across users." },
            ]}
          />
          <Select
            value={d.dataSourceId}
            onChange={(id) => typeof id === "string" && set({ dataSourceId: id })}
            className="sm:max-w-sm"
          >
            <Label>Data source</Label>
            <Select.Trigger>
              <Select.Value>{({ selectedText }) => selectedText}</Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {(sourceList.length > 0
                  ? sourceList
                  : [{ id: BUILTIN_DATA_SOURCE_ID, name: "Built-in events", type: "builtin" as const }]
                ).map((s) => (
                  <ListBox.Item key={s.id} id={s.id} textValue={s.name}>
                    <span className="flex-1 truncate">{s.name}</span>
                    <span className="text-meta text-muted">{s.type === "builtin" ? "SDK events" : "BigQuery"}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
            <Description>
              {isSql ? "Events come from your BigQuery SQL." : "Events your app sends with the SDK's track()."}
            </Description>
          </Select>

          {isSql ? (
            <>
              <SqlField
                label={d.type === "ratio" ? "Numerator SQL" : "Event SQL"}
                value={d.numSql}
                onChange={(numSql) => set({ numSql })}
                onTemplate={() => set({ numSql: sqlTemplate(source?.bigquery ?? null, "purchase") })}
                error={errors.num}
              />
              {d.type === "ratio" && (
                <SqlField
                  label="Denominator SQL"
                  value={d.denSql}
                  onChange={(denSql) => set({ denSql })}
                  onTemplate={() => set({ denSql: sqlTemplate(source?.bigquery ?? null, "add_to_cart") })}
                  error={errors.den}
                />
              )}
            </>
          ) : (
            <>
              <div className="flex flex-col gap-4">
                {d.type === "ratio" && <p className="-mb-2 text-label font-medium text-muted">Numerator</p>}
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <EventField
                    label="Event"
                    value={d.num.event}
                    onChange={(event) => set({ num: { ...d.num, event } })}
                    names={eventNames}
                    error={errors.num}
                  />
                  {d.type !== "proportion" && (
                    <div className="sm:w-[260px]">
                      <AggregationField
                        value={d.num.aggregation}
                        onChange={(aggregation) => set({ num: { ...d.num, aggregation } })}
                      />
                    </div>
                  )}
                </div>
              </div>
              {d.type === "ratio" && (
                <div className="flex flex-col gap-4 border-t border-border pt-4">
                  <p className="-mb-2 text-label font-medium text-muted">Denominator</p>
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                    <EventField
                      label="Event"
                      value={d.den.event}
                      onChange={(event) => set({ den: { ...d.den, event } })}
                      names={eventNames}
                      error={errors.den}
                    />
                    <div className="sm:w-[260px]">
                      <AggregationField
                        value={d.den.aggregation}
                        onChange={(aggregation) => set({ den: { ...d.den, aggregation } })}
                      />
                    </div>
                  </div>
                </div>
              )}
              <p className="text-xs text-muted">
                {names.isError
                  ? "Event suggestions are unavailable right now. Type the event name you send with track()."
                  : eventNames.length > 0
                    ? `Suggestions are events received in ${env?.name ?? "this environment"} over the last 30 days. You can also type a name that hasn't arrived yet.`
                    : `No events received in ${env?.name ?? "this environment"} yet. Type the name you will send with furca.track("purchase").`}
              </p>
            </>
          )}
        </Section>

        <Section
          title="Conversion window"
          description="Counted from each user's first exposure to the experiment. Shorter windows give faster, cleaner reads."
        >
          <div className="flex flex-wrap items-end gap-4">
            <Segmented
              label="Window"
              value={d.window}
              onChange={(window) => set({ window })}
              options={[
                { value: "24", label: "24h" },
                { value: "72", label: "72h" },
                { value: "168", label: "7d" },
                { value: "none", label: "None" },
                { value: "custom", label: "Custom" },
              ]}
            />
            {d.window === "custom" && (
              <NumberField
                value={d.customWindow}
                onChange={(customWindow) => set({ customWindow })}
                minValue={1}
                isInvalid={errors.window !== undefined}
                className="w-32"
                aria-label="Window in hours"
              >
                <NumberField.Group className="grid-cols-[1fr_auto]">
                  <NumberField.Input className="tabular" />
                  <span className="pr-3 text-label text-muted">hours</span>
                </NumberField.Group>
              </NumberField>
            )}
          </div>
          {errors.window !== undefined && <p className="-mt-2 text-xs text-danger">{errors.window}</p>}
          <NumberField
            value={d.delayHours}
            onChange={(delayHours) => set({ delayHours: Number.isNaN(delayHours) ? 0 : delayHours })}
            minValue={0}
            isInvalid={errors.delay !== undefined}
            className="w-full sm:max-w-sm"
          >
            <Label>Delay</Label>
            <NumberField.Group className="grid-cols-[1fr_auto]">
              <NumberField.Input className="tabular" />
              <span className="pr-3 text-label text-muted">hours</span>
            </NumberField.Group>
            <Description>Ignore events in the first hours after exposure, e.g. to skip the visit that triggered it.</Description>
            <FieldError>{errors.delay}</FieldError>
          </NumberField>
        </Section>

        <Section title="Analysis">
          <Switch isSelected={d.inverse} onChange={(inverse) => set({ inverse })} className="[--switch-control-bg:oklch(0.9_0_0)] dark:[--switch-control-bg:var(--default)]">
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb className={d.inverse ? "" : "dark:bg-[oklch(0.62_0_0)]"} />
              </Switch.Control>
              Lower is better
            </Switch.Content>
            <Description>
              For metrics you want to go down, like latency, errors or churn. A decrease then counts as winning.
            </Description>
          </Switch>
          {d.type !== "proportion" && (
            <div className="flex flex-col gap-3">
              <Segmented
                label="Capping"
                value={d.capType}
                onChange={(capType) => set({ capType })}
                options={[
                  { value: "none", label: "None" },
                  { value: "absolute", label: "Absolute" },
                  { value: "percentile", label: "Percentile" },
                ]}
                description="Protects against a single whale: one user with an unusually large total can swing the average. Capping limits each user's total before variations are compared."
              />
              {d.capType !== "none" && (
                <NumberField
                  value={d.capType === "absolute" ? d.capAbsolute : d.capPercentile}
                  onChange={(v) => set(d.capType === "absolute" ? { capAbsolute: v } : { capPercentile: v })}
                  minValue={0}
                  step={d.capType === "absolute" ? 1 : 0.1}
                  isInvalid={errors.cap !== undefined}
                  className="w-full sm:max-w-sm"
                >
                  <Label>{d.capType === "absolute" ? "Cap each user's total at" : "Cap each user at percentile"}</Label>
                  <NumberField.Group className={d.capType === "percentile" ? "grid-cols-[1fr_auto]" : undefined}>
                    <NumberField.Input className="tabular" />
                    {d.capType === "percentile" && <span className="pr-3 text-label text-muted">th</span>}
                  </NumberField.Group>
                  <Description>
                    {d.capType === "absolute"
                      ? "In the metric's own unit, e.g. 50000 for revenue in cents."
                      : "Computed across all variations at each analysis. 99 is a good default."}
                  </Description>
                  <FieldError>{errors.cap}</FieldError>
                </NumberField>
              )}
            </div>
          )}
        </Section>

        <footer className="flex flex-wrap items-center justify-end gap-3 px-5 py-4">
          {save.error !== null && (
            <p role="alert" className="basis-full text-label text-danger sm:mr-auto sm:basis-auto">
              {errorMessage(save.error)}
            </p>
          )}
          {submitted && Object.keys(errors).length > 0 && save.error === null && (
            <p role="alert" className="basis-full text-label text-danger sm:mr-auto sm:basis-auto">
              Fix the highlighted fields to continue.
            </p>
          )}
          <Button variant="tertiary" size="sm" onPress={onCancel} isDisabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" size="sm" isPending={save.isPending}>
            {isEdit ? "Save changes" : "Create metric"}
          </Button>
        </footer>
      </section>

      <aside className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-5 lg:sticky lg:top-8">
        <h3 className="text-meta font-medium text-muted">Preview</h3>
        <p className="text-body leading-relaxed" aria-live="polite">
          <MetricSentence metric={input} />
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-border pt-3 text-label">
          <dt className="text-muted">Type</dt>
          <dd>{metricTypeLabel[d.type]}</dd>
          <dt className="text-muted">Goal</dt>
          <dd>
            <Direction inverse={d.inverse} />
          </dd>
          <dt className="text-muted">Source</dt>
          <dd className="truncate">{source?.name ?? "Built-in events"}</dd>
        </dl>
      </aside>
    </form>
  );
}
