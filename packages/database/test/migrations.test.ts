import { afterAll, describe, expect, it } from "bun:test";
import { makeDrizzle } from "../src/Database";
import { makeTestD1 } from "../src/testing/TestDatabase";

const t = await makeTestD1();
afterAll(() => t.dispose());

describe("migrations", () => {
  it("seeds production / development environments with distinct SDK keys and the builtin source", async () => {
    const db = makeDrizzle(t.d1);
    const envs = await db.query.environments.findMany({ orderBy: { sortOrder: "asc" } });
    expect(envs.map((e) => e.key)).toEqual(["production", "development"]);
    expect(envs[0]!.sdkKey).toMatch(/^sdk-[0-9a-f]{24}$/);
    expect(envs[0]!.sdkKey).not.toBe(envs[1]!.sdkKey);
    const sources = await db.query.dataSources.findMany();
    expect(sources.map((s) => s.id)).toEqual(["builtin"]);
  });
});
