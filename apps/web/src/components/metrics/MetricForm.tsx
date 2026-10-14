import {
  Button,
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
import type { EventNameStat } from "@furca/api/contract";
import { BUILTIN_DATA_SOURCE_ID, WAREHOUSE_LABELS, type WarehouseConfig, type WarehouseType } from "@furca/core/datasources/DataSource";
import type { EventAggregation, Metric } from "@furca/core/metrics/Metric";
import { type AnyFieldApi, useStore } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { dataSourceName, SQL_TYPES } from "~/components/datasources/name";
import { errorText, setServerError, submitHandler, useAppForm } from "~/components/form/form";
import { formatCount } from "~/components/results/format";
import { HelpTip } from "~/components/ui/HelpTip";
import { RelativeTime } from "~/components/ui/primitives";
import { Segmented } from "~/components/ui/Segmented";
import { useEnvironment } from "~/lib/environment";
import { client, errorMessage, orpc } from "~/lib/rpc";
import { Direction, formatHours, metricTypeLabel, MetricSentence } from "./describe";
import {
  ADVANCED_FIELDS,
  advancedSummary,
  METRIC_TEMPLATES,
  presetWindows,
  suggestedName,
  templateFields,
  toInput,
  toValues,
  validate,
} from "./metricValues";
import { PropertyFilters } from "./PropertyFilters";
import { suggestKey } from "./slugify";

/** The kit's rule for custom inputs: show the error once the field was touched or a submit was tried */
const shown = (field: AnyFieldApi): string | undefined =>
  field.state.meta.isTouched || field.form.state.submissionAttempts > 0 ? errorText(field.state.meta.errors) || undefined : undefined;

const sqlTemplate = (config: WarehouseConfig | null, event: string) => {
  if (config === null || config._tag === "bigquery")
    return `-- One row per event. Required columns:
--   user_id STRING, timestamp TIMESTAMP, value FLOAT64 (use 1 to count)
SELECT
  user_pseudo_id AS user_id,
  TIMESTAMP_MICROS(event_timestamp) AS timestamp,
  1 AS value
FROM \`${config?.projectId || "<project>"}.${config?.dataset || "<dataset>"}.events_*\`
WHERE event_name = '${event}'`;
  const types = SQL_TYPES[config._tag];
  const table =
    config._tag === "snowflake"
      ? `${config.database || "<database>"}.${config.schema || "<schema>"}.events`
      : config._tag === "clickhouse"
        ? `${config.database || "default"}.events`
        : "public.events";
  return `-- One row per event. Required columns:
--   user_id ${types.text}, timestamp ${types.time}, value ${types.float} (use 1 to count)
SELECT
  user_id,
  created_at AS timestamp,
  1 AS value
FROM ${table}
WHERE event_name = '${event}'`;
};

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
        <Input spellCheck={false} autoComplete="off" className="font-mono" />
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
  warehouse,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  onTemplate: () => void;
  error?: string | undefined;
  /** The selected source's dialect, named in the help text */
  warehouse: WarehouseType;
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
        className="w-full resize-y font-mono text-[0.8125rem] leading-5"
      />
      <Description>
        <Trans t={t} i18nKey="form.sql.help" values={{ ...SQL_TYPES[warehouse], warehouse: WAREHOUSE_LABELS[warehouse] }} components={{ c: code }} />
      </Description>
      <FieldError>{error}</FieldError>
    </TextField>
  );
}

/**
 * Create or edit a metric. Creating starts from a template, so the only real question is which
 * event; everything with a safe default sits in a collapsed "Advanced" section that summarizes itself
 */
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
  const [advancedOpen, setAdvancedOpen] = useState(isEdit);

  const sources = useQuery(orpc.dataSources.list.queryOptions());
  const names = useQuery({
    ...orpc.events.names.queryOptions({ input: { environmentId: env?.id ?? "" } }),
    enabled: env !== null,
  });
  const sourceList = sources.data ?? [];
  const isSqlSource = (id: string) => id !== BUILTIN_DATA_SOURCE_ID && sourceList.find((s) => s.id === id)?.type !== "builtin";
  const eventNames = names.data ?? [];
  /** Property suggestions only for events this environment has received */
  const knownEvent = (event: string) => (eventNames.some((n) => n.name === event.trim()) ? event.trim() : null);

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
    // (e.g. the denominator after switching to Ratio) would stay hidden: rerun them to show every error,
    // and open the advanced section when the problem is in there
    onSubmitInvalid: ({ value, formApi }) => {
      void formApi.validate("change");
      const errors = validate(value, isSqlSource(value.dataSourceId), isEdit);
      if (ADVANCED_FIELDS.some((f) => errors[f] !== undefined)) setAdvancedOpen(true);
    },
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
  const warehouse = source?.config?._tag ?? "bigquery";
  const sourceLabel = source === undefined ? t("builtinEvents") : dataSourceName(source);
  const input = toInput(d, isSql);
  const isCustom = d.template === "custom";
  /** "Lower is better" averages one event, so only custom ratios ask for a second one */
  const asksDenominator = d.type === "ratio" && isCustom;

  // The key follows the name, and a new metric's name follows its template and event, until the user edits them
  const followName = (name: string) => {
    if (!isEdit && form.getFieldMeta("key")?.isDirty !== true) form.setFieldValue("key", suggestKey(name, "metric"), { dontUpdateMeta: true });
  };
  const suggestName = () => {
    if (isEdit || form.getFieldMeta("name")?.isDirty === true) return;
    const { template, num } = form.state.values;
    const name = suggestedName(template, num.event);
    form.setFieldValue("name", name, { dontUpdateMeta: true });
    followName(name);
  };

  const eventField = (name: "num.event" | "den.event", label: string) => (
    <form.AppField name={name} listeners={name === "num.event" ? { onChange: suggestName } : undefined}>
      {(field) => (
        <EventField
          label={label}
          value={field.state.value}
          onChange={field.handleChange}
          onBlur={field.handleBlur}
          names={eventNames}
          error={shown(field)}
        />
      )}
    </form.AppField>
  );
  const filtersField = (name: "num.filters" | "den.filters", event: string) => (
    <form.AppField name={name}>
      {(field) => (
        <PropertyFilters
          value={field.state.value}
          onChange={field.handleChange}
          environmentId={env?.id ?? null}
          event={knownEvent(event)}
          // Like targeting conditions: incomplete rows are reported once a save was tried
          error={field.form.state.submissionAttempts > 0 ? shown(field) : undefined}
        />
      )}
    </form.AppField>
  );

  return (
    <form noValidate onSubmit={submitHandler(form)} className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section className="min-w-0 rounded-[10px] border border-border bg-surface">
        <Section title={isEdit ? t("form.sections.measure") : t("form.templates.label")}>
          {!isEdit && (
            <form.AppField
              name="template"
              listeners={{
                onChange: ({ value }) => {
                  const fixed = templateFields(value);
                  if (fixed !== null) {
                    form.setFieldValue("type", fixed.type);
                    form.setFieldValue("num.aggregation", fixed.aggregation);
                    form.setFieldValue("inverse", fixed.inverse);
                  }
                  suggestName();
                },
              }}
            >
              {(field) => (
                <Segmented
                  aria-label={t("form.templates.label")}
                  value={field.state.value}
                  onChange={field.handleChange}
                  tilesClassName="grid-cols-2 xl:grid-cols-4"
                  options={METRIC_TEMPLATES.map((id) => ({
                    value: id,
                    label: t(`form.templates.${id}.label`),
                    description: t(`form.templates.${id}.description`),
                  }))}
                />
              )}
            </form.AppField>
          )}
          {isCustom && (
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
          )}

          {isSql ? (
            <>
              <form.AppField name="numSql">
                {(field) => (
                  <SqlField
                    label={d.type === "ratio" ? t("form.sql.numerator") : t("form.sql.event")}
                    value={field.state.value}
                    onChange={field.handleChange}
                    onBlur={field.handleBlur}
                    onTemplate={() => field.handleChange(sqlTemplate(source?.config ?? null, "purchase"))}
                    error={shown(field)}
                    warehouse={warehouse}
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
                      onTemplate={() => field.handleChange(sqlTemplate(source?.config ?? null, "add_to_cart"))}
                      error={shown(field)}
                      warehouse={warehouse}
                    />
                  )}
                </form.AppField>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-4">
              {asksDenominator && <p className="-mb-2 text-label font-medium text-muted">{t("form.event.numerator")}</p>}
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
                {eventField("num.event", t("form.event.label"))}
                {isCustom && d.type !== "proportion" && (
                  <div className="xl:w-[260px]">
                    <form.AppField name="num.aggregation">
                      {(field) => <AggregationField value={field.state.value} onChange={field.handleChange} />}
                    </form.AppField>
                  </div>
                )}
              </div>
              {asksDenominator && (
                <div className="flex flex-col gap-4 border-t border-border pt-4">
                  <p className="-mb-2 text-label font-medium text-muted">{t("form.event.denominator")}</p>
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
                    {eventField("den.event", t("form.event.label"))}
                    <div className="xl:w-[260px]">
                      <form.AppField name="den.aggregation">
                        {(field) => <AggregationField value={field.state.value} onChange={field.handleChange} />}
                      </form.AppField>
                    </div>
                  </div>
                </div>
              )}
              {!isEdit && eventNames.length > 0 && (
                <div className="-mt-1 flex flex-wrap items-center gap-1.5" role="group" aria-label={t("form.event.received")}>
                  <span className="text-meta text-muted">{t("form.event.received")}</span>
                  {eventNames.slice(0, 6).map((n) => (
                    <button
                      key={n.name}
                      type="button"
                      aria-pressed={d.num.event === n.name}
                      onClick={() => {
                        form.setFieldValue("num.event", n.name);
                        suggestName();
                      }}
                      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-meta outline-none transition-colors duration-150 hover:bg-surface-secondary focus-visible:ring-2 focus-visible:ring-focus aria-pressed:border-foreground"
                    >
                      <span className="font-mono">{n.name}</span>
                      <span className="text-muted tabular">{formatCount(n.count)}</span>
                    </button>
                  ))}
                </div>
              )}
              <p className="text-meta text-muted">
                {names.isError
                  ? t("form.event.unavailable")
                  : t(eventNames.length > 0 ? "form.event.suggestions" : "form.event.none", {
                      environment: env?.name ?? t("form.event.thisEnvironment"),
                    })}
              </p>
            </div>
          )}
        </Section>

        <Section title={t("form.sections.basics")}>
          <form.AppField name="name" listeners={isEdit ? undefined : { onChange: ({ value }) => followName(value) }}>
            {(field) => <field.TextField label={t("form.name.label")} description={t("form.name.help")} className="sm:max-w-md" />}
          </form.AppField>
          <form.AppField name="key">
            {(field) => (
              <field.KeyField
                label={t("form.key.label")}
                description={isEdit ? t("form.key.readOnly") : t("form.key.help")}
                isReadOnly={isEdit}
                className="sm:max-w-md"
              />
            )}
          </form.AppField>
        </Section>

        <Disclosure isExpanded={advancedOpen} onExpandedChange={setAdvancedOpen} className="border-b border-border">
          <Disclosure.Heading>
            <Disclosure.Trigger className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left">
              <span className="min-w-0">
                <span className="block text-body font-medium">{t("form.advanced.title")}</span>
                <span className="block text-label font-normal text-muted">{advancedSummary(d, sourceLabel, isSql)}</span>
              </span>
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="flex flex-col gap-6 border-t border-border px-5 py-5">
              <p className="text-label text-muted">{t("form.advanced.why")}</p>

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
                            <span className="text-meta text-muted">{s.type === "builtin" ? t("form.dataSource.sdkEvents") : WAREHOUSE_LABELS[s.type]}</span>
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                    <Description>
                      {isSql ? t("form.dataSource.sqlHelp", { warehouse: WAREHOUSE_LABELS[warehouse] }) : t("form.dataSource.sdkHelp")}
                    </Description>
                  </Select>
                )}
              </form.AppField>

              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-1">
                  <h3 className="text-body font-medium">{t("form.sections.window")}</h3>
                  <HelpTip term={t("form.sections.window")}>{t("form.sections.windowDescription")}</HelpTip>
                </div>
                <form.AppField name="customWindow">
                  {(custom) => (
                    <>
                      <div className="flex flex-wrap items-end gap-4">
                        <form.AppField name="window">
                          {(field) => (
                            <Segmented
                              aria-label={t("form.window.label")}
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
              </div>

              {!isSql && (
                <div className="flex flex-col gap-3">
                  <h3 className="text-body font-medium">{asksDenominator ? t("form.advanced.numFilters") : t("form.advanced.filtersLabel")}</h3>
                  {filtersField("num.filters", d.num.event)}
                  {asksDenominator && (
                    <>
                      <h3 className="mt-2 text-body font-medium">{t("form.advanced.denFilters")}</h3>
                      {filtersField("den.filters", d.den.event)}
                    </>
                  )}
                </div>
              )}

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
                  <div className="flex items-center gap-1">
                    <h3 className="text-body font-medium">{t("form.capping.label")}</h3>
                    <HelpTip term={t("form.capping.label")}>{t("form.capping.help")}</HelpTip>
                  </div>
                  <form.AppField name="capType">
                    {(field) => (
                      <Segmented
                        aria-label={t("form.capping.label")}
                        value={field.state.value}
                        onChange={field.handleChange}
                        options={[
                          { value: "none", label: t("common:states.none") },
                          { value: "absolute", label: t("form.capping.absolute") },
                          { value: "percentile", label: t("form.capping.percentile") },
                        ]}
                        description={t("form.capping.short")}
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

              <form.AppField name="description">
                {(field) => <field.TextAreaField label={t("form.description.label")} rows={2} description={t("form.description.help")} />}
              </form.AppField>
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>

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
          <dd className="truncate">{sourceLabel}</dd>
        </dl>
      </aside>
    </form>
  );
}
