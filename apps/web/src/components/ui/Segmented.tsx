import { type ReactNode, useId } from "react";
import { Label, Radio, RadioGroup, Text } from "react-aria-components";

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  /** When any option has one, options render as choice tiles instead of a compact bar */
  readonly description?: ReactNode;
}

/**
 * Single choice as a segmented control (a radio group underneath, so arrow keys and forms work).
 * Compact bar for short options; tiles with one-line explanations when options need teaching
 */
export function Segmented<T extends string>({
  label,
  description,
  value,
  onChange,
  options,
  isDisabled,
  tilesClassName = "sm:grid-cols-3",
  "aria-label": ariaLabel,
}: {
  label?: ReactNode;
  description?: ReactNode;
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentOption<T>>;
  isDisabled?: boolean;
  /** Grid columns of the tiles */
  tilesClassName?: string;
  "aria-label"?: string;
}) {
  const tiles = options.some((o) => o.description !== undefined);
  const id = useId();
  // Name each radio by its label alone (not label + description, and never its value), describe it by the description
  const a11y = (o: SegmentOption<T>) => ({
    "aria-label": typeof o.label === "string" ? o.label : undefined,
    "aria-describedby": tiles && o.description !== undefined ? `${id}-${o.value}` : undefined,
  });
  return (
    <RadioGroup
      value={value}
      onChange={(v) => onChange(v as T)}
      orientation="horizontal"
      isDisabled={isDisabled}
      aria-label={ariaLabel}
      className="flex flex-col gap-1.5"
    >
      {label !== undefined && <Label className="text-sm font-medium">{label}</Label>}
      <div
        className={
          tiles
            ? `grid gap-2 ${tilesClassName}`
            : "inline-flex h-8 w-fit max-w-full items-stretch overflow-x-auto rounded-md border border-border bg-default/50 p-0.5"
        }
      >
        {options.map((o) =>
          tiles ? (
            <Radio
              key={o.value}
              value={o.value}
              {...a11y(o)}
              className="flex cursor-pointer flex-col gap-0.5 rounded-lg border border-border bg-surface px-3 py-2.5 outline-none transition-[border-color,box-shadow,background-color] duration-150 ease-out-quart hover:border-muted/50 data-disabled:cursor-not-allowed data-disabled:opacity-50 data-focus-visible:ring-2 data-focus-visible:ring-focus data-selected:border-foreground data-selected:shadow-[inset_0_0_0_1px_var(--foreground)]"
            >
              <span className="text-label font-medium">{o.label}</span>
              <span id={`${id}-${o.value}`} className="text-meta text-muted">
                {o.description}
              </span>
            </Radio>
          ) : (
            <Radio
              key={o.value}
              value={o.value}
              {...a11y(o)}
              className="flex cursor-pointer items-center whitespace-nowrap rounded-[5px] px-3 text-label text-muted outline-none transition-colors duration-150 ease-out-quart hover:text-foreground data-disabled:cursor-not-allowed data-disabled:opacity-50 data-focus-visible:ring-2 data-focus-visible:ring-focus data-pressed:bg-surface/60 data-selected:bg-surface data-selected:font-medium data-selected:text-foreground data-selected:shadow-[0_0_0_1px_var(--border)]"
            >
              {o.label}
            </Radio>
          ),
        )}
      </div>
      {description !== undefined && (
        <Text slot="description" className="text-xs text-muted">
          {description}
        </Text>
      )}
    </RadioGroup>
  );
}
