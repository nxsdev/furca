import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ExperimentForm } from "~/components/experiments/ExperimentForm";
import { PageHeader } from "~/components/ui/primitives";
import { i18n } from "~/i18n";

export const Route = createFileRoute("/_app/experiments/new")({
  head: () => ({ meta: [{ title: i18n.t("experiments:pageTitle.new") }] }),
  validateSearch: (search: Record<string, unknown>): { featureId?: string } =>
    typeof search.featureId === "string" ? { featureId: search.featureId } : {},
  component: Page,
});

function Page() {
  const { t } = useTranslation("experiments");
  const navigate = useNavigate();
  const { featureId } = Route.useSearch();
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link to="/experiments" className="w-fit text-label text-muted hover:text-foreground">
            {t("breadcrumb")}
          </Link>
        }
        title={t("new.title")}
        description={t("new.description")}
      />
      <ExperimentForm
        initialFeatureId={featureId ?? null}
        onSaved={(x) => navigate({ to: "/experiments/$experimentId", params: { experimentId: x.id } })}
        onCancel={() => navigate({ to: "/experiments" })}
      />
    </>
  );
}
