import { WarehouseError } from "@furca/core/shared/errors";
import { Effect } from "effect";

/** Named query parameters, written `@name` in SQL and bound natively by each client. Never interpolate user input */
export type QueryParams = Readonly<Record<string, string | number>>;

export type Row = Record<string, unknown>;

export const fail = (message: string): never => {
  throw new WarehouseError({ message });
};

/** Effect boundary: thrown WarehouseErrors pass through, anything else becomes `${label}: ${message}` */
export const attempt = <A>(label: string, span: string, f: () => Promise<A>): Effect.Effect<A, WarehouseError> =>
  Effect.tryPromise({
    try: f,
    catch: (e) => (e instanceof WarehouseError ? e : new WarehouseError({ message: `${label}: ${e instanceof Error ? e.message : String(e)}` })),
  }).pipe(Effect.withSpan(span));

/**
 * Rewrites `@name` references to params, left to right, into the driver's placeholder. Other `@`
 * words are left alone (Postgres `@` operator, Snowflake stages)
 */
export const bindParams = (sql: string, params: QueryParams, placeholder: (name: string, value: string | number) => string): string =>
  sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) =>
    Object.hasOwn(params, name) ? placeholder(name, params[name]!) : match,
  );
