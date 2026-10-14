/**
 * Snowflake SQL API v2 client for Workers: a key-pair JWT (jose, WebCrypto) signed per call ->
 * POST /api/v2/statements, polling statements that outlive the synchronous wait and fetching every
 * result partition. No Node built-ins. Failures are WarehouseErrors that say what to fix
 */
import type { SnowflakeConfig } from "@furca/core/datasources/DataSource";
import type { WarehouseError } from "@furca/core/shared/errors";
import type { Effect } from "effect";
import { importPKCS8, SignJWT } from "jose";
import { attempt, bindParams, fail, type QueryParams, type Row } from "../shared";

/** Statement timeout and polling deadline */
const TIMEOUT_S = 300;

/** `myorg-my_account.privatelink` -> myorg-my-account.privatelink.snowflakecomputing.com */
export const accountHost = (account: string) => `${account.trim().toLowerCase().replace(/_/g, "-")}.snowflakecomputing.com`;

/** The JWT names the account without region / cloud / privatelink suffixes, upper-case */
const jwtAccount = (account: string) => account.trim().split(".")[0]!.toUpperCase();

/** `SHA256:<base64 SHA-256 of the DER public key>`, as `DESC USER` shows RSA_PUBLIC_KEY_FP */
export const publicKeyFingerprint = async (privateKey: CryptoKey): Promise<string> => {
  const { n, e } = await crypto.subtle.exportKey("jwk", privateKey);
  const publicKey = await crypto.subtle.importKey("jwk", { kty: "RSA", n, e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, [
    "verify",
  ]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await crypto.subtle.exportKey("spki", publicKey)));
  return `SHA256:${btoa(String.fromCharCode(...digest))}`;
};

/** Key-pair auth JWT: iss ACCOUNT.USER.SHA256:fp, sub ACCOUNT.USER, valid 59 minutes */
export const keyPairJwt = async (config: SnowflakeConfig, privateKeyPem: string, nowMs = Date.now()): Promise<string> => {
  const key = await importPKCS8(privateKeyPem.trim(), "RS256", { extractable: true }).catch(() =>
    fail("Snowflake: the private key is not a valid unencrypted PKCS#8 PEM key (-----BEGIN PRIVATE KEY-----)"),
  );
  const qualified = `${jwtAccount(config.account)}.${config.user.trim().toUpperCase()}`;
  const now = Math.floor(nowMs / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(`${qualified}.${await publicKeyFingerprint(key)}`)
    .setSubject(qualified)
    .setIssuedAt(now)
    .setExpirationTime(now + 59 * 60)
    .sign(key);
};

interface ColumnType {
  readonly name: string;
  readonly type: string;
  readonly scale?: number | null;
}

interface StatementResponse {
  readonly code?: string;
  readonly message?: string;
  readonly statementHandle?: string;
  readonly resultSetMetaData?: {
    readonly rowType: ReadonlyArray<ColumnType>;
    readonly partitionInfo?: ReadonlyArray<unknown>;
  };
  /** jsonv2: every value is a string or null */
  readonly data?: ReadonlyArray<ReadonlyArray<string | null>>;
}

const binding = (v: string | number) =>
  typeof v === "string" ? { type: "TEXT", value: v } : { type: Number.isInteger(v) ? "FIXED" : "REAL", value: String(v) };

const scalar = ({ type, scale }: ColumnType, v: string | null): unknown => {
  if (v === null) return null;
  switch (type.toLowerCase()) {
    case "fixed": {
      const n = Number(v);
      // ponytail: integers beyond 2^53 stay strings, like the BigQuery client
      return (scale ?? 0) > 0 || Number.isSafeInteger(n) ? n : v;
    }
    case "real":
      return Number(v);
    case "boolean":
      return v === "true" || v === "1";
    case "date":
      return new Date(Number(v) * 86_400_000).toISOString().slice(0, 10);
    case "timestamp_ltz":
    case "timestamp_ntz":
    case "timestamp_tz":
      // epoch seconds with a fraction; TIMESTAMP_TZ appends " <offset>"
      return new Date(Math.round(Number(v.split(" ")[0]) * 1000)).toISOString();
    default:
      return v;
  }
};

/** jsonv2 rows + rowType -> plain objects. Column names are lower-cased (unquoted aliases come back upper-case) */
export const decodeRows = (columns: ReadonlyArray<ColumnType>, data: ReadonlyArray<ReadonlyArray<string | null>> = []): Row[] =>
  data.map((r) => Object.fromEntries(columns.map((c, i) => [c.name.toLowerCase(), scalar(c, r[i] ?? null)])));

/** Runs one statement. `@name` params become `?` bindings; the session runs in UTC */
export const query = (
  config: SnowflakeConfig,
  privateKeyPem: string,
  sql: string,
  params: QueryParams = {},
): Effect.Effect<ReadonlyArray<Row>, WarehouseError> =>
  attempt("Snowflake", "snowflake.query", async () => {
    const host = accountHost(config.account);
    const base = `https://${host}/api/v2/statements`;
    const headers = {
      authorization: `Bearer ${await keyPairJwt(config, privateKeyPem)}`,
      "x-snowflake-authorization-token-type": "KEYPAIR_JWT",
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "furca",
    };
    const call = async (url: string, body?: unknown) => {
      const res = await fetch(url, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }).catch(
        (e: unknown) => fail(`Snowflake: could not reach ${host} (${e instanceof Error ? e.message : String(e)}). Check the account identifier`),
      );
      const json = (await res.json().catch(() => null)) as StatementResponse | null;
      if (res.status === 401) {
        return fail(
          `Snowflake: authentication failed (${json?.message ?? "HTTP 401"}). Check the account identifier and user, and that the user's RSA_PUBLIC_KEY matches this private key`,
        );
      }
      if ((res.status !== 200 && res.status !== 202) || json === null) return fail(`Snowflake: ${json?.message ?? `HTTP ${res.status}`}`);
      return { status: res.status, body: json };
    };

    const bindings: Record<string, ReturnType<typeof binding>> = {};
    const statement = bindParams(sql, params, (_, v) => {
      bindings[String(Object.keys(bindings).length + 1)] = binding(v);
      return "?";
    });
    let r = await call(base, {
      statement,
      timeout: TIMEOUT_S,
      warehouse: config.warehouse,
      database: config.database,
      schema: config.schema,
      ...(config.role.trim() !== "" && { role: config.role }),
      ...(Object.keys(bindings).length > 0 && { bindings }),
      parameters: { timezone: "UTC", query_tag: "furca" },
    });
    const handle = () => encodeURIComponent(r.body.statementHandle ?? fail("Snowflake: the response has no statement handle"));
    const deadline = Date.now() + TIMEOUT_S * 1000;
    for (let wait = 250; r.status === 202; wait = Math.min(wait * 2, 5000)) {
      if (Date.now() > deadline) return fail("Snowflake: the query is still running after 5 minutes. Filter the SQL by date");
      await new Promise((resolve) => setTimeout(resolve, wait));
      r = await call(`${base}/${handle()}`);
    }
    const meta = r.body.resultSetMetaData ?? fail("Snowflake: the response has no result metadata");
    const data = [...(r.body.data ?? [])];
    for (let partition = 1; partition < (meta.partitionInfo?.length ?? 1); partition++) {
      data.push(...((await call(`${base}/${handle()}?partition=${partition}`)).body.data ?? []));
    }
    return decodeRows(meta.rowType, data);
  });
