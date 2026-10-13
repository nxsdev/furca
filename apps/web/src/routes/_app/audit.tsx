import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "~/components/ui/primitives";

export const Route = createFileRoute("/_app/audit")({
  head: () => ({ meta: [{ title: "Audit log · kuji" }] }),
  component: Page,
});

// TODO: placeholder
function Page() {
  return <PageHeader title="Audit log" description="Every change to flags, experiments and metrics." />;
}
