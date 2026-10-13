import { Button, ComboBox, Description, FieldError, Input, Label, ListBox, TextArea, TextField, toast } from "@heroui/react";
import type { DataSource } from "@furca/core/datasources/DataSource";
import { type AnyFieldApi, useStore } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, FileUp, KeyRound } from "lucide-react";
import { type ReactNode, useState } from "react";
import { DropZone, FileTrigger } from "react-aria-components";
import { Trans, useTranslation } from "react-i18next";
import { CodeBlock } from "~/components/environments/Quickstart";
import { errorText, setServerError, submitHandler, useAppForm } from "~/components/form/form";
import { i18n } from "~/i18n";
import { client, orpc } from "~/lib/rpc";

const LOCATIONS = [
  "US",
  "EU",
  "us-central1",
  "us-east1",
  "us-west1",
  "europe-west1",
  "europe-west2",
  "europe-west3",
  "asia-northeast1",
  "asia-northeast3",
  "asia-southeast1",
  "australia-southeast1",
].map((id) => ({ id }));

type Template = "ga4" | "segment" | "generic";

const exposureTemplate = (t: Template, project: string, dataset: string) => {
  const table = (name: string) => `\`${project || "<project>"}.${dataset || "<dataset>"}.${name}\``;
  if (t === "ga4")
    return `-- GA4 export: exposures sent with gtag("event", "experiment_viewed", { experiment_key, variation_key })
SELECT
  user_pseudo_id AS user_id,
  TIMESTAMP_MICROS(event_timestamp) AS timestamp,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'experiment_key') AS experiment_key,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'variation_key') AS variation_key
FROM ${table("events_*")}
WHERE event_name = 'experiment_viewed'
  AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE(TIMESTAMP_MILLIS(@start_ms)))
                        AND FORMAT_DATE('%Y%m%d', DATE(TIMESTAMP_MILLIS(@end_ms)))`;
  if (t === "segment")
    return `-- Segment: analytics.track("Experiment Viewed", { experimentId, variationId })
SELECT
  COALESCE(user_id, anonymous_id) AS user_id,
  timestamp,
  experiment_id AS experiment_key,
  variation_id AS variation_key
FROM ${table("experiment_viewed")}`;
  return `-- One row per exposure
SELECT
  user_id,
  exposed_at AS timestamp,
  experiment_key,
  variation_key
FROM ${table("exposures")}`;
};

type Parsed = { readonly email: string; readonly projectId: string | null } | { readonly error: string } | null;

/** Reads what we can show from a service account key without sending it anywhere */
const parseServiceAccount = (text: string): Parsed => {
  if (text.trim() === "") return null;
  try {
    const j: unknown = JSON.parse(text);
    const o = (j ?? {}) as Record<string, unknown>;
    // Same rule as the server (non-empty client_email and private_key), so the message stays localized
    if (o.type !== "service_account" || typeof o.client_email !== "string" || o.client_email === "" || typeof o.private_key !== "string" || o.private_key === "")
      return { error: i18n.t("datasources:form.key.notServiceAccount") };
    return { email: o.client_email, projectId: typeof o.project_id === "string" ? o.project_id : null };
  } catch {
    return { error: i18n.t("datasources:form.key.invalidJson") };
  }
};

const ROLES = [
  { id: "roles/bigquery.jobUser", key: "jobUser" },
  { id: "roles/bigquery.dataViewer", key: "dataViewer" },
] as const;

const code = <code className="font-mono" />;

function GrantRoles({ email, projectId }: { email: string; projectId: string }) {
  const { t } = useTranslation("datasources");
  const project = projectId || "<project>";
  const commands = ROLES.map(
    (r) => `gcloud projects add-iam-policy-binding ${project} \\\n  --member="serviceAccount:${email}" \\\n  --role="${r.id}"`,
  ).join("\n\n");
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-default/30 px-4 py-3">
      <p className="flex min-w-0 items-center gap-2 text-label">
        <CircleCheck className="size-4 shrink-0 text-muted" aria-hidden="true" />
        <span className="shrink-0 text-muted">{t("form.roles.serviceAccount")}</span>
        <code className="truncate font-mono">{email}</code>
      </p>
      <div className="text-label">
        <p>
          <Trans t={t} i18nKey="form.roles.grant" components={{ project: <code className="font-mono">{project}</code> }} />
        </p>
        <ul className="mt-1.5 flex flex-col gap-1">
          {ROLES.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{t(`form.roles.${r.key}`)}</span>
              <code className="font-mono text-meta text-muted">{r.id}</code>
              <span className="text-meta text-muted">{t(`form.roles.${r.key}Why`)}</span>
            </li>
          ))}
        </ul>
      </div>
      <CodeBlock code={commands} label={t("form.roles.copyCommands")} />
    </div>
  );
}

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

/** The kit's rule for custom inputs: show the error once the field was touched or a submit was tried */
const shown = (field: AnyFieldApi): string | undefined =>
  field.state.meta.isTouched || field.form.state.submissionAttempts > 0 ? errorText(field.state.meta.errors) || undefined : undefined;

const required =
  (message: string) =>
  ({ value }: { value: string }) =>
    value.trim() === "" ? message : undefined;

/** Create a BigQuery source, or edit one (credentials are write-only: keep or replace) */
export function BigQueryForm({
  source,
  onSaved,
  onCancel,
}: {
  source?: DataSource;
  onSaved: (source: DataSource) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation(["datasources", "common"]);
  const isEdit = source !== undefined;
  const queryClient = useQueryClient();
  const [replaceKey, setReplaceKey] = useState(!isEdit || source.hasCredentials === false);
  const [dragging, setDragging] = useState(false);

  const form = useAppForm({
    defaultValues: {
      name: source?.name ?? "",
      projectId: source?.bigquery?.projectId ?? "",
      dataset: source?.bigquery?.dataset ?? "",
      location: source?.bigquery?.location ?? "US",
      credentials: "",
      sql: source?.exposureSql ?? "",
    },
    // Clears the last server error on the next submit, so an unchanged form can be retried
    validators: { onSubmit: () => undefined },
    onSubmit: async ({ value, formApi }) => {
      const name = value.name.trim();
      const bigquery = { projectId: value.projectId.trim(), dataset: value.dataset.trim(), location: value.location.trim() };
      try {
        const saved =
          source !== undefined
            ? await client.dataSources.update({
                id: source.id,
                name,
                bigquery,
                credentialsJson: replaceKey ? value.credentials : null,
                exposureSql: value.sql,
              })
            : await client.dataSources.createBigQuery({ name, bigquery, credentialsJson: value.credentials, exposureSql: value.sql });
        void queryClient.invalidateQueries({ queryKey: orpc.dataSources.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        formApi.resetField("credentials");
        setReplaceKey(false);
        onSaved(saved);
      } catch (error) {
        setServerError(formApi, error);
      }
    },
  });
  const values = useStore(form.store, (s) => s.values);
  const parsed = parseServiceAccount(values.credentials);

  const readFile = async (file: File) => {
    const text = await file.text();
    form.setFieldValue("credentials", text);
    const p = parseServiceAccount(text);
    if (p !== null && "email" in p && p.projectId !== null && form.getFieldValue("projectId") === "") form.setFieldValue("projectId", p.projectId);
  };

  const insertTemplate = (template: Template) => {
    const previous = form.getFieldValue("sql");
    form.setFieldValue("sql", exposureTemplate(template, values.projectId, values.dataset));
    if (previous.trim() !== "")
      toast(t("form.sql.templateInserted"), {
        description: t("form.sql.templateInsertedDescription"),
        actionProps: { children: t("form.sql.undo"), onPress: () => form.setFieldValue("sql", previous), variant: "tertiary" },
      });
  };

  return (
    <form noValidate onSubmit={submitHandler(form)} className="min-w-0 rounded-[10px] border border-border bg-surface">
      <Section title={t("form.warehouse.title")}>
        <form.AppField name="name" validators={{ onChange: required(t("form.errors.name")) }}>
          {(field) => (
            <TextField
              value={field.state.value}
              onChange={field.handleChange}
              onBlur={field.handleBlur}
              isRequired
              isInvalid={shown(field) !== undefined}
              className="sm:max-w-sm"
              autoFocus={!isEdit}
            >
              <Label>{t("form.warehouse.name")}</Label>
              <Input placeholder={t("form.warehouse.namePlaceholder")} />
              <FieldError>{shown(field)}</FieldError>
            </TextField>
          )}
        </form.AppField>
        <div className="grid gap-4 sm:grid-cols-3">
          <form.AppField name="projectId" validators={{ onChange: required(t("form.errors.projectId")) }}>
            {(field) => (
              <TextField
                value={field.state.value}
                onChange={field.handleChange}
                onBlur={field.handleBlur}
                isRequired
                isInvalid={shown(field) !== undefined}
              >
                <Label>{t("form.warehouse.projectId")}</Label>
                <Input placeholder="my-company-prod" spellCheck={false} className="font-mono" />
                <FieldError>{shown(field)}</FieldError>
              </TextField>
            )}
          </form.AppField>
          <form.AppField name="dataset" validators={{ onChange: required(t("form.errors.dataset")) }}>
            {(field) => (
              <TextField
                value={field.state.value}
                onChange={field.handleChange}
                onBlur={field.handleBlur}
                isRequired
                isInvalid={shown(field) !== undefined}
              >
                <Label>{t("form.warehouse.dataset")}</Label>
                <Input placeholder="analytics_123456" spellCheck={false} className="font-mono" />
                <Description>{t("form.warehouse.datasetHelp")}</Description>
                <FieldError>{shown(field)}</FieldError>
              </TextField>
            )}
          </form.AppField>
          <form.AppField name="location" validators={{ onChange: required(t("form.errors.location")) }}>
            {(field) => (
              <ComboBox
                allowsCustomValue
                inputValue={field.state.value}
                onInputChange={field.handleChange}
                onBlur={field.handleBlur}
                isInvalid={shown(field) !== undefined}
                items={LOCATIONS}
                menuTrigger="focus"
              >
                <Label>{t("form.warehouse.location")}</Label>
                <ComboBox.InputGroup>
                  <Input spellCheck={false} className="font-mono" />
                  <ComboBox.Trigger />
                </ComboBox.InputGroup>
                <ComboBox.Popover>
                  <ListBox>
                    {(l: { id: string }) => (
                      <ListBox.Item id={l.id} textValue={l.id} className="font-mono">
                        {l.id}
                      </ListBox.Item>
                    )}
                  </ListBox>
                </ComboBox.Popover>
                <Description>{t("form.warehouse.locationHelp")}</Description>
                <FieldError>{shown(field)}</FieldError>
              </ComboBox>
            )}
          </form.AppField>
        </div>
      </Section>

      <Section title={t("form.key.title")} description={<Trans t={t} i18nKey="form.key.description" components={{ c: code }} />}>
        {!replaceKey ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-4 py-3">
            <span className="flex items-center gap-2 text-label">
              <KeyRound className="size-4 text-muted" aria-hidden="true" />
              {t("form.key.stored")}
            </span>
            <Button size="sm" variant="tertiary" onPress={() => setReplaceKey(true)}>
              {t("form.key.replace")}
            </Button>
          </div>
        ) : (
          // Mounted only while a key is being (re)placed, so its validator only applies then
          <form.AppField
            name="credentials"
            validators={{
              onChange: ({ value }) => {
                const p = parseServiceAccount(value);
                return p === null ? t("form.errors.credentials") : "error" in p ? p.error : undefined;
              },
            }}
          >
            {(field) => (
              <>
                <DropZone
                  getDropOperation={() => "copy"}
                  onDropEnter={() => setDragging(true)}
                  onDropExit={() => setDragging(false)}
                  onDrop={async (e) => {
                    setDragging(false);
                    for (const item of e.items)
                      if (item.kind === "file") {
                        await readFile(await item.getFile());
                        return;
                      } else if (item.kind === "text") {
                        field.handleChange(await item.getText("text/plain"));
                        return;
                      }
                  }}
                  className={`rounded-md outline-none transition-shadow data-focus-visible:ring-2 data-focus-visible:ring-focus ${dragging ? "ring-2 ring-focus" : ""}`}
                  aria-label={t("form.key.dropLabel")}
                >
                  <TextField
                    value={field.state.value}
                    onChange={field.handleChange}
                    onBlur={field.handleBlur}
                    isInvalid={field.state.value !== "" && shown(field) !== undefined}
                    aria-label={t("form.key.fieldLabel")}
                  >
                    <TextArea
                      rows={5}
                      spellCheck={false}
                      autoCorrect="off"
                      placeholder={`${t("form.key.placeholder")}\n{ "type": "service_account", "project_id": "…", "client_email": "…", … }`}
                      className="w-full resize-y font-mono text-[12px] leading-5"
                    />
                    <FieldError>{field.state.value !== "" ? shown(field) : undefined}</FieldError>
                  </TextField>
                </DropZone>
                <div className="flex flex-wrap items-center gap-2">
                  <FileTrigger
                    acceptedFileTypes={["application/json", ".json"]}
                    onSelect={(files) => {
                      const file = files?.[0];
                      if (file !== undefined) void readFile(file);
                    }}
                  >
                    <Button size="sm" variant="tertiary">
                      <FileUp className="size-4" />
                      {t("form.key.chooseFile")}
                    </Button>
                  </FileTrigger>
                  {isEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => {
                        setReplaceKey(false);
                        form.resetField("credentials");
                      }}
                    >
                      {t("form.key.keep")}
                    </Button>
                  )}
                  {field.state.value === "" && field.form.state.submissionAttempts > 0 && shown(field) !== undefined && (
                    <span role="alert" className="text-xs text-danger">
                      {shown(field)}
                    </span>
                  )}
                </div>
                {parsed !== null && "email" in parsed && (
                  <GrantRoles email={parsed.email} projectId={values.projectId || parsed.projectId || ""} />
                )}
                {parsed === null && (
                  <p className="text-label text-muted">
                    <Trans t={t} i18nKey="form.key.needsRoles" components={{ b: <span className="text-foreground" /> }} />
                  </p>
                )}
              </>
            )}
          </form.AppField>
        )}
      </Section>

      <Section title={t("form.sql.title")} description={t("form.sql.description")}>
        <form.AppField name="sql" validators={{ onChange: required(t("form.errors.sql")) }}>
          {(field) => (
            <TextField
              value={field.state.value}
              onChange={field.handleChange}
              onBlur={field.handleBlur}
              isInvalid={shown(field) !== undefined}
              className="w-full"
            >
              <div className="flex flex-wrap items-end justify-between gap-2">
                <Label>SQL</Label>
                <span className="flex items-center gap-1 text-label text-muted">
                  {t("form.sql.startFrom")}
                  {(
                    [
                      ["ga4", t("form.sql.ga4")],
                      ["segment", "Segment"],
                      ["generic", t("form.sql.generic")],
                    ] as const
                  ).map(([template, label]) => (
                    <Button key={template} size="sm" variant="ghost" className="h-7 px-2 text-label" onPress={() => insertTemplate(template)}>
                      {label}
                    </Button>
                  ))}
                </span>
              </div>
              <TextArea
                rows={10}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                placeholder="SELECT user_id, timestamp, experiment_key, variation_key FROM …"
                className="w-full resize-y font-mono text-[0.8125rem] leading-5"
              />
              <Description>
                <Trans t={t} i18nKey="form.sql.help" components={{ c: code }} />
              </Description>
              <FieldError>{shown(field)}</FieldError>
            </TextField>
          )}
        </form.AppField>
      </Section>

      <footer className="flex flex-wrap items-center justify-end gap-3 px-5 py-4">
        <form.Subscribe selector={(s) => [errorText([s.errorMap.onServer ?? s.errorMap.onSubmit]), s.isDefaultValue, s.isSubmitting] as const}>
          {([serverError, pristine, isSubmitting]) => (
            <>
              {serverError !== "" && (
                <p role="alert" className="basis-full text-label text-danger sm:mr-auto sm:basis-auto">
                  {serverError}
                </p>
              )}
              {isEdit && pristine && serverError === "" && (
                <p className="basis-full text-label text-muted sm:mr-auto sm:basis-auto">{t("form.noChanges")}</p>
              )}
              {onCancel !== undefined && (
                <Button size="sm" variant="tertiary" onPress={onCancel} isDisabled={isSubmitting}>
                  {t("common:actions.cancel")}
                </Button>
              )}
              <Button type="submit" size="sm" isPending={isSubmitting} isDisabled={isEdit && pristine}>
                {isEdit ? t("form.saveChanges") : t("form.create")}
              </Button>
            </>
          )}
        </form.Subscribe>
      </footer>
    </form>
  );
}
