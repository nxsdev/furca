import { afterAll, describe, expect, it } from "bun:test";
import { ORPCError } from "@orpc/client";
import { i18n } from "~/i18n";
import { errorField, errorMessage } from "./rpc";

const coded = (code: string, params?: Record<string, string | number>, field?: string) =>
  new ORPCError("BAD_REQUEST", { message: "English from the server", data: { code, params, field } });

afterAll(() => i18n.changeLanguage("en"));

describe("errorMessage", () => {
  it("translates a coded server error with its params into the current language", async () => {
    await i18n.changeLanguage("ja");
    expect(errorMessage(coded("flag.keyTaken", { key: "beta-banner" }, "key"))).toBe("キー「beta-banner」のフラグはすでに存在します");
    await i18n.changeLanguage("en");
    expect(errorMessage(coded("flag.keyTaken", { key: "beta-banner" }))).toBe('A flag with key "beta-banner" already exists');
  });

  it("translates a reason param, which is itself a code, in place", async () => {
    await i18n.changeLanguage("ja");
    expect(errorMessage(coded("rule.valueInvalid", { rule: 2, reason: "value.expectedNumber" }))).toBe("ルール 2: 数値を指定してください");
  });

  it("falls back to the server's message for an unknown code or no code", async () => {
    await i18n.changeLanguage("ja");
    expect(errorMessage(coded("flag.somethingNewer"))).toBe("English from the server");
    expect(errorMessage(new ORPCError("CONFLICT", { message: "Plain message" }))).toBe("Plain message");
  });

  it("reads the field a coded error belongs to", () => {
    expect(errorField(coded("flag.keyTaken", { key: "x" }, "key"))).toBe("key");
    expect(errorField(new ORPCError("CONFLICT", { message: "Plain message" }))).toBeUndefined();
  });
});
