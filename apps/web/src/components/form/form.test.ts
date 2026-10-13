import { describe, expect, it } from "bun:test";
import { type AnyFormApi, FieldApi, FormApi } from "@tanstack/react-form";
import { setServerError } from "./form";

const makeForm = () => {
  let submissions = 0;
  const form = new FormApi({
    defaultValues: { key: "checkout" },
    onSubmit: () => {
      submissions += 1;
    },
  });
  form.mount();
  const key = new FieldApi({ form, name: "key" });
  key.mount();
  // A bare FormApi infers TSubmitMeta = never, which AnyFormApi's listener types reject; app forms come from useAppForm
  return { form: form as unknown as AnyFormApi, key, submissions: () => submissions };
};

describe("setServerError", () => {
  it("shows a form-level server error and still lets the user submit again", async () => {
    const { form, submissions } = makeForm();
    await form.handleSubmit();
    setServerError(form, "Could not reach the server");
    expect(form.state.errorMap.onServer).toBe("Could not reach the server");

    await form.handleSubmit();
    expect(submissions()).toBe(2);
    expect(form.state.errorMap.onServer).toBeUndefined();
  });

  it("keeps a field server error (e.g. duplicate key) until the user edits that field, then submits", async () => {
    const { form, key, submissions } = makeForm();
    setServerError(form, 'A flag with key "checkout" already exists', "key");
    expect(key.state.meta.errors as ReadonlyArray<unknown>).toEqual(['A flag with key "checkout" already exists']);

    // Resubmitting the same duplicate key would fail again on the server
    await form.handleSubmit();
    expect(submissions()).toBe(0);

    key.handleChange("checkout-v2");
    expect(key.state.meta.errors as ReadonlyArray<unknown>).toEqual([]);
    await form.handleSubmit();
    expect(submissions()).toBe(1);
  });
});
