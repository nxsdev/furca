import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "~/components/ui/primitives";

export const Route = createFileRoute("/_app/flags/")({
  head: () => ({ meta: [{ title: "Flags · kuji" }] }),
  component: Page,
});

// TODO: placeholder
function Page() {
  return <PageHeader title="Flags" description="Feature flags with per-environment targeting and rollouts." />;
}
