import { Label, Menu, Modal, SearchField, useFilter } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Flag, FlaskConical, Plus, ChartLine } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { Autocomplete } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { usePermissions } from "~/lib/permissions";
import { orpc } from "~/lib/rpc";
import { primaryNav, secondaryNav } from "./Sidebar";

interface Command {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon: ReactNode;
  readonly to: string;
  readonly search?: Record<string, string>;
}

/** ⌘K / Ctrl+K: jump to any page, flag, experiment or metric, or start creating one */
export function CommandPalette({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("shell");
  const navigate = useNavigate();
  const { contains } = useFilter({ sensitivity: "base" });
  const { canEdit } = usePermissions();
  const features = useQuery({ ...orpc.features.list.queryOptions({ input: { includeArchived: false } }), enabled: isOpen });
  const experiments = useQuery({ ...orpc.experiments.list.queryOptions({ input: { includeArchived: false } }), enabled: isOpen });
  const metrics = useQuery({ ...orpc.metrics.list.queryOptions({ input: { includeArchived: false } }), enabled: isOpen });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!isOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onOpenChange]);

  const createCommands: Array<Command> = [
    { id: "new-flag", label: t("search.createFlag"), icon: <Plus className="size-4" />, to: "/flags", search: { new: "1" } },
    { id: "new-experiment", label: t("search.createExperiment"), icon: <Plus className="size-4" />, to: "/experiments/new" },
    { id: "new-metric", label: t("search.createMetric"), icon: <Plus className="size-4" />, to: "/metrics", search: { new: "1" } },
  ];
  const commands: Array<Command> = [
    ...(canEdit ? createCommands : []),
    ...[...primaryNav, ...secondaryNav].map((item) => {
      const Icon = item.icon;
      return { id: `nav:${item.to}`, label: t(`nav.${item.label}`), hint: t("search.goTo"), icon: <Icon className="size-4" />, to: item.to };
    }),
    ...(features.data ?? []).map((f) => ({
      id: `flag:${f.id}`,
      label: f.key,
      hint: t("search.flag"),
      icon: <Flag className="size-4" />,
      to: `/flags/${f.id}`,
    })),
    ...(experiments.data ?? []).map((x) => ({
      id: `exp:${x.id}`,
      label: x.name,
      hint: t("search.experiment"),
      icon: <FlaskConical className="size-4" />,
      to: `/experiments/${x.id}`,
    })),
    ...(metrics.data ?? []).map((m) => ({
      id: `metric:${m.id}`,
      label: m.name,
      hint: t("search.metric"),
      icon: <ChartLine className="size-4" />,
      to: `/metrics/${m.id}`,
    })),
  ];

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange} variant="transparent">
      <Modal.Container placement="top" size="md" className="mt-[12vh]">
        <Modal.Dialog aria-label={t("search.palette")} className="overflow-hidden p-0 shadow-overlay">
          <Autocomplete filter={contains}>
            <SearchField autoFocus aria-label={t("search.label")} variant="secondary" className="border-b border-border">
              <SearchField.Group className="h-12 rounded-none border-0 bg-transparent px-4 shadow-none">
                <SearchField.SearchIcon />
                <SearchField.Input placeholder={t("search.placeholder")} className="text-body" />
              </SearchField.Group>
            </SearchField>
            <Menu
              aria-label={t("search.results")}
              className="max-h-[min(420px,60vh)] overflow-auto p-1.5"
              renderEmptyState={() => <p className="px-3 py-8 text-center text-body text-muted">{t("search.noMatches")}</p>}
              onAction={(key) => {
                const command = commands.find((c) => c.id === key);
                if (command === undefined) return;
                onOpenChange(false);
                void navigate({ to: command.to, search: command.search });
              }}
            >
              {commands.map((c) => (
                <Menu.Item key={c.id} id={c.id} textValue={`${c.label} ${c.hint ?? ""}`} className="h-9 gap-2.5 rounded-md">
                  <span className="text-muted">{c.icon}</span>
                  <Label className="flex-1 truncate">{c.label}</Label>
                  {c.hint !== undefined && <span className="text-meta text-muted">{c.hint}</span>}
                </Menu.Item>
              ))}
            </Menu>
          </Autocomplete>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
