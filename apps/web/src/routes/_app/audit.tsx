import { Label, ListBox, Select } from "@heroui/react";
import type { AuditEntityType } from "@furca/core/audit/AuditLog";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AuditList, entityTypes } from "~/components/audit/AuditList";
import { PageHeader, Panel } from "~/components/ui/primitives";
import { i18n } from "~/i18n";

const isEntityType = (v: unknown): v is AuditEntityType => entityTypes.some((t) => t.type === v);

export const Route = createFileRoute("/_app/audit")({
  validateSearch: (s: Record<string, unknown>): { type?: AuditEntityType } => (isEntityType(s.type) ? { type: s.type } : {}),
  head: () => ({ meta: [{ title: i18n.t("audit:pageTitle") }] }),
  component: Page,
});

function Page() {
  const { t } = useTranslation("audit");
  const { type } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <>
      <PageHeader
        title={t("page.title")}
        description={t("page.description")}
      />
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
          <Select
            aria-label={t("page.filterLabel")}
            value={type ?? "all"}
            onChange={(k) => void navigate({ search: k === "all" || !isEntityType(k) ? {} : { type: k }, replace: true })}
            className="w-48"
          >
            <Label className="sr-only">{t("page.type")}</Label>
            <Select.Trigger className="h-8">
              <Select.Value className="text-label" />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id="all" textValue={t("page.allChanges")}>
                  {t("page.allChanges")}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                {entityTypes.map((et) => (
                  <ListBox.Item key={et.type} id={et.type} textValue={t(`entityTypes.${et.type}`)}>
                    <et.icon className="size-4 text-muted" />
                    {t(`entityTypes.${et.type}`)}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <p className="text-meta text-muted">{t("page.hint")}</p>
        </div>
        <AuditList key={type ?? "all"} entityType={type ?? null} />
      </Panel>
    </>
  );
}
