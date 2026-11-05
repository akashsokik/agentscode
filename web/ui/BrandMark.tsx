/** The app's mark: the favicon's code brackets, drawn in theme colours. */
export function BrandMark() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4 shrink-0">
      <rect x="1" y="1" width="14" height="14" rx="3.5" className="fill-content/10" />
      <path d="M5 5.5 3 8l2 2.5M11 5.5 13 8l-2 2.5" fill="none" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="stroke-accent" />
      <circle cx="8" cy="8" r="1.2" className="fill-content/80" />
    </svg>
  );
}
