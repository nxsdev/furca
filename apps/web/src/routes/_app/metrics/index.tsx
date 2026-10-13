import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "~/components/ui/primitives";

export const Route = createFileRoute("/_app/metrics/")({
  head: () => ({ meta: [{ title: "Metrics · kuji" }] }),
  component: Page,
});

// TODO: placeholder
function Page() {
  return <PageHeader title="Metrics" description="Reusable definitions of what success means." />;
}
