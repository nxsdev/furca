/** Test helpers: a real RSA service account key and a scripted fetch standing in for Google (no network) */
import { exportPKCS8, generateKeyPair } from "jose";
import type { ServiceAccount } from "./client";

export const makeTestServiceAccount = async (): Promise<ServiceAccount> => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return { client_email: `kuji-${crypto.randomUUID()}@test.iam.gserviceaccount.com`, private_key: await exportPKCS8(privateKey) };
};

/** A completed jobs.query response with the given column types (legacy names: STRING, INTEGER, FLOAT) */
export const bqResult = (columns: Readonly<Record<string, string>>, rows: ReadonlyArray<ReadonlyArray<unknown>>, extra = {}) => ({
  jobComplete: true,
  jobReference: { jobId: "job_1", location: "US" },
  schema: { fields: Object.entries(columns).map(([name, type]) => ({ name, type })) },
  rows: rows.map((r) => ({ f: r.map((v) => ({ v: v === null ? null : String(v) })) })),
  ...extra,
});

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

/**
 * Replaces globalThis.fetch: the OAuth token endpoint always succeeds, BigQuery calls are answered by
 * `responses` in order, anything else goes to the real fetch. Call `restore()` when done
 */
export const fakeBigQuery = (responses: ReadonlyArray<{ readonly status?: number; readonly body: unknown }>) => {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  const tokenRequests: string[] = [];
  let next = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://") || !url.includes("googleapis.com")) return original(input, init);
    if (url === "https://oauth2.googleapis.com/token") {
      tokenRequests.push(String(init?.body));
      return Response.json({ access_token: "test-token", expires_in: 3600 });
    }
    requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const response = responses[next++];
    if (response === undefined) throw new Error(`Unexpected BigQuery request #${next}: ${url}`);
    return Response.json(response.body, { status: response.status ?? 200 });
  }) as typeof fetch;
  return {
    requests,
    tokenRequests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
};
