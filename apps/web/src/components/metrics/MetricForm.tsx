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
import { type EventNameStat, Key } from "@furca/api/contract";
import { BUILTIN_DATA_SOURCE_ID, type DataSource } from "@furca/core/datasources/DataSource";
import type { EventAggregation, Metric, MetricType } from "@furca/core/metrics/Metric";
import { type AnyFieldApi, type DeepKeys, useStore } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { dataSourceName } from "~/components/datasources/name";
import { errorText, setServerError, submitHandler, useAppForm } from "~/components/form/form";
import { formatCount } from "~/components/results/format";
import { RelativeTime } from "~/components/ui/primitives";
import { Segmented } from "~/components/ui/Segmented";
import { i18n } from "~/i18n";
import { useEnvironment } from "~/lib/environment";
import { client, errorMessage, orpc } from "~/lib/rpc";
import { Direction, formatHours, metricTypeLabel, MetricSentence } from "./describe";
import { slugify } from "./slugify";

type MetricInput = Omit<Parameters<typeof client.metrics.create>[0], "key">;
type WindowChoice = "24" | "72" | "168" | "none" | "custom";
type CapType = Metric["capping"]["type"];

interface Values {
  name: string;
  key: string;
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

const presetWindows: ReadonlyArray<WindowChoice> = ["24", "72", "168"];

const toValues = (m: Metric | undefined): Values => {
  const d = m?.definition;
  const w = m?.windowHours ?? null;
  return {
    name: m?.name ?? "",
    key: m?.key ?? "",
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

const windowHoursOf = (d: Values): number | null =>
  d.window === "none" ? null : d.window === "custom" ? d.customWindow : Number(d.window);

const toInput = (d: Values, isSql: boolean): MetricInput => ({
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

type FieldErrors = Partial<Record<DeepKeys<Values>, string>>;

/** Whole-form rules (they cross fields: type, source, window and delay), run as a form-level validator */
const validate = (d: Values, isSql: boolean, isEdit: boolean): FieldErrors => {
  const e: FieldErrors = {};
  if (d.name.trim() === "") e.name = i18n.t("metrics:form.errors.name");
  if (!isEdit && !Schema.is(Key)(d.key)) e.key = i18n.t("metrics:form.errors.key");
  if (isSql) {
    if (d.numSql.trim() === "") e.numSql = i18n.t("metrics:form.errors.numSql");
    if (d.type === "ratio" && d.denSql.trim() === "") e.denSql = i18n.t("metrics:form.errors.denSql");
  } else {
    if (d.num.event.trim() === "") e["num.event"] = i18n.t("metrics:form.errors.numEvent");
    if (d.type === "ratio" && d.den.event.trim() === "") e["den.event"] = i18n.t("metrics:form.errors.denEvent");
  }
  const w = windowHoursOf(d);
  if (w !== null && !(w > 0)) e.customWindow = i18n.t("metrics:form.errors.window");
  if (!(d.delayHours >= 0)) e.delayHours = i18n.t("metrics:form.errors.delayNegative");
  else if (w !== null && d.delayHours >= w) e.delayHours = i18n.t("metrics:form.errors.delayTooLong");
  if (d.type !== "proportion") {
    if (d.capType === "absolute" && !(d.capAbsolute > 0)) e.capAbsolute = i18n.t("metrics:form.errors.capAbsolute");
    if (d.capType === "percentile" && !(d.capPercentile >= 50 && d.capPercentile < 100))
      e.capPercentile = i18n.t("metrics:form.errors.capPercentile");
  }
  return e;
};

/** The kit's rule for custom inputs: show the error once the field was touched or a submit was tried */
const shown = (field: AnyFieldApi): string | undefined =>
  field.state.meta.isTouched || field.form.state.submissionAttempts > 0 ? errorText(field.state.meta.errors) || undefined : undefined;

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
  onBlur,
  names,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  names: ReadonlyArray<EventNameStat>;
  error?: string | undefined;
}) {
  return (
    <ComboBox
      allowsCustomValue
      menuTrigger="focus"
      inputValue={value}
      onInputChange={onChange}
      onBlur={onBlur}
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
  onBlur,
  onTemplate,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  onTemplate: () => void;
  error?: string | undefined;
}) {
  const { t } = useTranslation("metrics");
  return (
    <TextField value={value} onChange={onChange} onBlur={onBlur} isInvalid={error !== undefined} className="w-full">
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

  const sources = useQuery(orpc.dataSources.list.queryOptions());
  const names = useQuery({
    ...orpc.events.names.queryOptions({ input: { environmentId: env?.id ?? "" } }),
    enabled: env !== null,
  });
  const sourceList = sources.data ?? [];
  const isSqlSource = (id: string) => id !== BUILTIN_DATA_SOURCE_ID && sourceList.find((s) => s.id === id)?.type !== "builtin";
  const eventNames = names.data ?? [];

  const form = useAppForm({
    defaultValues: toValues(metric),
    validators: {
      onChange: ({ value }) => {
        const fields = validate(value, isSqlSource(value.dataSourceId), isEdit);
        return Object.keys(fields).length > 0 ? { fields } : undefined;
      },
      // Clears the last server error on the next submit, so an unchanged form can be retried
      onSubmit: () => undefined,
    },
    // A blocked submit skips the form-level rules, so errors of fields mounted since the last change
    // (e.g. the denominator after switching to Ratio) would stay hidden: rerun them to show every error
    onSubmitInvalid: ({ formApi }) => void formApi.validate("change"),
    onSubmit: async ({ value, formApi }) => {
      const input = toInput(value, isSqlSource(value.dataSourceId));
      try {
        const saved =
          metric !== undefined
            ? await client.metrics.update({ id: metric.id, ...input })
            : await client.metrics.create({ key: value.key, ...input });
        void queryClient.invalidateQueries({ queryKey: orpc.metrics.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        onSaved(saved);
      } catch (error) {
        // ponytail: the API's only key error is the duplicate check ("A metric with key … already exists")
        setServerError(formApi, error, !isEdit && errorMessage(error).includes("already exists") ? "key" : undefined);
      }
    },
  });
  const d = useStore(form.store, (s) => s.values);
  const source = sourceList.find((s) => s.id === d.dataSourceId);
  const isSql = isSqlSource(d.dataSourceId);
  const input = toInput(d, isSql);

  // Follow the name until the user edits the key; a name with no ASCII slug (e.g. Japanese) leaves the key alone
  const suggestKey = (name: string) => {
    const slug = slugify(name);
    if (slug !== "" && form.getFieldMeta("key")?.isDirty !== true) form.setFieldValue("key", slug, { dontUpdateMeta: true });
  };

  return (
    <form noValidate onSubmit={submitHandler(form)} className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section className="min-w-0 rounded-[10px] border border-border bg-surface">
        <Section title={t("form.sections.basics")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <form.AppField name="name" listeners={isEdit ? undefined : { onChange: ({ value }) => suggestKey(value) }}>
              {(field) => (
                <TextField
                  value={field.state.value}
                  onChange={field.handleChange}
                  onBlur={field.handleBlur}
                  isInvalid={shown(field) !== undefined}
                  isRequired
                  autoFocus={!isEdit}
                >
                  <Label>{t("form.name.label")}</Label>
                  <Input placeholder={t("form.name.placeholder")} />
                  <FieldError>{shown(field)}</FieldError>
                </TextField>
              )}
            </form.AppField>
            <form.AppField name="key">
              {(field) => (
                <TextField
                  value={field.state.value}
                  onChange={field.handleChange}
                  onBlur={field.handleBlur}
                  isInvalid={shown(field) !== undefined}
                  isReadOnly={isEdit}
                  isRequired={!isEdit}
                >
                  <Label>{t("form.key.label")}</Label>
                  <Input placeholder="checkout-conversion" spellCheck={false} className="font-mono" />
                  <Description>{isEdit ? t("form.key.readOnly") : t("form.key.help")}</Description>
                  <FieldError>{shown(field)}</FieldError>
                </TextField>
              )}
            </form.AppField>
          </div>
          <form.AppField name="description">
            {(field) => <field.TextAreaField label={t("form.description.label")} rows={2} placeholder={t("form.description.placeholder")} />}
          </form.AppField>
        </Section>

        <Section title={t("form.sections.measure")}>
          <form.AppField
            name="type"
            listeners={{
              onChange: ({ value }) => {
                if (value === "proportion") form.setFieldValue("num.aggregation", "count");
              },
            }}
          >
            {(field) => (
              <Segmented
                label={t("form.type.label")}
                value={field.state.value}
                onChange={field.handleChange}
                options={(["proportion", "mean", "ratio"] as const).map((type) => ({
                  value: type,
                  label: metricTypeLabel(type),
                  description: t(`form.type.${type}`),
                }))}
              />
            )}
          </form.AppField>
          <form.AppField name="dataSourceId">
            {(field) => (
              <Select
                value={field.state.value}
                onChange={(id) => typeof id === "string" && field.handleChange(id)}
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
                <Description>{isSql ? t("form.dataSource.sqlHelp") : t("form.dataSource.sdkHelp")}</Description>
              </Select>
            )}
          </form.AppField>

          {isSql ? (
            <>
              <form.AppField name="numSql">
                {(field) => (
                  <SqlField
                    label={d.type === "ratio" ? t("form.sql.numerator") : t("form.sql.event")}
                    value={field.state.value}
                    onChange={field.handleChange}
                    onBlur={field.handleBlur}
                    onTemplate={() => field.handleChange(sqlTemplate(source?.bigquery ?? null, "purchase"))}
                    error={shown(field)}
                  />
                )}
              </form.AppField>
              {d.type === "ratio" && (
                <form.AppField name="denSql">
                  {(field) => (
                    <SqlField
                      label={t("form.sql.denominator")}
                      value={field.state.value}
                      onChange={field.handleChange}
                      onBlur={field.handleBlur}
                      onTemplate={() => field.handleChange(sqlTemplate(source?.bigquery ?? null, "add_to_cart"))}
                      error={shown(field)}
                    />
                  )}
                </form.AppField>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-col gap-4">
                {d.type === "ratio" && <p className="-mb-2 text-label font-medium text-muted">{t("form.event.numerator")}</p>}
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <form.AppField name="num.event">
                    {(field) => (
                      <EventField
                        label={t("form.event.label")}
                        value={field.state.value}
                        onChange={field.handleChange}
                        onBlur={field.handleBlur}
                        names={eventNames}
                        error={shown(field)}
                      />
                    )}
                  </form.AppField>
                  {d.type !== "proportion" && (
                    <div className="sm:w-[260px]">
                      <form.AppField name="num.aggregation">
                        {(field) => <AggregationField value={field.state.value} onChange={field.handleChange} />}
                      </form.AppField>
                    </div>
                  )}
                </div>
              </div>
              {d.type === "ratio" && (
                <div className="flex flex-col gap-4 border-t border-border pt-4">
                  <p className="-mb-2 text-label font-medium text-muted">{t("form.event.denominator")}</p>
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                    <form.AppField name="den.event">
                      {(field) => (
                        <EventField
                          label={t("form.event.label")}
                          value={field.state.value}
                          onChange={field.handleChange}
                          onBlur={field.handleBlur}
                          names={eventNames}
                          error={shown(field)}
                        />
                      )}
                    </form.AppField>
                    <div className="sm:w-[260px]">
                      <form.AppField name="den.aggregation">
                        {(field) => <AggregationField value={field.state.value} onChange={field.handleChange} />}
                      </form.AppField>
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
          <form.AppField name="customWindow">
            {(custom) => (
              <>
                <div className="flex flex-wrap items-end gap-4">
                  <form.AppField name="window">
                    {(field) => (
                      <Segmented
                        label={t("form.window.label")}
                        value={field.state.value}
                        onChange={field.handleChange}
                        options={[
                          ...presetWindows.map((w) => ({ value: w, label: formatHours(Number(w)) })),
                          { value: "none", label: t("common:states.none") },
                          { value: "custom", label: t("form.window.custom") },
                        ]}
                      />
                    )}
                  </form.AppField>
                  {d.window === "custom" && (
                    <NumberField
                      value={custom.state.value}
                      onChange={custom.handleChange}
                      onBlur={custom.handleBlur}
                      minValue={1}
                      isInvalid={shown(custom) !== undefined}
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
                {shown(custom) !== undefined && <p className="-mt-2 text-xs text-danger">{shown(custom)}</p>}
              </>
            )}
          </form.AppField>
          <form.AppField
            name="delayHours"
            listeners={{
              // A cleared input means no delay
              onChange: ({ value, fieldApi }) => {
                if (Number.isNaN(value)) fieldApi.setValue(0);
              },
            }}
          >
            {(field) => (
              <field.NumberField
                label={t("form.window.delay")}
                minValue={0}
                suffix={t("form.window.hours")}
                description={t("form.window.delayHelp")}
                className="w-full sm:max-w-sm"
              />
            )}
          </form.AppField>
        </Section>

        <Section title={t("form.sections.analysis")}>
          <form.AppField name="inverse">
            {(field) => (
              <Switch
                isSelected={field.state.value}
                onChange={field.handleChange}
                className="[--switch-control-bg:oklch(0.9_0_0)] dark:[--switch-control-bg:var(--default)]"
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb className={field.state.value ? "" : "dark:bg-[oklch(0.62_0_0)]"} />
                  </Switch.Control>
                  {t("direction.lowerIsBetter")}
                </Switch.Content>
                <Description>{t("form.inverseHelp")}</Description>
              </Switch>
            )}
          </form.AppField>
          {d.type !== "proportion" && (
            <div className="flex flex-col gap-3">
              <form.AppField name="capType">
                {(field) => (
                  <Segmented
                    label={t("form.capping.label")}
                    value={field.state.value}
                    onChange={field.handleChange}
                    options={[
                      { value: "none", label: t("common:states.none") },
                      { value: "absolute", label: t("form.capping.absolute") },
                      { value: "percentile", label: t("form.capping.percentile") },
                    ]}
                    description={t("form.capping.help")}
                  />
                )}
              </form.AppField>
              {d.capType === "absolute" && (
                <form.AppField name="capAbsolute">
                  {(field) => (
                    <field.NumberField
                      label={t("form.capping.absoluteLabel")}
                      description={t("form.capping.absoluteHelp")}
                      minValue={0}
                      step={1}
                      className="w-full sm:max-w-sm"
                    />
                  )}
                </form.AppField>
              )}
              {d.capType === "percentile" && (
                <form.AppField name="capPercentile">
                  {(field) => (
                    <field.NumberField
                      label={t("form.capping.percentileLabel")}
                      description={t("form.capping.percentileHelp")}
                      minValue={0}
                      step={0.1}
                      suffix={t("form.capping.percentileSuffix")}
                      className="w-full sm:max-w-sm"
                    />
                  )}
                </form.AppField>
              )}
            </div>
          )}
        </Section>

        <footer className="flex flex-wrap items-center justify-end gap-3 px-5 py-4">
          <form.Subscribe
            selector={(s) => [errorText([s.errorMap.onServer ?? s.errorMap.onSubmit]), s.submissionAttempts > 0 && !s.isFieldsValid, s.isSubmitting] as const}
          >
            {([serverError, invalid, isSubmitting]) => (
              <>
                {(serverError !== "" || invalid) && (
                  <p role="alert" className="basis-full text-label text-danger sm:mr-auto sm:basis-auto">
                    {serverError || t("form.errors.fixFields")}
                  </p>
                )}
                <Button variant="tertiary" size="sm" onPress={onCancel} isDisabled={isSubmitting}>
                  {t("common:actions.cancel")}
                </Button>
              </>
            )}
          </form.Subscribe>
          <form.AppForm>
            <form.SubmitButton label={isEdit ? t("form.saveChanges") : t("form.create")} size="sm" />
          </form.AppForm>
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
