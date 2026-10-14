import { Switch } from "@heroui/react";
import { useId } from "react";

/**
 * On/off switch used for environments and rules. Off reads as hollow in dark mode too.
 * `description`: what the current state means (e.g. "On · everyone gets false"), as a tooltip and
 * the switch's accessible description
 */
export function FlagSwitch({
  isSelected,
  onChange,
  isDisabled,
  size = "sm",
  className,
  description,
  "aria-label": ariaLabel,
}: {
  isSelected: boolean;
  onChange: (next: boolean) => void;
  isDisabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  description?: string;
  "aria-label": string;
}) {
  const id = useId();
  const control = (
    <Switch
      size={size}
      aria-label={ariaLabel}
      aria-describedby={description === undefined ? undefined : id}
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
      className={`[--switch-control-bg:oklch(0.9_0_0)] dark:[--switch-control-bg:var(--default)] ${className ?? ""}`}
    >
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb className={isSelected ? "" : "dark:bg-[oklch(0.62_0_0)]"} />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );
  if (description === undefined) return control;
  return (
    <span title={description} className="inline-flex">
      {control}
      <span id={id} hidden>
        {description}
      </span>
    </span>
  );
}
