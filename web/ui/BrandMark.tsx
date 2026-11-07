/**
 * The app's mark at 16px: Orca's 2x2 grid (top-left and bottom-right cells lit) with its two empty
 * cells filled by two agents, warm and cool. The app icon (build/icon.svg) and the favicon in
 * index.html draw the same grid.
 */
export function BrandMark() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4 shrink-0">
      <rect x="2.5" y="2.5" width="5" height="5" className="fill-content" />
      <rect x="8.5" y="2.5" width="5" height="5" fill="#ec8a60" />
      <rect x="2.5" y="8.5" width="5" height="5" className="fill-accent" />
      <rect x="8.5" y="8.5" width="5" height="5" className="fill-content" />
    </svg>
  );
}
