import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "~/components/ui/primitives";

export const Route = createFileRoute("/_app/data-sources/$dataSourceId")({
  head: () => ({ meta: [{ title: "Data source · kuji" }] }),
  component: Page,
});

// TODO: placeholder
function Page() {
  return <PageHeader title="Data source" description="" />;
}
