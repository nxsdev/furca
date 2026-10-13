/**
 * BigQuery REST client for Workers: service-account JWT (jose, WebCrypto) -> OAuth token -> jobs.query.
 * No Node built-ins. Every failure is a WarehouseError whose message says what to fix
 */
import { WarehouseError } from "@furca/core/shared/errors";
import { Effect } from "effect";
import { importPKCS8, SignJWT } from "jose";

export interface ServiceAccount {
  readonly client_email: string;
  readonly private_key: string;
  readonly private_key_id?: string;
}

/** Where jobs run: billing project, default dataset for unqualified table names, job location */
export interface BigQueryTarget {
  readonly projectId: string;
  readonly dataset: string;
  readonly location: string;
}

/** Named query parameters (`@name` in SQL). Never interpolate user input into SQL */
export type QueryParams = Readonly<Record<string, string | number | boolean>>;

export type Row = Record<string, unknown>;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://bigquery.googleapis.com/bigquery/v2";
const SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";
/** Each poll long-polls 10 s server side */
const MAX_POLLS = 30;

const fail = (message: string): never => {
  throw new WarehouseError({ message });
};

/** Effect boundary: thrown WarehouseErrors pass through, anything else (network, JSON) is wrapped */
const run = <A>(span: string, f: () => Promise<A>): Effect.Effect<A, WarehouseError> =>
  Effect.tryPromise({
    try: f,
    catch: (e) =>
      e instanceof WarehouseError ? e : new WarehouseError({ message: `BigQuery: ${e instanceof Error ? e.message : String(e)}` }),
  }).pipe(Effect.withSpan(span));

export const parseServiceAccount = (json: string): Effect.Effect<ServiceAccount, WarehouseError> =>
  Effect.try({
    try: () => {
      const sa = JSON.parse(json) as Partial<ServiceAccount>;
      if (typeof sa.client_email !== "string" || typeof sa.private_key !== "string") throw new Error("missing fields");
      return { client_email: sa.client_email, private_key: sa.private_key, private_key_id: sa.private_key_id };
    },
    catch: () =>
      new WarehouseError({
        message: "BigQuery: the credentials are not a service account key JSON (client_email / private_key missing)",
      }),
  });

// ponytail: per-isolate token cache; isolates recycle, worst case is one extra token mint
const tokens = new Map<string, { readonly token: string; readonly expiresAt: number }>();

const accessToken = async (sa: ServiceAccount): Promise<string> => {
  const cacheKey = `${sa.client_email}:${sa.private_key_id ?? ""}`;
  const hit = tokens.get(cacheKey);
  if (hit !== undefined && hit.expiresAt - 60_000 > Date.now()) return hit.token;
  const key = await importPKCS8(sa.private_key.replace(/\\n/g, "\n"), "RS256").catch(() =>
    fail("BigQuery: the service account private_key is not a valid PEM key. Create a new JSON key and paste it again"),
  );
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) })
    .setIssuer(sa.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || body.access_token === undefined) {
    return fail(
      `BigQuery: Google rejected the key of ${sa.client_email} (${body.error_description ?? body.error ?? `HTTP ${res.status}`}). Check that the service account and its key still exist`,
    );
  }
  tokens.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
};

/** Appends the IAM role that usually fixes a permission error */
const explain = (message: string, sa: ServiceAccount, target: BigQueryTarget): string => {
  if (/bigquery\.jobs\.create/i.test(message)) {
    return `BigQuery: ${message} — grant roles/bigquery.jobUser on project ${target.projectId} to ${sa.client_email}`;
  }
  if (/access denied/i.test(message)) {
    return `BigQuery: ${message} — grant roles/bigquery.dataViewer on the dataset to ${sa.client_email}`;
  }
  if (/not found: dataset/i.test(message)) {
    return `BigQuery: ${message} — check the dataset name and that its location matches ${target.location}`;
  }
  return `BigQuery: ${message}`;
};

const call = async <T>(sa: ServiceAccount, target: BigQueryTarget, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${API}/projects/${encodeURIComponent(target.projectId)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${await accessToken(sa)}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok || json === null) return fail(explain(json?.error?.message ?? `HTTP ${res.status}`, sa, target));
  return json;
};

const param = (name: string, v: string | number | boolean) => ({
  name,
  parameterType: {
    type: typeof v === "boolean" ? "BOOL" : typeof v === "number" ? (Number.isInteger(v) ? "INT64" : "FLOAT64") : "STRING",
  },
  parameterValue: { value: String(v) },
});

const request = (target: BigQueryTarget, sql: string, params: QueryParams) => ({
  query: sql,
  useLegacySql: false,
  location: target.location,
  ...(target.dataset !== "" && { defaultDataset: { projectId: target.projectId, datasetId: target.dataset } }),
  ...(Object.keys(params).length > 0 && {
    parameterMode: "NAMED",
    queryParameters: Object.entries(params).map(([name, v]) => param(name, v)),
  }),
});

interface QueryResponse {
  readonly jobComplete: boolean;
  readonly jobReference?: { readonly jobId: string; readonly location?: string };
  readonly schema?: { readonly fields: ReadonlyArray<Field> };
  readonly rows?: ReadonlyArray<RestRow>;
  readonly pageToken?: string;
}

/** Runs GoogleSQL with named parameters; polls unfinished jobs and follows pages. Fails above maxRows */
export const query = (
  sa: ServiceAccount,
  target: BigQueryTarget,
  sql: string,
  params: QueryParams = {},
  maxRows = 10_000,
): Effect.Effect<ReadonlyArray<Row>, WarehouseError> =>
  run("bigquery.query", async () => {
    let r = await call<QueryResponse>(sa, target, "/queries", {
      ...request(target, sql, params),
      timeoutMs: 10_000,
      maxResults: maxRows,
      formatOptions: { useInt64Timestamp: true },
    });
    const rows: Row[] = [];
    for (let polls = 0; ; polls++) {
      if (r.jobComplete) {
        rows.push(...decodeRows(r.schema?.fields ?? [], r.rows));
        if (rows.length > maxRows) return fail(`BigQuery: the query returned more than ${maxRows} rows`);
        if (r.pageToken === undefined) return rows;
      } else if (polls >= MAX_POLLS) {
        return fail("BigQuery: the query is still running after 5 minutes. Filter the SQL by date or partition");
      }
      const job = r.jobReference ?? fail("BigQuery: the response has no job reference");
      const qs = new URLSearchParams({
        timeoutMs: "10000",
        "formatOptions.useInt64Timestamp": "true",
        location: job.location ?? target.location,
      });
      if (r.jobComplete && r.pageToken !== undefined) qs.set("pageToken", r.pageToken);
      r = await call<QueryResponse>(sa, target, `/queries/${encodeURIComponent(job.jobId)}?${qs}`);
    }
  });

/** Validates credentials, permissions and SQL without running it. Returns the bytes it would process */
export const dryRun = (
  sa: ServiceAccount,
  target: BigQueryTarget,
  sql: string,
  params: QueryParams = {},
): Effect.Effect<number, WarehouseError> =>
  run("bigquery.dryRun", async () => {
    const r = await call<{ totalBytesProcessed?: string }>(sa, target, "/queries", { ...request(target, sql, params), dryRun: true });
    return Number(r.totalBytesProcessed ?? 0);
  });

/** REST schema field; the API returns legacy type names (INTEGER, FLOAT, BOOLEAN, RECORD) */
export interface Field {
  readonly name: string;
  readonly type: string;
  readonly mode?: "NULLABLE" | "REQUIRED" | "REPEATED";
  readonly fields?: ReadonlyArray<Field>;
}
export interface RestRow {
  readonly f: ReadonlyArray<{ readonly v: unknown }>;
}

const scalar = (type: string, v: unknown): unknown => {
  if (v === null || v === undefined) return null;
  const s = v as string;
  switch (type) {
    case "INTEGER":
    case "INT64": {
      const n = Number(s);
      // ponytail: > 2^53 stays a string; add BigInt if math on it is ever needed
      return Number.isSafeInteger(n) ? n : s;
    }
    case "FLOAT":
    case "FLOAT64":
      return Number(s);
    case "BOOLEAN":
    case "BOOL":
      return s === "true";
    case "TIMESTAMP":
      // useInt64Timestamp: int64 microseconds -> ISO string (ms precision)
      return new Date(Number(BigInt(s) / 1000n)).toISOString();
    default:
      // NUMERIC / BIGNUMERIC (exact decimal string), STRING, BYTES (base64), DATE, DATETIME, TIME, JSON, ...
      return s;
  }
};

const decodeValue = (field: Field, v: unknown): unknown =>
  field.type === "RECORD" || field.type === "STRUCT"
    ? v == null
      ? null
      : decodeRow(field.fields ?? [], v as RestRow)
    : scalar(field.type, v);

const decodeRow = (fields: ReadonlyArray<Field>, row: RestRow): Row =>
  Object.fromEntries(
    fields.map((field, i) => {
      const v = row.f[i]?.v;
      return [
        field.name,
        field.mode === "REPEATED"
          ? ((v as ReadonlyArray<{ v: unknown }> | null) ?? []).map((c) => decodeValue(field, c.v))
          : decodeValue(field, v),
      ];
    }),
  );

/** REST `rows: [{ f: [{ v }] }]` + schema -> plain objects */
export const decodeRows = (fields: ReadonlyArray<Field>, rows: ReadonlyArray<RestRow> = []): Row[] =>
  rows.map((r) => decodeRow(fields, r));
