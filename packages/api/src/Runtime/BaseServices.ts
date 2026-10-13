import { CredentialCipher } from "@kuji/core/datasources/CredentialCipher";
import { PayloadStore } from "@kuji/core/environments/PayloadStore";
import { PersistenceError, ValidationError } from "@kuji/core/shared/errors";
import { DatabaseLive } from "@kuji/database/Database";
import { Effect, Layer } from "effect";
import type { KujiEnv } from "./Env";

const payloadKey = (sdkKey: string) => `payload:${sdkKey}`;

export const PayloadStoreKv = (kv: KVNamespace) =>
  Layer.succeed(PayloadStore, {
    put: (sdkKey, json) =>
      Effect.tryPromise({
        try: () => kv.put(payloadKey(sdkKey), json),
        catch: (cause) => new PersistenceError({ operation: "payload.put", cause }),
      }),
    get: (sdkKey) =>
      Effect.tryPromise({
        try: () => kv.get(payloadKey(sdkKey)),
        catch: (cause) => new PersistenceError({ operation: "payload.get", cause }),
      }),
    remove: (sdkKey) =>
      Effect.tryPromise({
        try: () => kv.delete(payloadKey(sdkKey)),
        catch: (cause) => new PersistenceError({ operation: "payload.remove", cause }),
      }),
  });

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** AES-256-GCM with a key derived from ENCRYPTION_KEY (SHA-256). Output: base64(iv).base64(ciphertext) */
export const CredentialCipherAesGcm = (secret: string) => {
  const key = crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(secret))
    .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  return Layer.succeed(CredentialCipher, {
    encrypt: (plaintext) =>
      Effect.promise(async () => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key, new TextEncoder().encode(plaintext));
        return `${b64(iv)}.${b64(new Uint8Array(data))}`;
      }),
    decrypt: (ciphertext) =>
      Effect.tryPromise({
        try: async () => {
          const [iv = "", data = ""] = ciphertext.split(".");
          const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key, unb64(data));
          return new TextDecoder().decode(plain);
        },
        catch: () => new ValidationError({ message: "Stored credentials cannot be decrypted. Was ENCRYPTION_KEY changed?" }),
      }),
  });
};

/** Infrastructure services every request gets */
export const makeBaseLayer = (env: KujiEnv) =>
  Layer.mergeAll(DatabaseLive(env.DB), PayloadStoreKv(env.KV), CredentialCipherAesGcm(env.ENCRYPTION_KEY));

export type BaseServices = Layer.Success<ReturnType<typeof makeBaseLayer>>;
