import { Button, Label, ListBox, NumberField, Select } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import { formatList } from "~/components/results/format";
import { errorMessage, orpc } from "~/lib/rpc";
import { firstFreeSlice, overlaps, roundSlice } from "./allocation";
import { AllocationBar } from "./AllocationBar";

type Allocation = { readonly namespaceId: string; readonly start: number; readonly end: number };

const NONE = "none";

/** ExperimentForm's "Mutual exclusion" section: namespace + the slice of it this experiment takes */
export function NamespaceSlice({
  value,
  onChange,
  experimentId,
}: {
  value: Allocation | null;
  onChange: (next: Allocation | null) => void;
  /** The experiment being edited, left out of "other" allocations */
  experimentId: string | undefined;
}) {
  const { t } = useTranslation("namespaces");
  const list = useQuery(orpc.namespaces.list.queryOptions());
  const namespaces = list.data ?? [];
  const current = value === null ? undefined : namespaces.find((n) => n.namespace.id === value.namespaceId);
  const others = (id: string) => namespaces.find((n) => n.namespace.id === id)?.allocations.filter((a) => a.experimentId !== experimentId) ?? [];
  const taken = value === null ? [] : others(value.namespaceId);
  const rangeOk = value !== null && value.start >= 0 && value.start < value.end && value.end <= 1;
  const clashes = rangeOk ? taken.filter((a) => overlaps(a, value)) : [];
  const running = clashes.filter((a) => a.status === "running").map((a) => a.experimentName);
  const drafts = clashes.filter((a) => a.status !== "running").map((a) => a.experimentName);

  const choose = (id: string) => {
    if (id === NONE) return onChange(null);
    const slice = firstFreeSlice(others(id), 1) ?? { start: 0, end: 1 };
    onChange({ namespaceId: id, ...slice });
  };
  const setBound = (key: "start" | "end", percent: number) =>
    value !== null && Number.isFinite(percent) && onChange({ ...value, [key]: roundSlice(Math.min(100, Math.max(0, percent)) / 100) });
  const free = value === null ? null : firstFreeSlice(taken, Math.max(value.end - value.start, 0.001));

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <div>
        <p className="text-label font-medium">{t(($) => $.experimentForm.title)}</p>
        <p className="mt-0.5 text-meta text-muted">{t(($) => $.experimentForm.description)}</p>
      </div>
      {list.isError ? (
        <p className="text-meta text-danger">{t(($) => $.experimentForm.loadFailed, { message: errorMessage(list.error) })}</p>
      ) : list.isSuccess && namespaces.length === 0 && value === null ? (
        <p className="text-label text-muted">
          <Trans t={t} i18nKey={($) => $.experimentForm.noNamespaces} components={{ link: <Link to="/namespaces" className="text-link hover:underline" /> }} />
        </p>
      ) : (
        <>
          <Select
            value={value?.namespaceId ?? NONE}
            onChange={(k) => typeof k === "string" && choose(k)}
            isDisabled={list.isPending}
            className="sm:max-w-xs"
          >
            <Label>{t(($) => $.experimentForm.namespace)}</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id={NONE} textValue={t(($) => $.experimentForm.none)}>
                  {t(($) => $.experimentForm.none)}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                {namespaces.map(({ namespace: n }) => (
                  <ListBox.Item key={n.id} id={n.id} textValue={n.name}>
                    {n.name}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          {value !== null && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end gap-3">
                {(["start", "end"] as const).map((key) => (
                  <NumberField
                    key={key}
                    value={Number((value[key] * 100).toFixed(1))}
                    onChange={(p) => setBound(key, p)}
                    minValue={0}
                    maxValue={100}
                    step={0.1}
                    isInvalid={!rangeOk}
                    className="w-28"
                  >
                    <Label>{t(($) => $.experimentForm[key])}</Label>
                    <NumberField.Group className="grid-cols-[1fr_auto]">
                      <NumberField.Input className="text-right tabular" />
                      <span className="pr-3 text-label text-muted">%</span>
                    </NumberField.Group>
                  </NumberField>
                ))}
                <Button size="sm" variant="outline" className="mb-0.5" isDisabled={free === null} onPress={() => free !== null && onChange({ ...value, ...free })}>
                  {free === null ? t(($) => $.experimentForm.full) : t(($) => $.experimentForm.useFree)}
                </Button>
              </div>
              <AllocationBar allocations={taken} selection={rangeOk ? value : null} conflict={running.length > 0} />
              {!rangeOk ? (
                <p role="alert" className="text-meta text-danger">{t(($) => $.experimentForm.rangeInvalid)}</p>
              ) : running.length > 0 ? (
                <p role="alert" className="text-meta text-danger">{t(($) => $.experimentForm.overlapRunning, { names: formatList(running) })}</p>
              ) : drafts.length > 0 ? (
                <p className="text-meta text-muted">{t(($) => $.experimentForm.overlapDraft, { names: formatList(drafts) })}</p>
              ) : (
                <p className="text-meta text-muted">{t(($) => $.experimentForm.help)}</p>
              )}
              {current === undefined && list.isSuccess && <p className="text-meta text-danger">{t(($) => $.experimentForm.missing)}</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
