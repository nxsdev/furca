import { afterAll, describe, expect, it } from "bun:test";
import { AuditService } from "@furca/core/audit/AuditService";
import { PayloadStore } from "@furca/core/environments/PayloadStore";
import { defaultStatsSettings, ExperimentPlan, Variation } from "@furca/core/experiments/Experiment";
import { type ExperimentDraft, ExperimentService } from "@furca/core/experiments/ExperimentService";
import { NamespaceAllocation } from "@furca/core/experiments/Namespace";
import { NamespaceService } from "@furca/core/experiments/NamespaceService";
import { ForceRule } from "@furca/core/features/Feature";
import { FeatureService } from "@furca/core/features/FeatureService";
import { EventMetricDefinition, EventSource } from "@furca/core/metrics/Metric";
import { MetricService } from "@furca/core/metrics/MetricService";
import { Condition } from "@furca/core/targeting/Condition";
import { SavedGroupService } from "@furca/core/targeting/SavedGroupService";
import { makeTestD1, TestDatabaseLayer } from "@furca/database/testing/TestDatabase";
import type { ExperimentPayloadRule, SdkPayload } from "@furca/sdk/types";
import { Effect, Layer } from "effect";
import { AuditServiceLive } from "../src/Layers/AuditServiceLive";
import { ExperimentServiceLive } from "../src/Layers/ExperimentServiceLive";
import { FeatureServiceLive } from "../src/Layers/FeatureServiceLive";
import { MetricServiceLive } from "../src/Layers/MetricServiceLive";
import { NamespaceServiceLive } from "../src/Layers/NamespaceServiceLive";
import { SavedGroupServiceLive } from "../src/Layers/SavedGroupServiceLive";

const t = await makeTestD1();
afterAll(() => t.dispose());

const kv = new Map<string, string>();
const layer = Layer.mergeAll(
  FeatureServiceLive,
  ExperimentServiceLive,
  MetricServiceLive,
  SavedGroupServiceLive,
  NamespaceServiceLive,
  AuditServiceLive,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      TestDatabaseLayer(t.d1),
      Layer.succeed(PayloadStore, {
        put: (key, json) => Effect.sync(() => void kv.set(key, json)),
        get: (key) => Effect.sync(() => kv.get(key) ?? null),
        remove: (key) => Effect.sync(() => void kv.delete(key)),
      }),
    ),
  ),
);

type Services = FeatureService | ExperimentService | MetricService | SavedGroupService | NamespaceService | AuditService;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => Effect.runPromise(Effect.provide(effect, layer));
const fail = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(Effect.provide(Effect.flip(effect), layer)) as Promise<{ _tag: string; message?: string }>;

const actor = { id: "user-1", email: "owner@example.com" };
const PROD = "env_production";
const sdkKey = (await t.d1.prepare("select sdk_key from environments where id = ?").bind(PROD).first<{ sdk_key: string }>())!.sdk_key;
const payload = (): SdkPayload => JSON.parse(kv.get(sdkKey)!);

const inGroup = (id: string, operator: "in_group" | "not_in_group" = "in_group") => Condition.make({ attribute: "", operator, values: [id] });
const createList = (key: string, values: Array<string>) =>
  SavedGroupService.use((s) => s.create({ key, name: key, description: "", type: "list", conditions: [], attribute: "id", values }, actor));
const listGroup = (key: string, values: Array<string>) => run(createList(key, values));

const metric = await run(
  MetricService.use((s) =>
    s.create(
      {
        key: "purchase",
        name: "Purchase",
        description: "",
        type: "proportion",
        dataSourceId: "builtin",
        definition: EventMetricDefinition.make({ numerator: EventSource.make({ event: "purchase", aggregation: "count", filters: [] }), denominator: null }),
        inverse: false,
        windowHours: null,
        delayHours: 0,
        capping: { type: "none" },
      },
      actor,
    ),
  ),
);

const enabledFlag = async (key: string) => {
  const flag = await run(FeatureService.use((s) => s.create({ key, description: "", valueType: "string", defaultValue: '"control"', tags: [] }, actor)));
  await run(FeatureService.use((s) => s.setEnabled({ id: flag.id, environmentId: PROD, enabled: true }, actor)));
  return flag;
};

const draft = (featureId: string, overrides: Partial<ExperimentDraft> = {}): ExperimentDraft => ({
  name: "Checkout test",
  hypothesis: "",
  featureId,
  environmentIds: [PROD],
  analysisEnvironmentId: PROD,
  hashAttribute: "id",
  variations: [Variation.make({ key: "control", name: "Control", value: '"control"' }), Variation.make({ key: "blue", name: "Blue", value: '"blue"' })],
  coverage: 1,
  weights: [0.5, 0.5],
  conditions: [],
  dataSourceId: "builtin",
  primaryMetricId: metric.id,
  secondaryMetricIds: [],
  guardrailMetricIds: [],
  stats: defaultStatsSettings(),
  plan: ExperimentPlan.make({ mde: 0.05, sampleSizePerVariation: null, dailyTraffic: null }),
  dimensions: [],
  namespace: null,
  ...overrides,
});

describe("saved groups", () => {
  it("stores list groups with trimmed unique values and audits every change", async () => {
    const group = await listGroup("beta", [" u1 ", "u2", "u1", ""]);
    expect(group.values).toEqual(["u1", "u2"]);
    const updated = await run(
      SavedGroupService.use((s) => s.update({ ...group, id: group.id, name: "Beta users", values: ["u3"] }, actor)),
    );
    expect(updated.name).toBe("Beta users");
    expect((await run(SavedGroupService.use((s) => s.get(group.id)))).values).toEqual(["u3"]);
    const audit = await run(AuditService.use((s) => s.list({ entityType: "savedGroup", entityId: group.id, before: null, limit: 10 })));
    expect(audit.map((a) => a.action).sort()).toEqual(["created", "updated"]);
  });

  it("rejects duplicate keys, nested group conditions, empty lists and lists over 10,000 values", async () => {
    expect((await fail(SavedGroupService.use((s) => s.create({ key: "beta", name: "x", description: "", type: "list", conditions: [], attribute: "id", values: ["a"] }, actor)))).message).toContain("already exists");
    const nested = await fail(
      SavedGroupService.use((s) => s.create({ key: "nested", name: "Nested", description: "", type: "condition", conditions: [inGroup("x")], attribute: "", values: [] }, actor)),
    );
    expect(nested.message).toBe("A saved group cannot target another saved group");
    const noCondition = await fail(SavedGroupService.use((s) => s.create({ key: "c", name: "C", description: "", type: "condition", conditions: [], attribute: "", values: [] }, actor)));
    expect(noCondition._tag).toBe("ValidationError");
    const noAttribute = await fail(SavedGroupService.use((s) => s.create({ key: "l", name: "L", description: "", type: "list", conditions: [], attribute: " ", values: ["a"] }, actor)));
    expect(noAttribute._tag).toBe("ValidationError");
    const tooMany = await fail(createList("huge", Array.from({ length: 10_001 }, (_, i) => `u${i}`)));
    expect(tooMany.message).toContain("at most 10,000");
  });

  it("rejects flag rules and experiments that target a missing group", async () => {
    const flag = await enabledFlag("missing-group-flag");
    const rules = [ForceRule.make({ id: "r", description: "", enabled: true, conditions: [inGroup("nope")], value: '"x"' })];
    const error = await fail(FeatureService.use((s) => s.saveRules({ id: flag.id, environmentId: PROD, rules }, actor)));
    expect(error).toMatchObject({ _tag: "ValidationError", message: "Rule 1: a saved group it targets no longer exists" });
    const experiment = await fail(ExperimentService.use((s) => s.create({ key: "missing-group", ...draft(flag.id, { conditions: [inGroup("nope")] }) }, actor)));
    expect(experiment).toMatchObject({ _tag: "ValidationError", message: "Targeting: a saved group it targets no longer exists" });
  });

  it("ships only referenced groups in the payload, republishes on update, and blocks deleting a referenced group", async () => {
    const used = await listGroup("vip", ["alice"]);
    const unused = await listGroup("unused", ["bob"]);
    const flag = await enabledFlag("vip-banner");
    const rules = [ForceRule.make({ id: "r", description: "", enabled: true, conditions: [inGroup(used.id, "not_in_group")], value: '"vip"' })];
    await run(FeatureService.use((s) => s.saveRules({ id: flag.id, environmentId: PROD, rules }, actor)));
    expect(payload().savedGroups).toEqual({ [used.id]: { type: "list", attribute: "id", values: ["alice"] } });

    await run(SavedGroupService.use((s) => s.update({ ...used, id: used.id, values: ["alice", "carol"] }, actor)));
    expect(payload().savedGroups?.[used.id]).toEqual({ type: "list", attribute: "id", values: ["alice", "carol"] });

    const conflict = await fail(SavedGroupService.use((s) => s.delete(used.id, actor)));
    expect(conflict).toMatchObject({ _tag: "ConflictError" });
    expect(conflict.message).toContain('"vip-banner"');
    await run(SavedGroupService.use((s) => s.delete(unused.id, actor)));
    expect((await run(SavedGroupService.use((s) => s.list))).map((g) => g.key)).not.toContain("unused");
  });
});

describe("namespaces", () => {
  it("runs experiments only in free slices, ships the namespace tuple and dimensions, and blocks deleting a used namespace", async () => {
    const ns = await run(NamespaceService.use((s) => s.create({ key: "checkout", name: "Checkout", description: "" }, actor)));
    const slice = (start: number, end: number) => NamespaceAllocation.make({ namespaceId: ns.id, start, end });
    const flag = await enabledFlag("ns-flag");
    const create = (key: string, start: number, end: number, extra: Partial<ExperimentDraft> = {}) =>
      run(ExperimentService.use((s) => s.create({ key, ...draft(flag.id, { name: key, namespace: slice(start, end), ...extra }) }, actor)));

    const a = await create("ns-a", 0, 0.5, { dimensions: ["country"] });
    const b = await create("ns-b", 0.4, 0.8);
    const c = await create("ns-c", 0.5, 1);
    await run(ExperimentService.use((s) => s.start(a.id, actor)));

    const overlap = await fail(ExperimentService.use((s) => s.start(b.id, actor)));
    expect(overlap._tag).toBe("ValidationError");
    expect(overlap.message).toContain('"ns-a"');
    await run(ExperimentService.use((s) => s.start(c.id, actor)));

    const rule = payload().features["ns-flag"]!.rules.find((r): r is ExperimentPayloadRule => r.type === "experiment" && r.key === "ns-a");
    expect(rule?.namespace).toEqual(["checkout", 0, 0.5]);
    expect(rule?.dimensions).toEqual(["country"]);

    const [listed] = await run(NamespaceService.use((s) => s.list));
    expect(listed?.allocations.map((x) => [x.experimentName, x.status, x.start, x.end])).toEqual([
      ["ns-a", "running", 0, 0.5],
      ["ns-b", "draft", 0.4, 0.8],
      ["ns-c", "running", 0.5, 1],
    ]);
    expect((await fail(NamespaceService.use((s) => s.delete(ns.id, actor))))._tag).toBe("ConflictError");
  });

  it("locks the namespace once started and rejects missing namespaces and empty ranges", async () => {
    const ns = await run(NamespaceService.use((s) => s.create({ key: "search", name: "Search", description: "" }, actor)));
    const flag = await enabledFlag("lock-flag");
    const allocation = NamespaceAllocation.make({ namespaceId: ns.id, start: 0, end: 0.2 });
    const started = await run(
      ExperimentService.use((s) =>
        s.create({ key: "locked", ...draft(flag.id, { namespace: allocation }) }, actor).pipe(Effect.flatMap((x) => s.start(x.id, actor))),
      ),
    );
    const moved = await fail(
      ExperimentService.use((s) => s.update({ id: started.id, ...draft(flag.id, { namespace: NamespaceAllocation.make({ namespaceId: ns.id, start: 0.2, end: 0.4 }) }) }, actor)),
    );
    expect(moved.message).toContain("namespace");

    const missing = await fail(
      ExperimentService.use((s) => s.create({ key: "ghost", ...draft(flag.id, { namespace: NamespaceAllocation.make({ namespaceId: "nope", start: 0, end: 1 }) }) }, actor)),
    );
    expect(missing.message).toBe("The selected namespace no longer exists");
    const empty = await fail(
      ExperimentService.use((s) => s.create({ key: "empty", ...draft(flag.id, { namespace: NamespaceAllocation.make({ namespaceId: ns.id, start: 0.5, end: 0.5 }) }) }, actor)),
    );
    expect(empty._tag).toBe("ValidationError");
  });
});
