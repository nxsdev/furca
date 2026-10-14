import { Key } from "@furca/api/contract";
import type { FeatureValueType } from "@furca/core/features/Feature";
import { Button, Disclosure, Label, toast } from "@heroui/react";
import { ORPCError } from "@orpc/client";
import { useStore } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { matches, setServerError, submitHandler, useAppForm } from "~/components/form/form";
import { slugify } from "~/components/metrics/slugify";
import { TagInput } from "~/components/targeting/ConditionBuilder";
import { client, orpc } from "~/lib/rpc";
import { Segmented } from "./Segmented";
import { defaultValueFor, ValueInput, valueIssue } from "./ValueInput";

/** Keeps a typed key valid while typing: "New Checkout!" → "new-checkout" */
const formatKey = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 64);

/** Labels live under `flags:valueTypes` */
export const valueTypes: ReadonlyArray<FeatureValueType> = ["boolean", "string", "number", "json"];

/**
 * "Create flag" page on /flags?new=1. Asks for a name (the key follows it) and the type; the
 * default value and tags have safe defaults behind "Advanced". Goes to the new flag on success
 */
export function CreateFlagForm({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation(["flags", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const validKey = matches(Key, () => t("create.keyInvalid"));
  const form = useAppForm({
    defaultValues: {
      name: "",
      key: "",
      valueType: "boolean" as FeatureValueType,
      defaultValue: defaultValueFor("boolean"),
      tags: [] as string[],
    },
    onSubmitInvalid: ({ value }) => {
      if (valueIssue(value.valueType, value.defaultValue) !== null) setOptionsOpen(true);
    },
    onSubmit: async ({ value, formApi }) => {
      const name = value.name.trim();
      // ponytail: flags have no name column; the name is their description (shown under the key everywhere)
      const description = name === value.key ? "" : name;
      const feature = await client.features
        .create({ key: value.key, valueType: value.valueType, defaultValue: value.defaultValue, tags: value.tags, description })
        .catch((error: unknown) => {
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
  const { name, valueType, defaultValue, tags } = useStore(form.store, (s) => s.values);
  // Keys appear in code: a name with no ASCII spelling (Japanese…) asks for the key instead of inventing one
  const typesKey = name.trim() !== "" && slugify(name) === "";

  return (
    <form noValidate onSubmit={submitHandler(form)} className="rounded-[10px] border border-border bg-surface">
      <div className="flex flex-col gap-5 p-5">
        <form.AppField
          name="name"
          listeners={{
            onChange: ({ value }) => {
              if (form.getFieldMeta("key")?.isDirty !== true) form.setFieldValue("key", slugify(value), { dontUpdateMeta: true });
            },
          }}
        >
          {(field) => (
            <field.TextField
              label={
                <>
                  {t("create.name")} <span className="font-normal text-muted">{t("shared.optional")}</span>
                </>
              }
              description={t("create.nameHelp")}
              className="sm:max-w-md"
            />
          )}
        </form.AppField>
        <form.AppField name="key" validators={{ onChange: ({ value }) => (value === "" ? t("create.enterKey") : validKey({ value })) }}>
          {(field) => (
            <field.KeyField
              label={t("shared.key")}
              description={typesKey ? t("create.keyHintTyped") : t("create.keyHelp")}
              expanded={typesKey}
              format={formatKey}
              className="sm:max-w-md"
            />
          )}
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
              <p className="text-meta text-muted">{t("create.typeHelp")}</p>
            </div>
          )}
        </form.AppField>
      </div>

      <Disclosure isExpanded={optionsOpen} onExpandedChange={setOptionsOpen} className="border-t border-border">
        <Disclosure.Heading>
          <Disclosure.Trigger className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left">
            <span className="min-w-0">
              <span className="block text-body font-medium">{t("create.options")}</span>
              <span className="block text-label font-normal text-muted">
                {[
                  t("create.defaultValueSummary", { value: defaultValue }),
                  t("create.offEverywhere"),
                  tags.length === 0 ? t("create.noTags") : t("create.tagCount", { count: tags.length }),
                ].join(" · ")}
              </span>
            </span>
            <Disclosure.Indicator />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="flex flex-col gap-5 border-t border-border px-5 py-5">
            <p className="text-label text-muted">{t("create.optionsWhy")}</p>
            {/* ValueInput shows its own validation message; the validator only blocks submit */}
            <form.AppField
              name="defaultValue"
              validators={{ onChange: ({ value, fieldApi }) => valueIssue(fieldApi.form.getFieldValue("valueType"), value) ?? undefined }}
            >
              {(field) => (
                <div className="flex flex-col gap-1">
                  <ValueInput valueType={valueType} value={field.state.value} onChange={field.handleChange} label={t("shared.defaultValue")} />
                  <p className="text-meta text-muted">{t("create.defaultValueHelp")}</p>
                </div>
              )}
            </form.AppField>
            <form.AppField name="tags">
              {(field) => (
                <div className="flex flex-col gap-1.5">
                  <Label>{t("shared.tags")}</Label>
                  <TagInput aria-label={t("shared.tags")} values={field.state.value} onChange={field.handleChange} placeholder="checkout, growth" />
                </div>
              )}
            </form.AppField>
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>

      <form.AppForm>
        <form.FormError className="mx-5 mb-4" />
        <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
          <Button size="sm" variant="tertiary" onPress={onCancel}>
            {t("common:actions.cancel")}
          </Button>
          <form.SubmitButton size="sm" label={t("shared.createFlag")} />
        </div>
      </form.AppForm>
    </form>
  );
}
