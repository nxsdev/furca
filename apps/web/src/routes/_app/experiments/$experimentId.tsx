import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "~/components/ui/primitives";

export const Route = createFileRoute("/_app/experiments/$experimentId")({
  head: () => ({ meta: [{ title: "Experiment · kuji" }] }),
  component: Page,
});

// TODO: placeholder
function Page() {
  return <PageHeader title="Experiment" description="" />;
}
