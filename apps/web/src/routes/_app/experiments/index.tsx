import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "~/components/ui/primitives";

export const Route = createFileRoute("/_app/experiments/")({
  head: () => ({ meta: [{ title: "Experiments · kuji" }] }),
  component: Page,
});

// TODO: placeholder
function Page() {
  return <PageHeader title="Experiments" description="Hypotheses, traffic and trustworthy results." />;
}
