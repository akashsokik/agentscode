/**
 * The app's mark at 16px: two agents as a warm and a cool code bracket, talking (the dots). The app
 * icon (build/icon.svg) puts the dots in a speech bubble; the favicon in index.html matches this.
 */
export function BrandMark() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4 shrink-0">
      <rect x="0.5" y="0.5" width="15" height="15" rx="4" className="fill-content/10" />
      <path d="M5.3 4.4 2.9 8l2.4 3.6" fill="none" stroke="#ec8a60" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.7 4.4 13.1 8l-2.4 3.6" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="stroke-accent" />
      <circle cx="6.4" cy="8" r="0.85" className="fill-content/45" />
      <circle cx="8" cy="8" r="0.85" className="fill-content/70" />
      <circle cx="9.6" cy="8" r="0.85" className="fill-content" />
    </svg>
  );
}
