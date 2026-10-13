import { Context, type Effect } from "effect";
import type { DataSource } from "./DataSource";

export interface WarehouseTestResult {
  readonly ok: boolean;
  /** Human-readable outcome, shown verbatim in the UI */
  readonly message: string;
  /** Dry-run estimate of the exposure query, when the warehouse reports it */
  readonly bytesProcessed: number | null;
}

/** Authenticates against a data source and dry-runs its exposure SQL. Never fails: errors become ok=false */
export interface WarehouseTesterShape {
  readonly test: (dataSource: DataSource) => Effect.Effect<WarehouseTestResult>;
}

export class WarehouseTester extends Context.Service<WarehouseTester, WarehouseTesterShape>()(
  "kuji/WarehouseTester",
) {}
