import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "~/components/ui/primitives";

export const Route = createFileRoute("/_app/environments")({
  head: () => ({ meta: [{ title: "SDK & environments · kuji" }] }),
  component: Page,
});

// TODO: placeholder
function Page() {
  return <PageHeader title="SDK & environments" description="SDK keys and what each environment receives." />;
}
