import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import type { ReactNode } from "react";

/** Compact single-choice segmented control (React Aria ToggleButtonGroup underneath) */
export function Segmented<K extends string>({
  value,
  onChange,
  options,
  isDisabled,
  className = "",
  "aria-label": ariaLabel,
}: {
  value: K;
  onChange: (next: K) => void;
  options: ReadonlyArray<{ id: K; label: ReactNode; textValue?: string }>;
  isDisabled?: boolean;
  className?: string;
  "aria-label": string;
}) {
  return (
    <ToggleButtonGroup
      aria-label={ariaLabel}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={new Set([value])}
      onSelectionChange={(keys) => {
        const next = [...keys][0];
        if (typeof next === "string") onChange(next as K);
      }}
      isDisabled={isDisabled}
      className={`max-w-full gap-0.5 overflow-x-auto rounded-md bg-default p-0.5 ${className}`}
    >
      {options.map((o) => (
        <ToggleButton
          key={o.id}
          id={o.id}
          aria-label={o.textValue}
          className="h-7 shrink-0 rounded-[5px] bg-transparent px-2.5 text-label font-medium text-muted transition-colors duration-150 hover:text-foreground data-[selected=true]:bg-surface data-[selected=true]:text-foreground data-[selected=true]:shadow-[0_0_0_1px_var(--border),0_1px_2px_oklch(0_0_0/0.06)] md:h-7"
        >
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
