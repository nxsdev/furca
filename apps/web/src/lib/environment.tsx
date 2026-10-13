import type { Environment } from "@kuji/core/environments/Environment";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { orpc } from "./rpc";

const STORAGE_KEY = "kuji-environment";

interface EnvironmentState {
  readonly environments: ReadonlyArray<Environment>;
  /** Selected environment (production until the user switches) */
  readonly current: Environment | null;
  readonly select: (id: string) => void;
  readonly isLoading: boolean;
}

const EnvironmentContext = createContext<EnvironmentState | null>(null);

const readStored = () => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

/** Global environment switcher state shared by the sidebar and every flag / experiment page */
export function EnvironmentProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery(orpc.environments.list.queryOptions());
  const [selectedId, setSelectedId] = useState<string | null>(readStored);
  const environments = useMemo(() => (data ?? []).map((item) => item.environment), [data]);
  const current = environments.find((e) => e.id === selectedId) ?? environments[0] ?? null;
  const select = useCallback((id: string) => {
    setSelectedId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // private mode: selection just isn't remembered
    }
  }, []);
  const value = useMemo(() => ({ environments, current, select, isLoading }), [environments, current, select, isLoading]);
  return <EnvironmentContext.Provider value={value}>{children}</EnvironmentContext.Provider>;
}

export const useEnvironment = (): EnvironmentState => {
  const state = useContext(EnvironmentContext);
  if (state === null) throw new Error("useEnvironment must be used inside EnvironmentProvider");
  return state;
};
