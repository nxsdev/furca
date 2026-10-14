import type { ChangeRequest } from "@furca/core/approvals/ChangeRequest";
import type { Environment } from "@furca/core/environments/Environment";
import type { FeatureValueType } from "@furca/core/features/Feature";
import { Button, toast } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { Rule } from "~/components/flags/RulesEditor";
import { ValuePreview } from "~/components/flags/ValueInput";
import { submitHandler, setServerError, useAppForm } from "~/components/form/form";
import { environmentHue } from "~/components/shell/Sidebar";
import { useConditionsSummary } from "~/components/targeting/ConditionBuilder";
import { RelativeTime } from "~/components/ui/primitives";
import { client, errorMessage, orpc } from "~/lib/rpc";
import { usePermissions } from "~/lib/permissions";
import { type DiffKind, ruleDiff } from "./ruleDiff";

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

function RuleSummary({ rule, valueType, className = "" }: { rule: Rule; valueType: FeatureValueType; className?: string }) {
  const { t } = useTranslation("flags");
  const conditionsSummary = useConditionsSummary();
  return (
    <span className={`flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 ${rule.enabled ? "" : "opacity-60"} ${className}`}>
      <span className="rounded-[4px] border border-border px-1.5 text-meta leading-[18px] font-medium">{t(`rules.types.${rule._tag}`)}</span>
      {rule._tag !== "experiment" && (
        <>
          <span className="min-w-0 break-words">{conditionsSummary(rule.conditions)}</span>
          {rule._tag === "rollout" && (
            <span className="text-muted">
              · <Trans t={t} i18nKey="rules.rolloutOf" values={{ percent: pct(rule.coverage), attribute: rule.hashAttribute }} components={{ pct: <span className="font-mono tabular text-foreground" /> }} />
            </span>
          )}
          <span className="inline-flex min-w-0 items-center gap-1 text-muted">
            · <Trans t={t} i18nKey="shared.serve" components={{ value: <ValuePreview valueType={valueType} value={rule.value} className="min-w-0" /> }} />
          </span>
        </>
      )}
      {!rule.enabled && <span className="text-meta text-muted">{t("shared.off")}</span>}
    </span>
  );
}

const kindStyle: Record<DiffKind, string> = {
  added: "border-l-focus",
  changed: "border-l-focus",
  moved: "border-l-border",
  removed: "border-l-border line-through decoration-muted",
  same: "border-l-transparent",
};

/** What approving changes: on/off, or the rules with each one marked new / changed / moved / removed */
export function ChangeDiff({ request, valueType }: { request: ChangeRequest; valueType: FeatureValueType }) {
  const { t } = useTranslation("reviews");
  const { change, base } = request;
  if (change.type === "toggle") {
    return (
      <p className="flex items-center gap-2 text-label">
        <span className="text-muted">{base.enabled ? t("change.on") : t("change.off")}</span>
        <ArrowRight className="size-3.5 text-muted" aria-label={t("change.becomes")} />
        <span className="font-medium">{change.enabled ? t("change.on") : t("change.off")}</span>
      </p>
    );
  }
  const lines = ruleDiff(base.rules as ReadonlyArray<Rule>, change.rules as ReadonlyArray<Rule>);
  const unchanged = lines.filter((l) => l.kind === "same").length;
  const changed = lines.filter((l) => l.kind !== "same");
  return (
    <div className="flex flex-col gap-1 text-label">
      {change.rules.length === 0 && <p className="text-muted">{t("change.allRulesRemoved")}</p>}
      <ol className="flex flex-col gap-1">
        {changed.map(({ rule, previous, kind }) => (
          <li key={`${kind}:${rule.id}`} className={`flex flex-col gap-0.5 border-l-2 py-0.5 pl-2.5 ${kindStyle[kind]}`}>
            <span className="flex min-w-0 items-start gap-2">
              <span className={`w-16 shrink-0 text-meta font-medium ${kind === "removed" ? "text-muted no-underline" : "text-foreground"}`}>
                {t(`change.kinds.${kind as Exclude<DiffKind, "same">}`)}
              </span>
              <RuleSummary rule={rule} valueType={valueType} className={kind === "removed" ? "text-muted line-through" : ""} />
            </span>
            {kind === "changed" && previous !== null && (
              <span className="flex min-w-0 items-start gap-2">
                <span className="w-16 shrink-0 text-meta text-muted">{t("change.was")}</span>
                <RuleSummary rule={previous} valueType={valueType} className="text-muted line-through" />
              </span>
            )}
          </li>
        ))}
      </ol>
      {unchanged > 0 && <p className="pl-3 text-meta text-muted">{t("change.unchanged", { count: unchanged })}</p>}
    </div>
  );
}

/** Approve / Reject (admins, not the author) with an optional comment; Cancel for the author or an admin */
function ReviewActions({ request }: { request: ChangeRequest }) {
  const { t } = useTranslation(["reviews", "common"]);
  const queryClient = useQueryClient();
  const { me, isAdmin } = usePermissions();
  const [mode, setMode] = useState<"approve" | "reject" | null>(null);
  const isAuthor = me?.id === request.authorId;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.changeRequests.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.features.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.environments.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
  };
  const form = useAppForm({
    defaultValues: { comment: "" },
    onSubmit: async ({ value, formApi }) => {
      try {
        const input = { id: request.id, comment: value.comment.trim() };
        if (mode === "approve") {
          await client.changeRequests.approve(input);
          toast.success(t("actions.approved", { key: request.featureKey }), { description: t("actions.approvedDescription") });
        } else {
          await client.changeRequests.reject(input);
          toast(t("actions.rejected", { key: request.featureKey }));
        }
        setMode(null);
        refresh();
      } catch (error) {
        setServerError(formApi, error);
      }
    },
  });
  const cancel = useMutation({
    mutationFn: () => client.changeRequests.cancel({ id: request.id }),
    onSuccess: () => {
      toast(t("actions.cancelled"));
      refresh();
    },
    onError: (error) => toast.danger(t("actions.failed"), { description: errorMessage(error) }),
  });

  if (mode !== null) {
    return (
      <form noValidate onSubmit={submitHandler(form)} className="flex flex-col gap-2 pt-1">
        <form.AppField name="comment">
          {(field) => <field.TextAreaField label={t("actions.commentLabel")} placeholder={t("actions.commentPlaceholder")} rows={2} className="max-w-lg" />}
        </form.AppField>
        <form.AppForm>
          <form.FormError />
        </form.AppForm>
        <div className="flex gap-2">
          <form.AppForm>
            <form.SubmitButton size="sm" label={mode === "approve" ? t("actions.confirmApprove") : t("actions.confirmReject")} />
          </form.AppForm>
          <Button size="sm" variant="tertiary" onPress={() => setMode(null)}>
            {t("common:actions.back")}
          </Button>
        </div>
      </form>
    );
  }
  if (!isAdmin && !isAuthor) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      {isAdmin && !isAuthor && (
        <Button size="sm" onPress={() => { form.reset(); setMode("approve"); }}>
          {t("actions.approve")}
        </Button>
      )}
      {isAdmin && !isAuthor && (
        <Button size="sm" variant="outline" onPress={() => { form.reset(); setMode("reject"); }}>
          {t("actions.reject")}
        </Button>
      )}
      <Button size="sm" variant="ghost" className="text-muted" isPending={cancel.isPending} onPress={() => cancel.mutate()}>
        {t("actions.cancel")}
      </Button>
      {isAuthor && <span className="text-meta text-muted">{t("actions.waitingForAdmin")}</span>}
    </div>
  );
}

/** One open request: where, what changes (before → after), who asked and why, and the review actions */
export function ChangeRequestItem({
  request,
  environment,
  valueType,
  showFlag = false,
}: {
  request: ChangeRequest;
  environment: Environment | undefined;
  valueType: FeatureValueType;
  showFlag?: boolean;
}) {
  const { t } = useTranslation("reviews");
  const what =
    request.change.type === "rules" ? t("change.rules") : request.change.enabled ? t("change.turnOn") : t("change.turnOff");
  return (
    <article className="flex flex-col gap-2 px-4 py-4 sm:px-5">
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-label">
        {showFlag && (
          <Link
            to="/flags/$featureId"
            params={{ featureId: request.featureId }}
            className="truncate rounded-sm font-mono font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            {request.featureKey}
          </Link>
        )}
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span className={`size-2 rounded-full ${environmentHue(environment?.key ?? "")}`} aria-hidden="true" />
          {environment?.name ?? "…"}
        </span>
        <span className="text-muted">·</span>
        <span>{what}</span>
      </header>
      <p className="text-meta text-muted">
        <Trans t={t} i18nKey="item.requestedBy" values={{ email: request.authorEmail }} components={{ relative: <RelativeTime date={request.createdAt} /> }} />
      </p>
      {request.comment !== "" && <p className="max-w-[72ch] border-l-2 border-border pl-2.5 text-label whitespace-pre-wrap">{request.comment}</p>}
      <ChangeDiff request={request} valueType={valueType} />
      <ReviewActions request={request} />
    </article>
  );
}
