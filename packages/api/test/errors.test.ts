import { describe, expect, it } from "bun:test";
import { ConflictError, ForbiddenError, issue, NotFoundError, ValidationError } from "@furca/core/shared/errors";
import { toORPCError } from "../src/Runtime/orpc";

describe("toORPCError", () => {
  it("keeps the English message and carries the code, params and field as data", () => {
    const error = toORPCError(new ValidationError(issue("flag.keyTaken", { key: "beta-banner" }, "key")));
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe('A flag with key "beta-banner" already exists');
    expect(error.data).toEqual({ code: "flag.keyTaken", params: { key: "beta-banner" }, field: "key" });
  });

  it("codes every mapped error type, NOT_FOUND by its entity", () => {
    expect(toORPCError(new NotFoundError({ entity: "dataSource", id: "x" }))).toMatchObject({
      code: "NOT_FOUND",
      message: "Data source not found",
      data: { code: "notFound.dataSource" },
    });
    expect(toORPCError(new ConflictError(issue("environment.last")))).toMatchObject({ code: "CONFLICT", data: { code: "environment.last" } });
    expect(toORPCError(new ForbiddenError(issue("review.required", { environment: "Production" })))).toMatchObject({
      code: "FORBIDDEN",
      message: "Production requires a review",
      data: { code: "review.required", params: { environment: "Production" } },
    });
  });

  it("spells out a reason param, which is itself a code, in the English message", () => {
    const error = toORPCError(new ValidationError(issue("rule.valueInvalid", { rule: 2, reason: "value.expectedNumber" })));
    expect(error.message).toBe("Rule 2: Expected a number");
    expect(error.data).toMatchObject({ code: "rule.valueInvalid", params: { rule: 2, reason: "value.expectedNumber" } });
  });

  it("sends an error raised without a code with its message and no data", () => {
    const error = toORPCError(new ValidationError({ message: "Provider said no" }));
    expect([error.code, error.message, error.data]).toEqual(["BAD_REQUEST", "Provider said no", undefined]);
  });
});
