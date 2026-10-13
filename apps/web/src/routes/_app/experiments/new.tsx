import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ExperimentForm } from "~/components/experiments/ExperimentForm";
import { PageHeader } from "~/components/ui/primitives";

export const Route = createFileRoute("/_app/experiments/new")({
  head: () => ({ meta: [{ title: "New experiment · furca" }] }),
  validateSearch: (search: Record<string, unknown>): { featureId?: string } =>
    typeof search.featureId === "string" ? { featureId: search.featureId } : {},
  component: Page,
});

function Page() {
  const navigate = useNavigate();
  const { featureId } = Route.useSearch();
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link to="/experiments" className="w-fit text-label text-muted hover:text-foreground">
            Experiments
          </Link>
        }
        title="New experiment"
        description="Register the hypothesis and success metric before any data arrives. Nothing goes live until you start it."
      />
      <ExperimentForm
        initialFeatureId={featureId ?? null}
        onSaved={(x) => navigate({ to: "/experiments/$experimentId", params: { experimentId: x.id } })}
        onCancel={() => navigate({ to: "/experiments" })}
      />
    </>
  );
}
