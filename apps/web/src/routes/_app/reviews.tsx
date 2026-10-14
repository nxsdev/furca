import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ChangeRequestItem } from "~/components/reviews/ChangeRequestItem";
import { EmptyState, ListSkeleton, PageHeader, Panel, QueryError } from "~/components/ui/primitives";
import { i18n } from "~/i18n";
import { useEnvironment } from "~/lib/environment";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/reviews")({
  head: () => ({ meta: [{ title: i18n.t("reviews:pageTitle") }] }),
  component: Page,
});

function Page() {
  const { t } = useTranslation("reviews");
  const open = useQuery(orpc.changeRequests.list.queryOptions({ input: { status: "open" } }));
  const features = useQuery(orpc.features.list.queryOptions({ input: { includeArchived: true } }));
  const { environments } = useEnvironment();
  const valueType = (featureId: string) => features.data?.find((f) => f.id === featureId)?.valueType ?? "json";
  return (
    <>
      <PageHeader title={t("page.title")} description={t("page.description")} />
      {open.isPending ? (
        <Panel>
          <ListSkeleton rows={3} />
        </Panel>
      ) : open.isError ? (
        <QueryError message={t("page.loadFailed", { message: errorMessage(open.error) })} onRetry={() => open.refetch()} />
      ) : open.data.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title={t("page.emptyTitle")}
          description={t("page.emptyDescription")}
          action={
            <Link to="/environments" className="button button--sm button--outline">
              {t("page.emptyAction")}
            </Link>
          }
        />
      ) : (
        <Panel>
          <ul className="divide-y divide-border">
            {open.data.map((request) => (
              <li key={request.id}>
                <ChangeRequestItem
                  request={request}
                  environment={environments.find((e) => e.id === request.environmentId)}
                  valueType={valueType(request.featureId)}
                  showFlag
                />
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
