/** Omikuji sticks: three bars, the drawn one tipped with the brand color */
export function LogoMark({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="7" className="fill-foreground" />
      <rect x="8" y="10" width="3" height="15" rx="1.5" className="fill-background" />
      <rect x="14.5" y="6" width="3" height="19" rx="1.5" className="fill-background" />
      <rect x="14.5" y="6" width="3" height="5" rx="1.5" className="fill-brand" />
      <rect x="21" y="12" width="3" height="13" rx="1.5" className="fill-background" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <LogoMark />
      <span className="text-section font-semibold tracking-tight">kuji</span>
    </span>
  );
}
