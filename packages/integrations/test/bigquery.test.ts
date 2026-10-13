import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { decodeRows, dryRun, parseServiceAccount, query } from "../src/bigquery/client";
import { bqResult, fakeBigQuery, makeTestServiceAccount } from "../src/bigquery/testing";

const target = { projectId: "acme-analytics", dataset: "events", location: "asia-northeast1" };
const sa = await makeTestServiceAccount();
let fake: ReturnType<typeof fakeBigQuery> | undefined;
afterEach(() => fake?.restore());

const failure = <A>(effect: Effect.Effect<A, { message: string }>) =>
  Effect.runPromise(Effect.flip(effect)).then((e) => e.message);

describe("decodeRows", () => {
  it("decodes REST rows by schema: INT64, FLOAT64, BOOL, TIMESTAMP, NULL, REPEATED and RECORD", () => {
    const rows = decodeRows(
      [
        { name: "n", type: "INTEGER" },
        { name: "big", type: "INTEGER" },
        { name: "x", type: "FLOAT" },
        { name: "ok", type: "BOOLEAN" },
        { name: "at", type: "TIMESTAMP" },
        { name: "missing", type: "STRING" },
        { name: "tags", type: "STRING", mode: "REPEATED" },
        { name: "rec", type: "RECORD", fields: [{ name: "k", type: "STRING" }] },
      ],
      [{ f: [{ v: "42" }, { v: "9007199254740993" }, { v: "1.5" }, { v: "true" }, { v: "1760000000123456" }, { v: null }, { v: [{ v: "a" }, { v: "b" }] }, { v: { f: [{ v: "v" }] } }] }],
    );
    expect(rows).toEqual([
      { n: 42, big: "9007199254740993", x: 1.5, ok: true, at: "2025-10-09T08:53:20.123Z", missing: null, tags: ["a", "b"], rec: { k: "v" } },
    ]);
  });
});

describe("query", () => {
  it("signs a JWT for the token, sends named parameters, polls an unfinished job and follows pages", async () => {
    fake = fakeBigQuery([
      { body: { jobComplete: false, jobReference: { jobId: "job 1", location: "asia-northeast1" } } },
      { body: bqResult({ variation: "STRING", users: "INTEGER" }, [["control", 10]], { pageToken: "p2" }) },
      { body: bqResult({ variation: "STRING", users: "INTEGER" }, [[null, 2]]) },
    ]);
    const rows = await Effect.runPromise(
      query(sa, target, "SELECT @experiment_key, @start_ms, @rate", { experiment_key: "checkout", start_ms: 1760000000000, rate: 0.5 }),
    );
    expect(rows).toEqual([
      { variation: "control", users: 10 },
      { variation: null, users: 2 },
    ]);
    expect(fake.tokenRequests[0]).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    const [first, poll, page] = fake.requests;
    expect(first!.url).toBe("https://bigquery.googleapis.com/bigquery/v2/projects/acme-analytics/queries");
    expect(first!.body).toMatchObject({
      useLegacySql: false,
      location: "asia-northeast1",
      defaultDataset: { projectId: "acme-analytics", datasetId: "events" },
      parameterMode: "NAMED",
      queryParameters: [
        { name: "experiment_key", parameterType: { type: "STRING" }, parameterValue: { value: "checkout" } },
        { name: "start_ms", parameterType: { type: "INT64" }, parameterValue: { value: "1760000000000" } },
        { name: "rate", parameterType: { type: "FLOAT64" }, parameterValue: { value: "0.5" } },
      ],
    });
    expect(poll!.url).toContain("/queries/job%201?");
    expect(poll!.url).toContain("location=asia-northeast1");
    expect(poll!.url).not.toContain("pageToken");
    expect(page!.url).toContain("/queries/job_1?");
    expect(page!.url).toContain("pageToken=p2");
  });

  it("fails with the IAM role to grant when BigQuery denies access to a table", async () => {
    fake = fakeBigQuery([
      { status: 403, body: { error: { message: "Access Denied: Table acme-analytics:events.purchases: User does not have permission" } } },
    ]);
    expect(await failure(query(sa, target, "SELECT 1"))).toBe(
      `BigQuery: Access Denied: Table acme-analytics:events.purchases: User does not have permission — grant roles/bigquery.dataViewer on the dataset to ${sa.client_email}`,
    );
  });

  it("fails with roles/bigquery.jobUser when the account cannot create jobs", async () => {
    fake = fakeBigQuery([
      { status: 403, body: { error: { message: "Access Denied: Project acme-analytics: User does not have bigquery.jobs.create permission" } } },
    ]);
    expect(await failure(query(sa, target, "SELECT 1"))).toContain(`grant roles/bigquery.jobUser on project acme-analytics to ${sa.client_email}`);
  });

  it("fails instead of truncating when the result exceeds the row cap", async () => {
    fake = fakeBigQuery([{ body: bqResult({ n: "INTEGER" }, [[1], [2], [3]]) }]);
    expect(await failure(query(sa, target, "SELECT n", {}, 2))).toBe("BigQuery: the query returned more than 2 rows");
  });
});

describe("dryRun", () => {
  it("returns the bytes the query would process", async () => {
    fake = fakeBigQuery([{ body: { totalBytesProcessed: "123456789" } }]);
    expect(await Effect.runPromise(dryRun(sa, target, "SELECT 1"))).toBe(123456789);
    expect(fake.requests[0]!.body).toMatchObject({ dryRun: true, query: "SELECT 1" });
  });
});

describe("parseServiceAccount", () => {
  it("rejects JSON that is not a service account key", async () => {
    expect(await failure(parseServiceAccount('{"type":"authorized_user"}'))).toContain("not a service account key JSON");
  });

  it("rejects a private key that is not PEM when minting the token", async () => {
    fake = fakeBigQuery([]);
    const broken = { client_email: "broken@test.iam.gserviceaccount.com", private_key: "nope" };
    expect(await failure(dryRun(broken, target, "SELECT 1"))).toContain("private_key is not a valid PEM key");
  });
});
