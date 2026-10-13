import { Context, type Effect } from "effect";
import type { ValidationError } from "../shared/errors";

/** Encrypts warehouse credentials at rest. Ciphertext is an opaque string safe to store in D1 */
export interface CredentialCipherShape {
  readonly encrypt: (plaintext: string) => Effect.Effect<string>;
  /** Fails when the ciphertext was produced with another key */
  readonly decrypt: (ciphertext: string) => Effect.Effect<string, ValidationError>;
}

export class CredentialCipher extends Context.Service<CredentialCipher, CredentialCipherShape>()(
  "kuji/CredentialCipher",
) {}
