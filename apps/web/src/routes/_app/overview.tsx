import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "~/components/ui/primitives";

export const Route = createFileRoute("/_app/overview")({
  head: () => ({ meta: [{ title: "Overview · kuji" }] }),
  component: Page,
});

// TODO: placeholder
function Page() {
  return <PageHeader title="Overview" description="Running experiments, recent changes and SDK traffic at a glance." />;
}
