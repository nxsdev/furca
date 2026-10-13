import { type FeatureValueType, validateFeatureValue } from "@furca/core/features/Feature";
import { Button, Description, FieldError, Input, Label, TextField, toast } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ORPCError } from "@orpc/client";
import { useState } from "react";
import { TagInput } from "~/components/targeting/ConditionBuilder";
import { Panel, PanelHeader } from "~/components/ui/primitives";
import { client, errorMessage, orpc } from "~/lib/rpc";
import { Segmented } from "./Segmented";
import { defaultValueFor, ValueInput } from "./ValueInput";

const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Turns whatever is typed into a valid key: "New Checkout!" → "new-checkout" */
const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 64);

export const valueTypeOptions: ReadonlyArray<{ id: FeatureValueType; label: string }> = [
  { id: "boolean", label: "Boolean" },
  { id: "string", label: "String" },
  { id: "number", label: "Number" },
  { id: "json", label: "JSON" },
];

/** Inline "Create flag" panel on /flags. Goes to the new flag's page on success */
export function CreateFlagForm({ onCancel }: { onCancel: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const [valueType, setValueType] = useState<FeatureValueType>("boolean");
  const [defaultValue, setDefaultValue] = useState(defaultValueFor("boolean"));
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => client.features.create({ key, description: description.trim(), valueType, defaultValue, tags }),
    onSuccess: async (feature) => {
      await queryClient.invalidateQueries({ queryKey: orpc.features.key() });
      toast.success(`Created ${feature.key}`);
      await navigate({ to: "/flags/$featureId", params: { featureId: feature.id } });
    },
    onError: (error) => {
      // "A flag with key … already exists" belongs under the key field
      if (error instanceof ORPCError && /\bkey\b/i.test(error.message)) setKeyError(error.message);
      else setFormError(errorMessage(error));
    },
  });

  const valueError = validateFeatureValue(valueType, defaultValue);
  const keyInvalid = key !== "" && !KEY.test(key);

  return (
    <Panel className="mb-6">
      <PanelHeader title="Create flag" description="Pick a key you'll reference in code, its type, and the value served when no rule matches." />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setFormError(null);
          if (key === "") return setKeyError("Enter a key");
          if (keyInvalid || valueError !== null) return;
          create.mutate();
        }}
      >
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          <TextField
            value={key}
            onChange={(v) => {
              setKey(slugify(v));
              setKeyError(null);
            }}
            isInvalid={keyError !== null || keyInvalid}
            autoFocus
          >
            <Label>Key</Label>
            <Input className="font-mono text-base sm:text-label" placeholder="new-checkout" autoComplete="off" spellCheck={false} />
            {keyError !== null || keyInvalid ? (
              <FieldError>{keyError ?? "Use lowercase letters, digits, - and _ (max 64)"}</FieldError>
            ) : (
              <Description>Lowercase, digits, - and _. Can't be changed later.</Description>
            )}
          </TextField>
          <div className="flex flex-col gap-1.5">
            <Label>Type</Label>
            <Segmented
              aria-label="Type"
              value={valueType}
              onChange={(t) => {
                setValueType(t);
                setDefaultValue(defaultValueFor(t));
              }}
              options={valueTypeOptions}
              className="w-fit"
            />
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <ValueInput valueType={valueType} value={defaultValue} onChange={setDefaultValue} label="Default value" />
            <p className="text-meta text-muted">Served when the flag is on and no rule matches.</p>
          </div>
          <TextField value={description} onChange={setDescription} className="sm:col-span-2">
            <Label>
              Description <span className="font-normal text-muted">(optional)</span>
            </Label>
            <Input placeholder="What does this flag control?" />
          </TextField>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label>
              Tags <span className="font-normal text-muted">(optional)</span>
            </Label>
            <TagInput aria-label="Tags" values={tags} onChange={setTags} placeholder="checkout, growth" />
          </div>
        </div>
        {formError !== null && (
          <p role="alert" className="mx-5 mb-4 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-label text-danger">
            {formError}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button size="sm" variant="tertiary" onPress={onCancel}>
            Cancel
          </Button>
          <Button size="sm" type="submit" isPending={create.isPending} isDisabled={keyInvalid || valueError !== null}>
            Create flag
          </Button>
        </div>
      </form>
    </Panel>
  );
}
