/** A fork: one stem splits into two branches; the branch that took the new path carries the brand color */
export function LogoMark({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="7" className="fill-foreground" />
      <path
        d="M16 25.5V17.5C16 14.5 13.5 12.5 10.5 10.5M16 17.5C16 14.5 18.5 12.5 21.5 10.5"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-background"
      />
      <circle cx="21.5" cy="10.5" r="2.6" className="fill-brand" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <LogoMark />
      <span className="text-section font-semibold tracking-tight">furca</span>
    </span>
  );
}
