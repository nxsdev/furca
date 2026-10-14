import { describe, expect, it } from "bun:test";
import { errorCodes } from "@furca/core/shared/errors";
import { resources } from "./index";

type Tree = { readonly [key: string]: string | Tree };

const flatten = (tree: Tree, prefix = ""): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tree).flatMap(([k, v]) =>
      typeof v === "string" ? [[`${prefix}${k}`, v]] : Object.entries(flatten(v, `${prefix}${k}.`)),
    ),
  );

/** Japanese has no singular form, so en `x_one` / `x_other` both map to ja `x_other` */
const base = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, "");

describe("locales", () => {
  for (const ns of Object.keys(resources.en) as Array<keyof typeof resources.en>) {
    it(`ja/${ns} translates every en/${ns} key, with the same placeholders and nothing extra`, () => {
      const en = flatten(resources.en[ns] as Tree);
      const ja = flatten(resources.ja[ns] as Tree);
      const jaBases = new Set(Object.keys(ja).map(base));
      const enBases = new Set(Object.keys(en).map(base));
      expect([...enBases].filter((k) => !jaBases.has(k))).toEqual([]);
      expect([...jaBases].filter((k) => !enBases.has(k))).toEqual([]);
      for (const [key, value] of Object.entries(ja)) {
        expect(value.trim().length > 0).toBe(true);
        const enValue = en[key] ?? en[`${base(key)}_other`] ?? en[base(key)] ?? "";
        const vars = (s: string) => [...s.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();
        expect({ key, vars: vars(value) }).toEqual({ key, vars: vars(enValue) });
      }
    });
  }
});

describe("server error codes", () => {
  it("every code the server can send has English and Japanese text in the errors namespace", () => {
    const en = flatten(resources.en.errors as Tree);
    const ja = flatten(resources.ja.errors as Tree);
    expect(errorCodes.filter((code) => en[code] === undefined || ja[code] === undefined)).toEqual([]);
  });
});
