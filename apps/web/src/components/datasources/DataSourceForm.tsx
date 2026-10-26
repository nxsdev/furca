import { Button, ComboBox, Description, FieldError, Input, Label, ListBox, TextArea, TextField, toast } from "@heroui/react";
import { type DataSource, WAREHOUSE_LABELS, type WarehouseType } from "@furca/core/datasources/DataSource";
import { type AnyFieldApi, useStore } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, FileUp, KeyRound } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { DropZone, FileTrigger } from "react-aria-components";
import { Trans, useTranslation } from "react-i18next";
import { SQL_TYPES } from "~/components/datasources/name";
import { CodeBlock } from "~/components/environments/Quickstart";
import { errorText, setServerError, submitHandler, useAppForm } from "~/components/form/form";
import { i18n, type resources } from "~/i18n";
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

interface Values {
  name: string;
  projectId: string;
  dataset: string;
  location: string;
  account: string;
  /** Snowflake / Postgres user, ClickHouse username */
  user: string;
  warehouse: string;
  database: string;
  schema: string;
  role: string;
  url: string;
  host: string;
  port: number;
  ssl: string;
  credentials: string;
  sql: string;
}

const initialValues = (type: WarehouseType, source: DataSource | undefined): Values => {
  const c = (source?.config ?? {}) as Partial<Record<string, unknown>>;
  const text = (key: string, fallback = "") => (typeof c[key] === "string" ? (c[key] as string) : fallback);
  return {
    name: source?.name ?? "",
    projectId: text("projectId"),
    dataset: text("dataset"),
    location: text("location", "US"),
    account: text("account"),
    user: text(type === "clickhouse" ? "username" : "user"),
    warehouse: text("warehouse"),
    database: text("database", type === "clickhouse" ? "default" : ""),
    schema: text("schema", type === "snowflake" ? "PUBLIC" : ""),
    role: text("role"),
    url: text("url"),
    host: text("host"),
    port: typeof c.port === "number" ? c.port : 5432,
    ssl: text("ssl", "require"),
    credentials: "",
    sql: source?.exposureSql ?? "",
  };
};

const toConfig = (type: WarehouseType, v: Values) => {
  const s = (x: string) => x.trim();
  switch (type) {
    case "bigquery":
      return { _tag: type, projectId: s(v.projectId), dataset: s(v.dataset), location: s(v.location) };
    case "snowflake":
      return { _tag: type, account: s(v.account), user: s(v.user), warehouse: s(v.warehouse), database: s(v.database), schema: s(v.schema), role: s(v.role) };
    case "clickhouse":
      return { _tag: type, url: s(v.url), database: s(v.database), username: s(v.user) };
    case "postgres":
      return { _tag: type, host: s(v.host), port: v.port, database: s(v.database), user: s(v.user), ssl: v.ssl === "disable" ? ("disable" as const) : ("require" as const) };
  }
};

type TextKey = "account" | "user" | "warehouse" | "database" | "schema" | "role" | "url" | "host";

/** Picks a field's help text out of `datasources:form.help` */
type HelpKey = (help: (typeof resources)["en"]["datasources"]["form"]["help"]) => string;

/** Connection fields of the non-BigQuery warehouses */
const FIELDS: Record<Exclude<WarehouseType, "bigquery">, ReadonlyArray<{ name: TextKey; placeholder: string; optional?: true; help?: HelpKey; className?: string }>> = {
  snowflake: [
    { name: "account", placeholder: "myorg-myaccount", help: (h) => h.snowflake.account },
    { name: "user", placeholder: "FURCA_READER" },
    { name: "warehouse", placeholder: "ANALYTICS_WH" },
    { name: "database", placeholder: "ANALYTICS" },
    { name: "schema", placeholder: "PUBLIC" },
    { name: "role", placeholder: "FURCA_READER", optional: true, help: (h) => h.snowflake.role },
  ],
  clickhouse: [
    { name: "url", placeholder: "https://abc123.eu-west-1.aws.clickhouse.cloud:8443", help: (h) => h.clickhouse.url },
    { name: "database", placeholder: "default" },
    { name: "user", placeholder: "furca_reader" },
  ],
  postgres: [
    // Port (order-2) and SSL (order-5) render after these, so order puts the port next to the host
    { name: "host", placeholder: "db.example.com", help: (h) => h.postgres.host, className: "order-1" },
    { name: "database", placeholder: "analytics", className: "order-3" },
    { name: "user", placeholder: "furca_reader", className: "order-4" },
  ],
};

/** Same rules as the server, so the messages stay localized */
const fieldError = (name: TextKey, value: string): string | undefined => {
  const v = value.trim();
  if (name === "account" && (!/^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/.test(v) || /snowflakecomputing/i.test(v)))
    return v === "" ? i18n.t(($) => $.form.errors.required, { ns: "datasources" }) : i18n.t(($) => $.form.errors.account, { ns: "datasources" });
  if (name === "url" && v !== "" && !/^https:\/\/[^/@\s]+/.test(v)) return i18n.t(($) => $.form.errors.url, { ns: "datasources" });
  if (name === "host" && /[\s/@]/.test(v)) return i18n.t(($) => $.form.errors.host, { ns: "datasources" });
  return v === "" ? i18n.t(($) => $.form.errors.required, { ns: "datasources" }) : undefined;
};

type Template = "ga4" | "segment" | "generic";

const TEMPLATES: Record<WarehouseType, ReadonlyArray<Template>> = {
  bigquery: ["ga4", "segment", "generic"],
  snowflake: ["segment", "generic"],
  clickhouse: ["generic"],
  postgres: ["segment", "generic"],
};

const exposureTemplate = (type: WarehouseType, t: Template, v: Values) => {
  const table = (name: string) => {
    switch (type) {
      case "bigquery":
        return `\`${v.projectId || "<project>"}.${v.dataset || "<dataset>"}.${name}\``;
      case "snowflake":
        return `${v.database || "<database>"}.${v.schema || "<schema>"}.${name}`;
      case "clickhouse":
        return `${v.database || "default"}.${name}`;
      case "postgres":
        return `${t === "segment" ? "<segment_source>" : "public"}.${name}`;
    }
  };
  if (t === "ga4")
    return `-- GA4 export: exposures sent with gtag("event", "experiment_viewed", { experiment_id, variation_id })
SELECT
  user_pseudo_id AS user_id,
  TIMESTAMP_MICROS(event_timestamp) AS timestamp,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'experiment_id') AS experiment_id,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'variation_id') AS variation_id
FROM ${table("events_*")}
WHERE event_name = 'experiment_viewed'
  AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE(TIMESTAMP_MILLIS(@start_ms)))
                        AND FORMAT_DATE('%Y%m%d', DATE(TIMESTAMP_MILLIS(@end_ms)))`;
  if (t === "segment")
    return `-- Segment: analytics.track("Experiment Viewed", { experiment_id, variation_id })
SELECT
  COALESCE(user_id, anonymous_id) AS user_id,
  timestamp,
  experiment_id,
  variation_id
FROM ${table("experiment_viewed")}`;
  return `-- One row per exposure
SELECT
  user_id,
  exposed_at AS timestamp,
  experiment_id,
  variation_id
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
      return { error: i18n.t(($) => $.form.key.notServiceAccount, { ns: "datasources" }) };
    return { email: o.client_email, projectId: typeof o.project_id === "string" ? o.project_id : null };
  } catch {
    return { error: i18n.t(($) => $.form.key.invalidJson, { ns: "datasources" }) };
  }
};

/** The server's checks on the stored secret, localized. undefined when it looks right */
const secretError = (type: WarehouseType, value: string): string | undefined => {
  if (type === "bigquery") {
    const p = parseServiceAccount(value);
    return p === null ? i18n.t(($) => $.form.errors.credentials, { ns: "datasources" }) : "error" in p ? p.error : undefined;
  }
  if (type === "snowflake") {
    if (value.trim() === "") return i18n.t(($) => $.form.privateKey.required, { ns: "datasources" });
    if (value.includes("ENCRYPTED PRIVATE KEY")) return i18n.t(($) => $.form.privateKey.encrypted, { ns: "datasources" });
    if (value.includes("BEGIN RSA PRIVATE KEY")) return i18n.t(($) => $.form.privateKey.pkcs1, { ns: "datasources" });
    return /-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(value) ? undefined : i18n.t(($) => $.form.privateKey.invalid, { ns: "datasources" });
  }
  return value === "" ? i18n.t(($) => $.form.password.required, { ns: "datasources" }) : undefined;
};

/** Base64 DER public key of a PKCS#8 RSA private key, computed in the browser; null if it is not one */
const publicKeyOf = async (pem: string): Promise<string | null> => {
  try {
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (ch) => ch.charCodeAt(0));
    const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    const { n, e } = await crypto.subtle.exportKey("jwk", await crypto.subtle.importKey("pkcs8", der, algorithm, true, ["sign"]));
    const spki = await crypto.subtle.exportKey("spki", await crypto.subtle.importKey("jwk", { kty: "RSA", n, e }, algorithm, true, ["verify"]));
    return btoa(String.fromCharCode(...new Uint8Array(spki)));
  } catch {
    return null;
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
        <span className="shrink-0 text-muted">{t(($) => $.form.roles.serviceAccount)}</span>
        <code className="truncate font-mono">{email}</code>
      </p>
      <div className="text-label">
        <p>
          <Trans t={t} i18nKey={($) => $.form.roles.grant} components={{ project: <code className="font-mono">{project}</code> }} />
        </p>
        <ul className="mt-1.5 flex flex-col gap-1">
          {ROLES.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{t(($) => $.form.roles[r.key])}</span>
              <code className="font-mono text-meta text-muted">{r.id}</code>
              <span className="text-meta text-muted">{t(($) => $.form.roles[`${r.key}Why` as const])}</span>
            </li>
          ))}
        </ul>
      </div>
      <CodeBlock code={commands} label={t(($) => $.form.roles.copyCommands)} />
    </div>
  );
}

/** The exact ALTER USER for the pasted key (derived locally), or how to make a key pair */
function SnowflakeKeySetup({ pem, user }: { pem: string; user: string }) {
  const { t } = useTranslation("datasources");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void publicKeyOf(pem).then((k) => current && setPublicKey(k));
    return () => {
      current = false;
    };
  }, [pem]);
  const name = user.trim() === "" ? "<user>" : /^[A-Za-z_][A-Za-z0-9_$]*$/.test(user.trim()) ? user.trim() : `"${user.trim()}"`;
  return publicKey !== null ? (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-default/30 px-4 py-3 text-label">
      <p className="flex items-center gap-2">
        <CircleCheck className="size-4 shrink-0 text-muted" aria-hidden="true" />
        {t(($) => $.form.privateKey.register)}
      </p>
      <CodeBlock code={`ALTER USER ${name} SET RSA_PUBLIC_KEY='${publicKey}';`} label={t(($) => $.form.privateKey.copySql)} />
    </div>
  ) : (
    <div className="flex flex-col gap-2 text-label text-muted">
      <p>{t(($) => $.form.privateKey.howTo)}</p>
      <CodeBlock code="openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt" label={t(($) => $.form.privateKey.copyCommand)} />
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

/** Create a warehouse source of `type`, or edit one (credentials are write-only: keep or replace) */
export function DataSourceForm({
  type,
  source,
  onSaved,
  onCancel,
}: {
  type: WarehouseType;
  source?: DataSource;
  onSaved: (source: DataSource) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation(["datasources", "common"]);
  const isEdit = source !== undefined;
  const queryClient = useQueryClient();
  const [replaceSecret, setReplaceSecret] = useState(!isEdit || source.hasCredentials === false);
  const [dragging, setDragging] = useState(false);
  const label = WAREHOUSE_LABELS[type];

  const form = useAppForm({
    defaultValues: initialValues(type, source),
    // Clears the last server error on the next submit, so an unchanged form can be retried
    validators: { onSubmit: () => undefined },
    onSubmit: async ({ value, formApi }) => {
      const name = value.name.trim();
      const config = toConfig(type, value);
      try {
        const saved =
          source !== undefined
            ? await client.dataSources.update({
                id: source.id,
                name,
                config,
                credentials: replaceSecret ? value.credentials : null,
                exposureSql: value.sql,
              })
            : await client.dataSources.create({ name, config, credentials: value.credentials, exposureSql: value.sql });
        void queryClient.invalidateQueries({ queryKey: orpc.dataSources.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        formApi.resetField("credentials");
        setReplaceSecret(false);
        onSaved(saved);
      } catch (error) {
        setServerError(formApi, error);
      }
    },
  });
  const values = useStore(form.store, (s) => s.values);
  const parsed = type === "bigquery" ? parseServiceAccount(values.credentials) : null;

  const readFile = async (file: File) => {
    const text = await file.text();
    form.setFieldValue("credentials", text);
    const p = type === "bigquery" ? parseServiceAccount(text) : null;
    if (p !== null && "email" in p && p.projectId !== null && form.getFieldValue("projectId") === "") form.setFieldValue("projectId", p.projectId);
  };

  const insertTemplate = (template: Template) => {
    const previous = form.getFieldValue("sql");
    form.setFieldValue("sql", exposureTemplate(type, template, values));
    if (previous.trim() !== "")
      toast(t(($) => $.form.sql.templateInserted), {
        description: t(($) => $.form.sql.templateInsertedDescription),
        actionProps: { children: t(($) => $.form.sql.undo), onPress: () => form.setFieldValue("sql", previous), variant: "tertiary" },
      });
  };

  const secretTitle = type === "bigquery" ? t(($) => $.form.key.title) : type === "snowflake" ? t(($) => $.form.privateKey.title) : t(($) => $.form.password.title);

  return (
    <form noValidate onSubmit={submitHandler(form)} className="min-w-0 rounded-[10px] border border-border bg-surface">
      <Section title={t(($) => $.form.warehouse.title)}>
        <form.AppField name="name" validators={{ onChange: required(t(($) => $.form.errors.name)) }}>
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
              <Label>{t(($) => $.form.warehouse.name)}</Label>
              <Input placeholder={t(($) => $.form.warehouse.namePlaceholder)} />
              <FieldError>{shown(field)}</FieldError>
            </TextField>
          )}
        </form.AppField>
        {type === "bigquery" ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <form.AppField name="projectId" validators={{ onChange: required(t(($) => $.form.errors.projectId)) }}>
              {(field) => (
                <TextField
                  value={field.state.value}
                  onChange={field.handleChange}
                  onBlur={field.handleBlur}
                  isRequired
                  isInvalid={shown(field) !== undefined}
                >
                  <Label>{t(($) => $.form.warehouse.projectId)}</Label>
                  <Input placeholder="my-company-prod" spellCheck={false} className="font-mono" />
                  <FieldError>{shown(field)}</FieldError>
                </TextField>
              )}
            </form.AppField>
            <form.AppField name="dataset" validators={{ onChange: required(t(($) => $.form.errors.dataset)) }}>
              {(field) => (
                <TextField
                  value={field.state.value}
                  onChange={field.handleChange}
                  onBlur={field.handleBlur}
                  isRequired
                  isInvalid={shown(field) !== undefined}
                >
                  <Label>{t(($) => $.form.warehouse.dataset)}</Label>
                  <Input placeholder="analytics_123456" spellCheck={false} className="font-mono" />
                  <Description>{t(($) => $.form.warehouse.datasetHelp)}</Description>
                  <FieldError>{shown(field)}</FieldError>
                </TextField>
              )}
            </form.AppField>
            <form.AppField name="location" validators={{ onChange: required(t(($) => $.form.errors.location)) }}>
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
                  <Label>{t(($) => $.form.warehouse.location)}</Label>
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
                  <Description>{t(($) => $.form.warehouse.locationHelp)}</Description>
                  <FieldError>{shown(field)}</FieldError>
                </ComboBox>
              )}
            </form.AppField>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS[type].map((f) => (
              <form.AppField
                key={f.name}
                name={f.name}
                validators={{ onChange: f.optional ? undefined : ({ value }) => fieldError(f.name, value) }}
              >
                {(field) => (
                  <field.TextField
                    label={t(($) => $.form.fields[f.name])}
                    placeholder={f.placeholder}
                    description={f.help === undefined ? undefined : t(($) => f.help!($.form.help))}
                    autoComplete="off"
                    className={f.className}
                    mono
                  />
                )}
              </form.AppField>
            ))}
            {type === "postgres" && (
              <>
                <form.AppField
                  name="port"
                  validators={{
                    onChange: ({ value }) => (Number.isInteger(value) && value >= 1 && value <= 65535 ? undefined : t(($) => $.form.errors.port)),
                  }}
                >
                  {(field) => (
                    <field.NumberField label={t(($) => $.form.fields.port)} minValue={1} maxValue={65535} formatOptions={{ useGrouping: false }} className="order-2" />
                  )}
                </form.AppField>
                <form.AppField name="ssl">
                  {(field) => (
                    <field.SelectField
                      className="order-5"
                      label={t(($) => $.form.fields.ssl)}
                      description={t(($) => $.form.help.postgres.ssl)}
                      options={[
                        { id: "require", label: t(($) => $.form.ssl.require), textValue: t(($) => $.form.ssl.require) },
                        { id: "disable", label: t(($) => $.form.ssl.disable), textValue: t(($) => $.form.ssl.disable) },
                      ]}
                    />
                  )}
                </form.AppField>
              </>
            )}
          </div>
        )}
      </Section>

      <Section
        title={secretTitle}
        description={<Trans t={t} i18nKey={($) => $.form.secretDescription} components={{ c: code }} />}
      >
        {!replaceSecret ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-4 py-3">
            <span className="flex items-center gap-2 text-label">
              <KeyRound className="size-4 text-muted" aria-hidden="true" />
              {t(($) => $.form.secretStored, { secret: secretTitle })}
            </span>
            <Button size="sm" variant="tertiary" onPress={() => setReplaceSecret(true)}>
              {t(($) => $.form.replace)}
            </Button>
          </div>
        ) : (
          // Mounted only while a secret is being (re)placed, so its validator only applies then
          <form.AppField name="credentials" validators={{ onChange: ({ value }) => secretError(type, value) }}>
            {(field) => (
              <>
                {type === "clickhouse" || type === "postgres" ? (
                  <field.TextField label={t(($) => $.form.password.label)} type="password" autoComplete="new-password" className="sm:max-w-sm" />
                ) : (
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
                    aria-label={type === "bigquery" ? t(($) => $.form.key.dropLabel) : t(($) => $.form.privateKey.dropLabel)}
                  >
                    <TextField
                      value={field.state.value}
                      onChange={field.handleChange}
                      onBlur={field.handleBlur}
                      isInvalid={field.state.value !== "" && shown(field) !== undefined}
                      aria-label={type === "bigquery" ? t(($) => $.form.key.fieldLabel) : t(($) => $.form.privateKey.title)}
                    >
                      <TextArea
                        rows={5}
                        spellCheck={false}
                        autoCorrect="off"
                        placeholder={
                          type === "bigquery"
                            ? `${t(($) => $.form.key.placeholder)}\n{ "type": "service_account", "project_id": "…", "client_email": "…", … }`
                            : `${t(($) => $.form.privateKey.placeholder)}\n-----BEGIN PRIVATE KEY-----\n…`
                        }
                        className="w-full resize-y font-mono text-[12px] leading-5"
                      />
                      <FieldError>{field.state.value !== "" ? shown(field) : undefined}</FieldError>
                    </TextField>
                  </DropZone>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {(type === "bigquery" || type === "snowflake") && (
                    <FileTrigger
                      acceptedFileTypes={type === "bigquery" ? ["application/json", ".json"] : [".p8", ".pem", ".key"]}
                      onSelect={(files) => {
                        const file = files?.[0];
                        if (file !== undefined) void readFile(file);
                      }}
                    >
                      <Button size="sm" variant="tertiary">
                        <FileUp className="size-4" />
                        {type === "bigquery" ? t(($) => $.form.key.chooseFile) : t(($) => $.form.privateKey.chooseFile)}
                      </Button>
                    </FileTrigger>
                  )}
                  {isEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => {
                        setReplaceSecret(false);
                        form.resetField("credentials");
                      }}
                    >
                      {t(($) => $.form.keep)}
                    </Button>
                  )}
                  {type !== "clickhouse" &&
                    type !== "postgres" &&
                    field.state.value === "" &&
                    field.form.state.submissionAttempts > 0 &&
                    shown(field) !== undefined && (
                      <span role="alert" className="text-xs text-danger">
                        {shown(field)}
                      </span>
                    )}
                </div>
                {type === "bigquery" && parsed !== null && "email" in parsed && (
                  <GrantRoles email={parsed.email} projectId={values.projectId || parsed.projectId || ""} />
                )}
                {type === "bigquery" && parsed === null && (
                  <p className="text-label text-muted">
                    <Trans t={t} i18nKey={($) => $.form.key.needsRoles} components={{ b: <span className="text-foreground" /> }} />
                  </p>
                )}
                {type === "snowflake" && <SnowflakeKeySetup pem={field.state.value} user={values.user} />}
              </>
            )}
          </form.AppField>
        )}
        {type !== "bigquery" && <p className="text-label text-muted">{t(($) => $.form.access[type])}</p>}
      </Section>

      <Section title={t(($) => $.form.sql.title)} description={t(($) => $.form.sql.description)}>
        <form.AppField name="sql" validators={{ onChange: required(t(($) => $.form.errors.sql)) }}>
          {(field) => (
            <TextField
              value={field.state.value}
              onChange={field.handleChange}
              onBlur={field.handleBlur}
              isInvalid={shown(field) !== undefined}
              className="w-full"
            >
              <div className="flex flex-wrap items-end justify-between gap-2">
                <Label>{t(($) => $.form.sql.label, { warehouse: label })}</Label>
                <span className="flex items-center gap-1 text-label text-muted">
                  {t(($) => $.form.sql.startFrom)}
                  {TEMPLATES[type].map((template) => (
                    <Button key={template} size="sm" variant="ghost" className="h-7 px-2 text-label" onPress={() => insertTemplate(template)}>
                      {template === "segment" ? "Segment" : t(($) => $.form.sql[template])}
                    </Button>
                  ))}
                </span>
              </div>
              <TextArea
                rows={10}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                placeholder="SELECT user_id, timestamp, experiment_id, variation_id FROM …"
                className="w-full resize-y font-mono text-[0.8125rem] leading-5"
              />
              <Description>
                <Trans t={t} i18nKey={($) => $.form.sql.help} values={SQL_TYPES[type]} components={{ c: code }} />
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
                <p className="basis-full text-label text-muted sm:mr-auto sm:basis-auto">{t(($) => $.form.noChanges)}</p>
              )}
              {onCancel !== undefined && (
                <Button size="sm" variant="tertiary" onPress={onCancel} isDisabled={isSubmitting}>
                  {t(($) => $.actions.cancel, { ns: "common" })}
                </Button>
              )}
              <Button type="submit" size="sm" isPending={isSubmitting} isDisabled={isEdit && pristine}>
                {isEdit ? t(($) => $.form.saveChanges) : t(($) => $.form.create)}
              </Button>
            </>
          )}
        </form.Subscribe>
      </footer>
    </form>
  );
}
