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
import { Trans, useTranslation } from "react-i18next";
import { dataSourceName } from "~/components/datasources/name";
import { formatCount } from "~/components/results/format";
import { RelativeTime } from "~/components/ui/primitives";
import { Segmented } from "~/components/ui/Segmented";
import { i18n } from "~/i18n";
import { useEnvironment } from "~/lib/environment";
import { type client, errorMessage, orpc } from "~/lib/rpc";
import { Direction, formatHours, metricTypeLabel, MetricSentence } from "./describe";

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
  if (d.name.trim() === "") e.name = i18n.t("metrics:form.errors.name");
  if (!isEdit && !KEY_PATTERN.test(d.key)) e.key = i18n.t("metrics:form.errors.key");
  if (isSql) {
    if (d.numSql.trim() === "") e.num = i18n.t("metrics:form.errors.numSql");
    if (d.type === "ratio" && d.denSql.trim() === "") e.den = i18n.t("metrics:form.errors.denSql");
  } else {
    if (d.num.event.trim() === "") e.num = i18n.t("metrics:form.errors.numEvent");
    if (d.type === "ratio" && d.den.event.trim() === "") e.den = i18n.t("metrics:form.errors.denEvent");
  }
  const w = windowHoursOf(d);
  if (w !== null && !(w > 0)) e.window = i18n.t("metrics:form.errors.window");
  if (!(d.delayHours >= 0)) e.delay = i18n.t("metrics:form.errors.delayNegative");
  else if (w !== null && d.delayHours >= w) e.delay = i18n.t("metrics:form.errors.delayTooLong");
  if (d.type !== "proportion") {
    if (d.capType === "absolute" && !(d.capAbsolute > 0)) e.cap = i18n.t("metrics:form.errors.capAbsolute");
    if (d.capType === "percentile" && !(d.capPercentile >= 50 && d.capPercentile < 100))
      e.cap = i18n.t("metrics:form.errors.capPercentile");
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

const code = <code className="font-mono" />;

function AggregationField({ value, onChange }: { value: EventAggregation; onChange: (v: EventAggregation) => void }) {
  const { t } = useTranslation("metrics");
  return (
    <Segmented
      label={t("form.aggregation.label")}
      value={value}
      onChange={onChange}
      options={[
        { value: "count", label: t("form.aggregation.count") },
        { value: "sum", label: t("form.aggregation.sum") },
      ]}
      description={
        value === "count" ? t("form.aggregation.countHelp") : <Trans t={t} i18nKey="form.aggregation.sumHelp" components={{ c: code }} />
      }
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
  const { t } = useTranslation("metrics");
  return (
    <TextField value={value} onChange={onChange} isInvalid={error !== undefined} className="w-full">
      <div className="flex items-end justify-between gap-3">
        <Label>{label}</Label>
        <Button size="sm" variant="ghost" className="h-7 text-label" onPress={onTemplate}>
          {t("form.sql.insertTemplate")}
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
        <Trans t={t} i18nKey="form.sql.help" components={{ c: code }} />
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
  const { t } = useTranslation(["metrics", "common"]);
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
        <Section title={t("form.sections.basics")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              value={d.name}
              onChange={(name) => set({ name, key: d.keyEdited ? d.key : slugify(name) })}
              isInvalid={errors.name !== undefined}
              isRequired
              autoFocus={!isEdit}
            >
              <Label>{t("form.name.label")}</Label>
              <Input placeholder={t("form.name.placeholder")} />
              <FieldError>{errors.name}</FieldError>
            </TextField>
            <TextField
              value={d.key}
              onChange={(key) => set({ key, keyEdited: true })}
              isInvalid={errors.key !== undefined}
              isReadOnly={isEdit}
              isRequired={!isEdit}
            >
              <Label>{t("form.key.label")}</Label>
              <Input placeholder="checkout-conversion" spellCheck={false} className="font-mono" />
              <Description>{isEdit ? t("form.key.readOnly") : t("form.key.help")}</Description>
              <FieldError>{errors.key}</FieldError>
            </TextField>
          </div>
          <TextField value={d.description} onChange={(description) => set({ description })}>
            <Label>{t("form.description.label")}</Label>
            <TextArea rows={2} placeholder={t("form.description.placeholder")} className="resize-y" />
          </TextField>
        </Section>

        <Section title={t("form.sections.measure")}>
          <Segmented
            label={t("form.type.label")}
            value={d.type}
            onChange={changeType}
            options={(["proportion", "mean", "ratio"] as const).map((type) => ({
              value: type,
              label: metricTypeLabel(type),
              description: t(`form.type.${type}`),
            }))}
          />
          <Select
            value={d.dataSourceId}
            onChange={(id) => typeof id === "string" && set({ dataSourceId: id })}
            className="sm:max-w-sm"
          >
            <Label>{t("form.dataSource.label")}</Label>
            <Select.Trigger>
              <Select.Value>{({ selectedText }) => selectedText}</Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {(sourceList.length > 0
                  ? sourceList
                  : [{ id: BUILTIN_DATA_SOURCE_ID, name: t("builtinEvents"), type: "builtin" as const }]
                ).map((s) => (
                  <ListBox.Item key={s.id} id={s.id} textValue={dataSourceName(s)}>
                    <span className="flex-1 truncate">{dataSourceName(s)}</span>
                    <span className="text-meta text-muted">{s.type === "builtin" ? t("form.dataSource.sdkEvents") : "BigQuery"}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
            <Description>
              {isSql ? t("form.dataSource.sqlHelp") : t("form.dataSource.sdkHelp")}
            </Description>
          </Select>

          {isSql ? (
            <>
              <SqlField
                label={d.type === "ratio" ? t("form.sql.numerator") : t("form.sql.event")}
                value={d.numSql}
                onChange={(numSql) => set({ numSql })}
                onTemplate={() => set({ numSql: sqlTemplate(source?.bigquery ?? null, "purchase") })}
                error={errors.num}
              />
              {d.type === "ratio" && (
                <SqlField
                  label={t("form.sql.denominator")}
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
                {d.type === "ratio" && <p className="-mb-2 text-label font-medium text-muted">{t("form.event.numerator")}</p>}
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <EventField
                    label={t("form.event.label")}
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
                  <p className="-mb-2 text-label font-medium text-muted">{t("form.event.denominator")}</p>
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                    <EventField
                      label={t("form.event.label")}
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
                  ? t("form.event.unavailable")
                  : t(eventNames.length > 0 ? "form.event.suggestions" : "form.event.none", {
                      environment: env?.name ?? t("form.event.thisEnvironment"),
                    })}
              </p>
            </>
          )}
        </Section>

        <Section title={t("form.sections.window")} description={t("form.sections.windowDescription")}>
          <div className="flex flex-wrap items-end gap-4">
            <Segmented
              label={t("form.window.label")}
              value={d.window}
              onChange={(window) => set({ window })}
              options={[
                ...presetWindows.map((w) => ({ value: w, label: formatHours(Number(w)) })),
                { value: "none", label: t("common:states.none") },
                { value: "custom", label: t("form.window.custom") },
              ]}
            />
            {d.window === "custom" && (
              <NumberField
                value={d.customWindow}
                onChange={(customWindow) => set({ customWindow })}
                minValue={1}
                isInvalid={errors.window !== undefined}
                className="w-32"
                aria-label={t("form.window.customLabel")}
              >
                <NumberField.Group className="grid-cols-[1fr_auto]">
                  <NumberField.Input className="tabular" />
                  <span className="pr-3 text-label text-muted">{t("form.window.hours")}</span>
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
            <Label>{t("form.window.delay")}</Label>
            <NumberField.Group className="grid-cols-[1fr_auto]">
              <NumberField.Input className="tabular" />
              <span className="pr-3 text-label text-muted">{t("form.window.hours")}</span>
            </NumberField.Group>
            <Description>{t("form.window.delayHelp")}</Description>
            <FieldError>{errors.delay}</FieldError>
          </NumberField>
        </Section>

        <Section title={t("form.sections.analysis")}>
          <Switch isSelected={d.inverse} onChange={(inverse) => set({ inverse })} className="[--switch-control-bg:oklch(0.9_0_0)] dark:[--switch-control-bg:var(--default)]">
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb className={d.inverse ? "" : "dark:bg-[oklch(0.62_0_0)]"} />
              </Switch.Control>
              {t("direction.lowerIsBetter")}
            </Switch.Content>
            <Description>{t("form.inverseHelp")}</Description>
          </Switch>
          {d.type !== "proportion" && (
            <div className="flex flex-col gap-3">
              <Segmented
                label={t("form.capping.label")}
                value={d.capType}
                onChange={(capType) => set({ capType })}
                options={[
                  { value: "none", label: t("common:states.none") },
                  { value: "absolute", label: t("form.capping.absolute") },
                  { value: "percentile", label: t("form.capping.percentile") },
                ]}
                description={t("form.capping.help")}
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
                  <Label>{d.capType === "absolute" ? t("form.capping.absoluteLabel") : t("form.capping.percentileLabel")}</Label>
                  <NumberField.Group className={d.capType === "percentile" ? "grid-cols-[1fr_auto]" : undefined}>
                    <NumberField.Input className="tabular" />
                    {d.capType === "percentile" && <span className="pr-3 text-label text-muted">{t("form.capping.percentileSuffix")}</span>}
                  </NumberField.Group>
                  <Description>
                    {d.capType === "absolute" ? t("form.capping.absoluteHelp") : t("form.capping.percentileHelp")}
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
              {t("form.errors.fixFields")}
            </p>
          )}
          <Button variant="tertiary" size="sm" onPress={onCancel} isDisabled={save.isPending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" size="sm" isPending={save.isPending}>
            {isEdit ? t("form.saveChanges") : t("form.create")}
          </Button>
        </footer>
      </section>

      <aside className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-5 lg:sticky lg:top-8">
        <h3 className="text-meta font-medium text-muted">{t("form.preview.title")}</h3>
        <p className="text-body leading-relaxed" aria-live="polite">
          <MetricSentence metric={input} />
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-border pt-3 text-label">
          <dt className="text-muted">{t("form.preview.type")}</dt>
          <dd>{metricTypeLabel(d.type)}</dd>
          <dt className="text-muted">{t("form.preview.goal")}</dt>
          <dd>
            <Direction inverse={d.inverse} />
          </dd>
          <dt className="text-muted">{t("form.preview.source")}</dt>
          <dd className="truncate">{source === undefined ? t("builtinEvents") : dataSourceName(source)}</dd>
        </dl>
      </aside>
    </form>
  );
}
