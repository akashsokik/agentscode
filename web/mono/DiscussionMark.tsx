// MonoCode's DiscussionEmpty art (features/sessions/ui/DiscussionEmpty.tsx) and the mascotPath
// helper it draws with (features/projects/model/projectMascots.ts): overlapping speech bubbles in
// pixels, with a dim scatter around their edges.

const GRID_W = 22;

const BUBBLES = [
  "..###########.........",
  ".##.........##........",
  ".#...........#........",
  ".#...#.#.#...#........",
  ".#...........#........",
  ".##.........##........",
  "..##########..........",
  "..##.........#######..",
  "..#.........##.....##.",
  "............#.......#.",
  "............#.#.#.#.#.",
  "............#.......#.",
  "............##.....##.",
  ".............#######..",
  "..................##..",
  "...................#..",
];

const GLOW = [
  "#.............#.......",
  "......................",
  "......................",
  "#.............#.......",
  "......................",
  "......................",
  "#.....................",
  "...........#.........#",
  "......................",
  "......................",
  "...........#.........#",
  "......................",
  "......................",
  ".....................#",
  "......................",
  "......................",
];

/** One SVG path of unit squares, one run per stretch of `#` in a row. */
function mascotPath(rows: readonly string[]): string {
  let path = "";
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "#") {
        x += 1;
        continue;
      }
      let run = 1;
      while (row[x + run] === "#") run += 1;
      path += `M${x} ${y}h${run}v1h-${run}z`;
      x += run;
    }
  });
  return path;
}

const BUBBLES_PATH = mascotPath(BUBBLES);
const GLOW_PATH = mascotPath(GLOW);

/** The speech-bubble mark; size and tone come from `className`. */
export function DiscussionMark({ className = "w-24 text-content/25" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${GRID_W} ${BUBBLES.length}`}
      shapeRendering="crispEdges"
      className={className}
      fill="currentColor"
    >
      <path d={GLOW_PATH} opacity={0.4} />
      <path d={BUBBLES_PATH} />
    </svg>
  );
}
