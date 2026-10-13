import type { Environment } from "@furca/core/environments/Environment";
import type { Feature } from "@furca/core/features/Feature";
import { toast } from "@heroui/react";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { client, errorMessage, orpc } from "~/lib/rpc";

const withEnabled = (feature: Feature, environmentId: string, enabled: boolean): Feature => {
  const has = feature.environments.some((e) => e.environmentId === environmentId);
  const environments = has
    ? feature.environments.map((e) => (e.environmentId === environmentId ? { ...e, enabled } : e))
    : [...feature.environments, { environmentId, enabled, rules: [] }];
  return { ...feature, environments } as Feature;
};

/** Puts a server copy of a feature into every cached list / detail query */
export const cacheFeature = (queryClient: QueryClient, feature: Feature) => {
  queryClient.setQueriesData<ReadonlyArray<Feature>>({ queryKey: orpc.features.list.key() }, (old) =>
    old?.map((f) => (f.id === feature.id ? feature : f)),
  );
  queryClient.setQueryData(orpc.features.get.queryKey({ input: { id: feature.id } }), feature);
};

/**
 * Per-environment kill switch with an optimistic update and an Undo toast. Shared by the flags
 * table and the flag detail page
 */
export function useSetEnabled() {
  const { t } = useTranslation("flags");
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (v: { feature: Feature; environment: Environment; enabled: boolean; isUndo?: boolean }) =>
      client.features.setEnabled({ id: v.feature.id, environmentId: v.environment.id, enabled: v.enabled }),
    onMutate: async ({ feature, environment, enabled }) => {
      await queryClient.cancelQueries({ queryKey: orpc.features.key() });
      const snapshot = queryClient.getQueriesData({ queryKey: orpc.features.key() });
      cacheFeature(queryClient, withEnabled(feature, environment.id, enabled));
      return { snapshot };
    },
    onError: (error, { feature, environment, enabled }, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
      const vars = { key: feature.key, environment: environment.name };
      toast.danger(enabled ? t("toggle.turnOnFailed", vars) : t("toggle.turnOffFailed", vars), {
        description: errorMessage(error),
      });
    },
    onSuccess: (saved, { feature, environment, enabled, isUndo }) => {
      cacheFeature(queryClient, saved);
      void queryClient.invalidateQueries({ queryKey: orpc.environments.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
      if (isUndo === true) return;
      const vars = { key: feature.key, environment: environment.name };
      const id = toast(enabled ? t("toggle.turnedOn", vars) : t("toggle.turnedOff", vars), {
        description: enabled ? t("toggle.turnedOnDescription") : t("toggle.turnedOffDescription"),
        actionProps: {
          children: t("toggle.undo"),
          variant: "tertiary",
          onPress: () => {
            toast.close(id);
            mutation.mutate({ feature: saved, environment, enabled: !enabled, isUndo: true });
          },
        },
      });
    },
  });
  return mutation;
}
