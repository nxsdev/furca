import { afterEach, describe, expect, it } from "bun:test";
import { ClickHouseConfig, PostgresConfig, SnowflakeConfig } from "@furca/core/datasources/DataSource";
import { Effect } from "effect";
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";
import * as ClickHouse from "../src/clickhouse/client";
import * as Postgres from "../src/postgres/client";
import { bindParams } from "../src/shared";
import * as Snowflake from "../src/snowflake/client";
import { connect } from "../src/warehouse";

const failure = <A>(effect: Effect.Effect<A, { message: string }>) => Effect.runPromise(Effect.flip(effect)).then((e) => e.message);

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
}

/** A fetch that records requests and answers them in order */
const scriptedFetch = (responses: ReadonlyArray<() => Response>) => {
  const requests: Recorded[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body == null ? null : String(init.body),
    });
    const response = responses[requests.length - 1];
    if (response === undefined) throw new Error(`Unexpected request #${requests.length}: ${String(input)}`);
    return response();
  }) as typeof globalThis.fetch;
  return { fetch, requests };
};

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

describe("bindParams", () => {
  it("rewrites only @names that are params, left to right, and leaves operators and prototype names alone", () => {
    const seen: string[] = [];
    const sql = bindParams("SELECT @a, @b, @a, @> x, @toString, @missing", { a: 1, b: "x" }, (name) => {
      seen.push(name);
      return "?";
    });
    expect(sql).toBe("SELECT ?, ?, ?, @> x, @toString, @missing");
    expect(seen).toEqual(["a", "b", "a"]);
  });
});

const keys = await generateKeyPair("RS256", { extractable: true });
const pem = await exportPKCS8(keys.privateKey);
/** Computed independently: SHA-256 of the DER public key, base64 */
const fingerprint = `SHA256:${Buffer.from(await crypto.subtle.digest("SHA-256", await crypto.subtle.exportKey("spki", keys.publicKey))).toString("base64")}`;

describe("Snowflake", () => {
  const config = SnowflakeConfig.make({
    account: "xy12345.us-east-2.aws",
    user: "furca_reader",
    warehouse: "ANALYTICS_WH",
    database: "ANALYTICS",
    schema: "PUBLIC",
    role: "FURCA",
  });

  it("signs a key-pair JWT naming the account locator, the user and the public key fingerprint", async () => {
    const now = Date.UTC(2026, 9, 14, 12);
    const jwt = await Snowflake.keyPairJwt(config, pem, now);
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeJwt(jwt)).toEqual({
      iss: `XY12345.FURCA_READER.${fingerprint}`,
      sub: "XY12345.FURCA_READER",
      iat: now / 1000,
      exp: now / 1000 + 59 * 60,
    });
    expect(Snowflake.accountHost("myorg-my_account")).toBe("myorg-my-account.snowflakecomputing.com");
  });

  it("binds @params as positional ?, polls a 202 statement, fetches every partition and decodes by rowType", async () => {
    const rowType = [
      { name: "VARIATION", type: "text" },
      { name: "N", type: "fixed", scale: 0 },
      { name: "SUM_Y", type: "fixed", scale: 2 },
      { name: "CAP_VALUE", type: "real" },
      { name: "DAY", type: "date" },
      { name: "T0", type: "timestamp_ntz" },
    ];
    const fake = scriptedFetch([
      () => Response.json({ code: "333334", message: "Asynchronous execution in progress.", statementHandle: "01b-h1" }, { status: 202 }),
      () =>
        Response.json({
          statementHandle: "01b-h1",
          resultSetMetaData: { rowType, partitionInfo: [{ rowCount: 1 }, { rowCount: 1 }] },
          data: [["control", "500", "12.50", "1.5", "20362", "1790856000.123000000"]],
        }),
      () => Response.json({ data: [[null, "9007199254740993", null, null, null, null]] }),
    ]);
    globalThis.fetch = fake.fetch;
    const rows = await Effect.runPromise(
      Snowflake.query(config, pem, "SELECT @experiment_key, @start_ms, @rate, @start_ms", { experiment_key: "checkout", start_ms: 1760000000000, rate: 0.5 }),
    );
    expect(rows).toEqual([
      { variation: "control", n: 500, sum_y: 12.5, cap_value: 1.5, day: "2025-10-01", t0: "2026-10-01T12:00:00.123Z" },
      { variation: null, n: "9007199254740993", sum_y: null, cap_value: null, day: null, t0: null },
    ]);
    const [post, poll, partition] = fake.requests;
    expect(post!.url).toBe("https://xy12345.us-east-2.aws.snowflakecomputing.com/api/v2/statements");
    expect(post!.headers.get("x-snowflake-authorization-token-type")).toBe("KEYPAIR_JWT");
    expect(decodeJwt(post!.headers.get("authorization")!.replace("Bearer ", "")).sub).toBe("XY12345.FURCA_READER");
    expect(JSON.parse(post!.body!)).toEqual({
      statement: "SELECT ?, ?, ?, ?",
      timeout: 300,
      warehouse: "ANALYTICS_WH",
      database: "ANALYTICS",
      schema: "PUBLIC",
      role: "FURCA",
      bindings: {
        "1": { type: "TEXT", value: "checkout" },
        "2": { type: "FIXED", value: "1760000000000" },
        "3": { type: "REAL", value: "0.5" },
        "4": { type: "FIXED", value: "1760000000000" },
      },
      parameters: { timezone: "UTC", query_tag: "furca" },
    });
    expect([poll!.method, poll!.url]).toEqual(["GET", "https://xy12345.us-east-2.aws.snowflakecomputing.com/api/v2/statements/01b-h1"]);
    expect(partition!.url).toBe("https://xy12345.us-east-2.aws.snowflakecomputing.com/api/v2/statements/01b-h1?partition=1");
  });

  it("explains authentication failures and passes SQL errors through", async () => {
    globalThis.fetch = scriptedFetch([
      () => Response.json({ code: "390144", message: "JWT token is invalid." }, { status: 401 }),
      () => Response.json({ code: "002003", message: "SQL compilation error:\nObject 'EXPOSURES' does not exist or not authorized." }, { status: 422 }),
    ]).fetch;
    expect(await failure(Snowflake.query(config, pem, "SELECT 1"))).toBe(
      "Snowflake: authentication failed (JWT token is invalid.). Check the account identifier and user, and that the user's RSA_PUBLIC_KEY matches this private key",
    );
    expect(await failure(Snowflake.query(config, pem, "SELECT 1"))).toBe(
      "Snowflake: SQL compilation error:\nObject 'EXPOSURES' does not exist or not authorized.",
    );
    expect(await failure(Snowflake.query(config, "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----", "SELECT 1"))).toContain(
      "not a valid unencrypted PKCS#8 PEM key",
    );
  });
});

describe("ClickHouse", () => {
  const config = ClickHouseConfig.make({ url: "https://ch.example.com:8443", database: "analytics", username: "furca" });

  it("sends typed query parameters and Basic auth, no session settings, and reads JSONEachRow", async () => {
    const fake = scriptedFetch([
      () => new Response('{"variation":"control","users":"500"}\n{"variation":null,"users":"3"}\n', { headers: { "content-type": "application/x-ndjson" } }),
    ]);
    const rows = await Effect.runPromise(
      ClickHouse.query(config, "s3cret", "SELECT @experiment_key, @start_ms, @rate, @start_ms", { experiment_key: "checkout", start_ms: 1760000000000, rate: 0.5 }, fake.fetch),
    );
    expect(rows).toEqual([
      { variation: "control", users: "500" },
      { variation: null, users: "3" },
    ]);
    const [request] = fake.requests;
    const url = new URL(request!.url);
    expect(url.origin).toBe("https://ch.example.com:8443");
    expect(url.searchParams.get("database")).toBe("analytics");
    expect(url.searchParams.get("param_experiment_key")).toBe("checkout");
    expect(url.searchParams.get("param_start_ms")).toBe("1760000000000");
    expect([...url.searchParams.keys()].filter((k) => !k.startsWith("param_") && k !== "database" && k !== "query_id")).toEqual([]);
    expect(request!.headers.get("authorization")).toBe(`Basic ${btoa("furca:s3cret")}`);
    expect(request!.body).toBe("SELECT {experiment_key:String}, {start_ms:Int64}, {rate:Float64}, {start_ms:Int64} \nFORMAT JSONEachRow");
  });

  it("explains authentication failures, passes server errors through and names the URL it could not reach", async () => {
    const fake = scriptedFetch([
      () =>
        new Response(
          "Code: 516. DB::Exception: furca: Authentication failed: password is incorrect, or there is no user with such name. (AUTHENTICATION_FAILED) (version 24.8.4.13 (official build))",
          { status: 401 },
        ),
      () => new Response("Code: 60. DB::Exception: Unknown table expression identifier 'exposures' in scope SELECT. (UNKNOWN_TABLE) (version 24.8.4.13)", { status: 404 }),
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    expect(await failure(ClickHouse.query(config, "x", "SELECT 1", {}, fake.fetch))).toBe(
      "ClickHouse: furca: Authentication failed: password is incorrect, or there is no user with such name. Check the user name and password",
    );
    expect(await failure(ClickHouse.query(config, "x", "SELECT 1", {}, fake.fetch))).toBe(
      "ClickHouse: Unknown table expression identifier 'exposures' in scope SELECT.",
    );
    expect(await failure(ClickHouse.query(config, "x", "SELECT 1", {}, fake.fetch))).toBe(
      "ClickHouse: could not reach https://ch.example.com:8443 (fetch failed). Check the URL and port (HTTPS is usually 8443)",
    );
  });
});

describe("Postgres", () => {
  const config = PostgresConfig.make({ host: "db.example.com", port: 6543, database: "app", user: "furca", ssl: "require" });
  const real = Postgres.driver.connect;
  afterEach(() => {
    Postgres.driver.connect = real;
  });

  /** Stands in for porsager/postgres: records options, the query and whether the connection was closed */
  const fakeDriver = (result: () => Promise<ReadonlyArray<Record<string, unknown>>>) => {
    const calls: { options?: unknown; text?: string; values?: unknown; ended: boolean } = { ended: false };
    Postgres.driver.connect = ((options: unknown) => {
      calls.options = options;
      return {
        unsafe: (text: string, values: unknown) => {
          calls.text = text;
          calls.values = values;
          return result();
        },
        end: async () => {
          calls.ended = true;
        },
      };
    }) as unknown as typeof Postgres.driver.connect;
    return calls;
  };

  it("binds @params as typed $n (one number per name), connects once without prepared statements and always closes", async () => {
    const calls = fakeDriver(async () => [{ variation: "control", users: "500" }]);
    const rows = await Effect.runPromise(
      Postgres.query(config, "s3cret", "SELECT @experiment_key, @start_ms, @rate, @start_ms", { experiment_key: "checkout", start_ms: 1760000000000, rate: 0.5 }),
    );
    expect(rows).toEqual([{ variation: "control", users: "500" }]);
    expect(calls.text).toBe("SELECT CAST($1 AS TEXT), CAST($2 AS BIGINT), CAST($3 AS DOUBLE PRECISION), CAST($2 AS BIGINT)");
    expect(calls.values).toEqual(["checkout", 1760000000000, 0.5]);
    expect(calls.options).toMatchObject({
      host: "db.example.com",
      port: 6543,
      database: "app",
      username: "furca",
      password: "s3cret",
      ssl: "require",
      prepare: false,
      fetch_types: false,
      max: 1,
      connection: { TimeZone: "UTC" },
    });
    expect(calls.ended).toBe(true);
  });

  it("closes the connection on errors and says what to check", async () => {
    const auth = fakeDriver(async () => {
      throw Object.assign(new Error('password authentication failed for user "furca"'), { name: "PostgresError", code: "28P01" });
    });
    expect(await failure(Postgres.query(config, "x", "SELECT 1"))).toBe(
      'Postgres: password authentication failed for user "furca". Check the user name and password',
    );
    expect(auth.ended).toBe(true);
    fakeDriver(async () => {
      throw Object.assign(new Error("write CONNECT_TIMEOUT db.example.com:6543"), { code: "CONNECT_TIMEOUT" });
    });
    expect(await failure(Postgres.query(config, "x", "SELECT 1"))).toBe(
      "Postgres: could not connect to db.example.com:6543 (write CONNECT_TIMEOUT db.example.com:6543). Check the host, port and SSL setting, and that the database accepts connections from the internet",
    );
  });

  it("checks SQL elsewhere than BigQuery by running it with LIMIT 0", async () => {
    const calls = fakeDriver(async () => []);
    const warehouse = await Effect.runPromise(connect(config, "s3cret"));
    expect(await Effect.runPromise(warehouse.check("SELECT * FROM exposures", {}))).toBeNull();
    expect(calls.text).toBe("SELECT * FROM exposures\nLIMIT 0");
    expect(warehouse.identity).toBe("furca");
  });
});
