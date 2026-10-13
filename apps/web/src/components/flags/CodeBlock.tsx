import { CopyButton } from "~/components/ui/primitives";

/** Copyable code sample. Comment lines are muted; everything else stays ink */
export function CodeBlock({ code, title }: { code: string; title?: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface-secondary text-left">
      <div className="flex h-9 items-center justify-between gap-2 border-b border-border pr-1 pl-3.5">
        <span className="truncate text-meta font-medium text-muted">{title ?? ""}</span>
        <CopyButton value={code} label="Copy code" />
      </div>
      <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[0.8125rem] leading-[1.6]">
        <code>
          {code.split("\n").map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static lines
            <span key={i} className={`block ${line.trimStart().startsWith("//") ? "text-muted" : ""}`}>
              {line === "" ? " " : line}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
