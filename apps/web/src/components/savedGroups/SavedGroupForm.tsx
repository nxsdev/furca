import { Button, Description, FieldError, Label, TextArea, TextField } from "@heroui/react";
import { Key } from "@furca/api/contract";
import type { SavedGroup, SavedGroupType } from "@furca/core/targeting/SavedGroup";
import { useStore } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { errorText, setServerError, submitHandler, useAppForm } from "~/components/form/form";
import { suggestKey } from "~/components/metrics/slugify";
import { formatCount } from "~/components/results/format";
import { ConditionBuilder, type ConditionValue, conditionIssue } from "~/components/targeting/ConditionBuilder";
import { Segmented } from "~/components/ui/Segmented";
import { i18n } from "~/i18n";
import { client, orpc } from "~/lib/rpc";
import { MAX_LIST_VALUES, parseIds } from "./usage";

interface Values {
  name: string;
  key: string;
  description: string;
  type: SavedGroupType;
  attribute: string;
  /** Pasted IDs, one per line */
  ids: string;
  conditions: ReadonlyArray<ConditionValue>;
}

const toValues = (g: SavedGroup | undefined): Values => ({
  name: g?.name ?? "",
  key: g?.key ?? "",
  description: g?.description ?? "",
  type: g?.type ?? "list",
  attribute: g?.type === "list" ? g.attribute : "id",
  ids: g?.values.join("\n") ?? "",
  conditions: g?.conditions ?? [],
});

const toInput = (v: Values) => ({
  name: v.name.trim(),
  description: v.description.trim(),
  type: v.type,
  attribute: v.type === "list" ? v.attribute.trim() : "",
  values: v.type === "list" ? parseIds(v.ids).values : [],
  conditions: v.type === "condition" ? v.conditions.map((c) => ({ ...c, values: [...c.values] })) : [],
});

const isKey = Schema.is(Key);

/** Field -> message for everything that blocks saving */
const validate = (v: Values, isEdit: boolean): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v.name.trim() === "") out.name = i18n.t(($) => $.form.required, { ns: "common" });
  // An empty name already has its error; the key follows the name
  if (!isEdit && v.name.trim() !== "" && !isKey(v.key)) out.key = v.key === "" ? i18n.t(($) => $.form.required, { ns: "common" }) : i18n.t(($) => $.form.keyInvalid, { ns: "savedGroups" });
  if (v.type === "list") {
    if (v.attribute.trim() === "") out.attribute = i18n.t(($) => $.form.required, { ns: "common" });
    const { values } = parseIds(v.ids);
    if (values.length === 0) out.ids = i18n.t(($) => $.form.idsRequired, { ns: "savedGroups" });
    else if (values.length > MAX_LIST_VALUES) out.ids = i18n.t(($) => $.form.idsTooMany, { ns: "savedGroups", max: formatCount(MAX_LIST_VALUES) });
  } else {
    const issue = v.conditions.length === 0 ? i18n.t(($) => $.form.conditionsRequired, { ns: "savedGroups" }) : v.conditions.map(conditionIssue).find((m) => m !== null);
    if (issue != null) out.conditions = issue;
  }
  return out;
};

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 border-b border-border px-5 py-5">
      <div>
        <h3 className="text-body font-medium">{title}</h3>
        {description !== undefined && <p className="mt-0.5 text-label text-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** Create or edit a saved group: an ID list (pasted) or AND-ed conditions */
export function SavedGroupForm({
  group,
  onSaved,
  onCancel,
}: {
  group?: SavedGroup;
  onSaved: (group: SavedGroup) => void;
  /** Create only; editing offers Discard instead */
  onCancel?: () => void;
}) {
  const { t } = useTranslation(["savedGroups", "common"]);
  const queryClient = useQueryClient();
  const isEdit = group !== undefined;
  const form = useAppForm({
    defaultValues: toValues(group),
    validators: {
      onChange: ({ value }) => {
        const fields = validate(value, isEdit);
        return Object.keys(fields).length > 0 ? { fields } : undefined;
      },
      // Clears the last server error on the next submit, so an unchanged form can be retried
      onSubmit: () => undefined,
    },
    onSubmit: async ({ value, formApi }) => {
      let saved: SavedGroup;
      try {
        saved = isEdit
          ? await client.savedGroups.update({ id: group.id, ...toInput(value) })
          : await client.savedGroups.create({ key: value.key, ...toInput(value) });
      } catch (error) {
        setServerError(formApi, error);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: orpc.savedGroups.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
      if (isEdit) formApi.reset(toValues(saved));
      onSaved(saved);
    },
  });
  const d = useStore(form.store, (s) => s.values);
  const attempted = useStore(form.store, (s) => s.submissionAttempts > 0);
  const parsed = parseIds(d.ids);

  return (
    <form noValidate onSubmit={submitHandler(form)} className="min-w-0 rounded-[10px] border border-border bg-surface">
      <Section title={t(($) => $.form.basics)}>
        <div className="flex flex-col gap-3">
          <form.AppField
            name="name"
            listeners={{
              // The key follows the name until the user edits it
              onChange: ({ value }) => {
                if (!isEdit && form.getFieldMeta("key")?.isDirty !== true) form.setFieldValue("key", suggestKey(value, "group"), { dontUpdateMeta: true });
              },
            }}
          >
            {(field) => <field.TextField label={t(($) => $.form.name)} description={t(($) => $.form.nameHelp)} className="sm:max-w-md" />}
          </form.AppField>
          <form.AppField name="key">
            {(field) => (
              <field.KeyField
                label={t(($) => $.form.key)}
                description={isEdit ? t(($) => $.form.keyLocked) : t(($) => $.form.keyHelp)}
                isReadOnly={isEdit}
                className="sm:max-w-md"
              />
            )}
          </form.AppField>
        </div>
        <form.AppField name="description">
          {(field) => (
            <field.TextAreaField
              label={
                <>
                  {t(($) => $.form.description)} <span className="font-normal text-muted">{t(($) => $.form.optional)}</span>
                </>
              }
              description={t(($) => $.form.descriptionHelp)}
              rows={2}
            />
          )}
        </form.AppField>
      </Section>

      <Section title={t(($) => $.form.members)}>
        <form.AppField name="type">
          {(field) => (
            <Segmented
              label={t(($) => $.form.type)}
              value={field.state.value}
              onChange={field.handleChange}
              options={[
                { value: "list", label: t(($) => $.type.list), description: t(($) => $.form.typeList) },
                { value: "condition", label: t(($) => $.type.condition), description: t(($) => $.form.typeCondition) },
              ]}
            />
          )}
        </form.AppField>
        {d.type === "list" ? (
          <>
            <form.AppField name="attribute">
              {(field) => <field.TextField label={t(($) => $.form.attribute)} description={t(($) => $.form.attributeHelp)} mono className="sm:max-w-xs" />}
            </form.AppField>
            <form.AppField name="ids">
              {(field) => {
                const error = field.state.meta.isBlurred || attempted ? errorText(field.state.meta.errors) : "";
                return (
                  <TextField value={field.state.value} onChange={field.handleChange} onBlur={field.handleBlur} isInvalid={error !== ""}>
                    <Label>{t(($) => $.form.ids)}</Label>
                    <TextArea
                      rows={8}
                      spellCheck={false}
                      autoCorrect="off"
                      autoCapitalize="off"
                      className="resize-y font-mono text-label leading-5"
                    />
                    <Description>
                      <span className="block text-foreground tabular" aria-live="polite">
                        {t(($) => $.form.idsCount, { count: parsed.values.length, formatted: formatCount(parsed.values.length) })}
                        {parsed.duplicates > 0 && ` · ${t(($) => $.form.duplicates, { count: parsed.duplicates, formatted: formatCount(parsed.duplicates) })}`}
                      </span>
                      <span className="block">{t(($) => $.form.idsHelp, { max: formatCount(MAX_LIST_VALUES) })}</span>
                    </Description>
                    <FieldError>{error}</FieldError>
                  </TextField>
                );
              }}
            </form.AppField>
          </>
        ) : (
          <form.AppField name="conditions">
            {(field) => (
              <div className="flex flex-col gap-2">
                <p className="text-label font-medium">{t(($) => $.form.conditions)}</p>
                <ConditionBuilder value={field.state.value} onChange={field.handleChange} allowGroups={false} />
                {attempted && field.state.meta.errors.length > 0 && <p className="text-meta text-danger">{errorText(field.state.meta.errors)}</p>}
              </div>
            )}
          </form.AppField>
        )}
      </Section>

      <div className="flex flex-col gap-3 px-5 py-4">
        <form.AppForm>
          <form.FormError />
        </form.AppForm>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {isEdit && <p className="text-meta text-muted sm:mr-auto">{t(($) => $.form.liveNote)}</p>}
          <Button size="sm" variant="tertiary" onPress={() => (isEdit ? form.reset() : onCancel?.())}>
            {isEdit ? t(($) => $.actions.discard, { ns: "common" }) : t(($) => $.actions.cancel, { ns: "common" })}
          </Button>
          <form.AppForm>
            <form.SubmitButton label={isEdit ? t(($) => $.form.save) : t(($) => $.form.create)} size="sm" />
          </form.AppForm>
        </div>
      </div>
    </form>
  );
}
