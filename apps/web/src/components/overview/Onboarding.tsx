import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { Panel } from "~/components/ui/primitives";

export interface OnboardingStep {
  readonly id: string;
  readonly title: string;
  readonly description: ReactNode;
  /** Shown only while this is the next step to do */
  readonly body?: ReactNode;
  /** Rendered as the primary button on the next step, secondary on later ones */
  readonly action?: (variant: "primary" | "secondary") => ReactNode;
  readonly done: boolean;
}

/** The furca loop as a checklist; every check comes from real data, never from clicking "mark done" */
export function Onboarding({ steps }: { steps: ReadonlyArray<OnboardingStep> }) {
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)?.id;
  return (
    <Panel>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-5 py-4">
        <div>
          <h2 className="text-section font-medium">Get started</h2>
          <p className="mt-0.5 text-label text-muted">
            Ship a change behind a flag, measure it, and let an experiment tell you whether to keep it.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-label text-muted tabular">
            {done} of {steps.length} done
          </span>
          <span className="flex gap-1" aria-hidden="true">
            {steps.map((s) => (
              <span key={s.id} className={`h-1 w-6 rounded-full ${s.done ? "bg-foreground" : "bg-default"}`} />
            ))}
          </span>
        </div>
      </div>
      <ol>
        {steps.map((s, i) => {
          const isNext = s.id === next;
          return (
            <li key={s.id} className="flex gap-4 border-t border-border px-5 py-4" aria-current={isNext ? "step" : undefined}>
              <span
                className={`mt-px flex size-6 shrink-0 items-center justify-center rounded-full text-meta font-medium tabular ${
                  s.done
                    ? "bg-foreground text-background"
                    : isNext
                      ? "border border-foreground text-foreground"
                      : "border border-border text-muted"
                }`}
              >
                {s.done ? <Check className="size-3.5" strokeWidth={2.5} aria-label="Done" /> : i + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3 className={`text-body font-medium ${s.done ? "text-muted" : ""}`}>{s.title}</h3>
                  {!isNext && !s.done && s.action?.("secondary")}
                </div>
                <p className="max-w-[72ch] text-label text-muted">{s.description}</p>
                {isNext && (s.body !== undefined || s.action !== undefined) && (
                  <div className="mt-2 flex min-w-0 flex-col items-start gap-3">
                    {s.body}
                    {s.action?.("primary")}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
