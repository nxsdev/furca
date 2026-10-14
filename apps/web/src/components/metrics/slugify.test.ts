import { describe, expect, it } from "bun:test";
import { slugify, suggestKey } from "./slugify";

it("slugifies Latin names into valid keys", () => {
  expect(slugify("Checkout conversion")).toBe("checkout-conversion");
  expect(slugify("  Café — Revenue / user ")).toBe("cafe-revenue-user");
  expect(slugify("ＣＶＲ 2024")).toBe("cvr-2024");
  expect(slugify(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
});

it("returns empty for names it can't spell in ASCII", () => {
  expect(slugify("購入率")).toBe("");
  expect(slugify("購入 v2")).toBe("");
  expect(slugify("Конверсия")).toBe("");
  expect(slugify("---")).toBe("");
});

describe("suggestKey", () => {
  it("uses the slug when the name has one", () => {
    expect(suggestKey("Checkout redesign", "exp")).toBe("checkout-redesign");
  });

  it("falls back to a prefixed hash that is stable for the same Japanese name", () => {
    const a = suggestKey("新しいチェックアウト", "exp");
    expect(a).toMatch(/^exp-[a-z0-9]{6}$/);
    expect(suggestKey("新しいチェックアウト", "exp")).toBe(a);
    expect(suggestKey("購入率", "exp")).not.toBe(a);
  });

  it("returns an empty key for an empty name", () => {
    expect(suggestKey("  ", "exp")).toBe("");
  });
});
