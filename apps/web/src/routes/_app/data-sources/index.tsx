import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "~/components/ui/primitives";

export const Route = createFileRoute("/_app/data-sources/")({
  head: () => ({ meta: [{ title: "Data sources · kuji" }] }),
  component: Page,
});

// TODO: placeholder
function Page() {
  return <PageHeader title="Data sources" description="Where exposures and events are read from." />;
}
