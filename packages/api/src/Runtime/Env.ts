/** Cloudflare bindings of the kuji Worker. packages/infra must bind exactly these */
export interface KujiEnv {
  readonly DB: D1Database;
  /** SDK payload per environment: key `payload:<sdkKey>` */
  readonly KV: KVNamespace;
  /** Better Auth cookie signing secret (>= 32 chars) */
  readonly BETTER_AUTH_SECRET: string;
  /** Encrypts data source credentials at rest (AES-GCM, any string >= 32 chars) */
  readonly ENCRYPTION_KEY: string;
  /** Public origin, e.g. https://kuji.example.com. Optional: inferred from the request */
  readonly BETTER_AUTH_URL?: string;
}
