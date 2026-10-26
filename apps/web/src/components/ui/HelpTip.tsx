import { Button, Popover } from "@heroui/react";
import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * "?" after a term that needs explaining (jargon such as capping). Keep it outside field labels:
 * a button inside a <label> or a NumberField would be swallowed by the field
 */
export function HelpTip({ term, children }: { term: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Popover>
      <Button isIconOnly size="sm" variant="ghost" aria-label={t(($) => $.help.about, { term })} className="size-6 min-w-6 rounded-full text-muted">
        <CircleHelp className="size-3.5" />
      </Button>
      <Popover.Content placement="top" className="max-w-[min(20rem,calc(100vw-32px))]">
        <Popover.Dialog className="p-3 text-label leading-relaxed">{children}</Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
