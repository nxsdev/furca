import { Switch } from "@heroui/react";

/** On/off switch used for environments and rules. Off reads as hollow in dark mode too */
export function FlagSwitch({
  isSelected,
  onChange,
  isDisabled,
  size = "sm",
  className,
  "aria-label": ariaLabel,
}: {
  isSelected: boolean;
  onChange: (next: boolean) => void;
  isDisabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  "aria-label": string;
}) {
  return (
    <Switch
      size={size}
      aria-label={ariaLabel}
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
}
