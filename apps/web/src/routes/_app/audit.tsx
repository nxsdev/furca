import { Label, ListBox, Select } from "@heroui/react";
import type { AuditEntityType } from "@furca/core/audit/AuditLog";
import { createFileRoute } from "@tanstack/react-router";
import { AuditList, entityTypes } from "~/components/audit/AuditList";
import { PageHeader, Panel } from "~/components/ui/primitives";

const isEntityType = (v: unknown): v is AuditEntityType => entityTypes.some((t) => t.type === v);

export const Route = createFileRoute("/_app/audit")({
  validateSearch: (s: Record<string, unknown>): { type?: AuditEntityType } => (isEntityType(s.type) ? { type: s.type } : {}),
  head: () => ({ meta: [{ title: "Audit log · furca" }] }),
  component: Page,
});

function Page() {
  const { type } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change to flags, experiments, metrics and settings: who made it, when, and exactly what changed."
      />
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
          <Select
            aria-label="Filter by type"
            value={type ?? "all"}
            onChange={(k) => void navigate({ search: k === "all" || !isEntityType(k) ? {} : { type: k }, replace: true })}
            className="w-48"
          >
            <Label className="sr-only">Type</Label>
            <Select.Trigger className="h-8">
              <Select.Value className="text-label" />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id="all" textValue="All changes">
                  All changes
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                {entityTypes.map((t) => (
                  <ListBox.Item key={t.type} id={t.type} textValue={`${t.label}s`}>
                    <t.icon className="size-4 text-muted" />
                    {t.label}s
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <p className="text-meta text-muted">Newest first. Expand a row to see the diff.</p>
        </div>
        <AuditList key={type ?? "all"} entityType={type ?? null} />
      </Panel>
    </>
  );
}
