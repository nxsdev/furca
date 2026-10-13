import { expect, it } from "bun:test";
import { slugify } from "./slugify";

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
