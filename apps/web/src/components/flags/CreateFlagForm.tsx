import { Key } from "@furca/api/contract";
import type { FeatureValueType } from "@furca/core/features/Feature";
import { Button, Description, FieldError, Input, Label, TextField, toast } from "@heroui/react";
import { ORPCError } from "@orpc/client";
import { useStore } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { errorText, matches, setServerError, submitHandler, useAppForm } from "~/components/form/form";
import { TagInput } from "~/components/targeting/ConditionBuilder";
import { Panel, PanelHeader } from "~/components/ui/primitives";
import { client, orpc } from "~/lib/rpc";
import { Segmented } from "./Segmented";
import { defaultValueFor, ValueInput, valueIssue } from "./ValueInput";

/** Turns whatever is typed into a valid key: "New Checkout!" → "new-checkout" */
const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 64);

/** Labels live under `flags:valueTypes` */
export const valueTypes: ReadonlyArray<FeatureValueType> = ["boolean", "string", "number", "json"];

/** Inline "Create flag" panel on /flags. Goes to the new flag's page on success */
export function CreateFlagForm({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation(["flags", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const validKey = matches(Key, () => t("create.keyInvalid"));
  const form = useAppForm({
    defaultValues: {
      key: "",
      valueType: "boolean" as FeatureValueType,
      defaultValue: defaultValueFor("boolean"),
      description: "",
      tags: [] as string[],
    },
    onSubmit: async ({ value, formApi }) => {
      const feature = await client.features.create({ ...value, description: value.description.trim() }).catch((error: unknown) => {
        // "A flag with key … already exists" belongs under the key field
        setServerError(formApi, error, error instanceof ORPCError && /\bkey\b/i.test(error.message) ? "key" : undefined);
        return null;
      });
      if (feature === null) return;
      await queryClient.invalidateQueries({ queryKey: orpc.features.key() });
      toast.success(t("create.created", { key: feature.key }));
      await navigate({ to: "/flags/$featureId", params: { featureId: feature.id } });
    },
  });
  const valueType = useStore(form.store, (s) => s.values.valueType);

  return (
    <Panel className="mb-6">
      <PanelHeader title={t("shared.createFlag")} description={t("create.description")} />
      <form noValidate onSubmit={submitHandler(form)}>
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          <form.AppField
            name="key"
            validators={{ onChange: ({ value }) => (value === "" ? t("create.enterKey") : validKey({ value })) }}
          >
            {(field) => {
              const shown = field.state.meta.isTouched || form.state.submissionAttempts > 0;
              const error = shown ? errorText(field.state.meta.errors) : "";
              return (
                <TextField
                  name={field.name}
                  value={field.state.value}
                  onChange={(v) => field.handleChange(slugify(v))}
                  onBlur={field.handleBlur}
                  isInvalid={error !== ""}
                  validationBehavior="aria"
                  autoFocus
                >
                  <Label>{t("shared.key")}</Label>
                  <Input className="font-mono text-base sm:text-label" placeholder="new-checkout" autoComplete="off" spellCheck={false} />
                  {error !== "" ? <FieldError>{error}</FieldError> : <Description>{t("create.keyHelp")}</Description>}
                </TextField>
              );
            }}
          </form.AppField>
          <form.AppField
            name="valueType"
            listeners={{ onChange: ({ value }) => form.setFieldValue("defaultValue", defaultValueFor(value)) }}
          >
            {(field) => (
              <div className="flex flex-col gap-1.5">
                <Label>{t("shared.type")}</Label>
                <Segmented
                  aria-label={t("shared.type")}
                  value={field.state.value}
                  onChange={field.handleChange}
                  options={valueTypes.map((id) => ({ id, label: t(`valueTypes.${id}`) }))}
                  className="w-fit"
                />
              </div>
            )}
          </form.AppField>
          {/* ValueInput shows its own validation message; the validator only blocks submit */}
          <form.AppField
            name="defaultValue"
            validators={{ onChange: ({ value, fieldApi }) => valueIssue(fieldApi.form.getFieldValue("valueType"), value) ?? undefined }}
          >
            {(field) => (
              <div className="flex flex-col gap-1 sm:col-span-2">
                <ValueInput valueType={valueType} value={field.state.value} onChange={field.handleChange} label={t("shared.defaultValue")} />
                <p className="text-meta text-muted">{t("create.defaultValueHelp")}</p>
              </div>
            )}
          </form.AppField>
          <form.AppField name="description">
            {(field) => (
              <field.TextField
                label={
                  <>
                    {t("shared.description")} <span className="font-normal text-muted">{t("shared.optional")}</span>
                  </>
                }
                placeholder={t("shared.descriptionPlaceholder")}
                className="sm:col-span-2"
              />
            )}
          </form.AppField>
          <form.AppField name="tags">
            {(field) => (
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label>
                  {t("shared.tags")} <span className="font-normal text-muted">{t("shared.optional")}</span>
                </Label>
                <TagInput aria-label={t("shared.tags")} values={field.state.value} onChange={field.handleChange} placeholder="checkout, growth" />
              </div>
            )}
          </form.AppField>
        </div>
        <form.AppForm>
          <form.FormError className="mx-5 mb-4" />
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            <Button size="sm" variant="tertiary" onPress={onCancel}>
              {t("common:actions.cancel")}
            </Button>
            <form.SubmitButton size="sm" label={t("shared.createFlag")} />
          </div>
        </form.AppForm>
      </form>
    </Panel>
  );
}
