// Lanes for the Work view's commit graph (ACH-D18), after lazygit's pkg/gui/presentation/graph:
// commits come newest first; each one is drawn in the lane of the first line that reaches it (or a
// free lane, for a branch tip); its first parent goes on in that lane; a merge's other parents take
// the lane of a line already heading for them, else the lowest free lane. A line frees its lane once
// it reaches its commit, so lanes are reused from the left and stay few. Lanes never slide sideways
// (as in VS Code's Git Graph), so every line is straight, with a rounded turn only where a branch
// forks off or joins. Colours, as in lazygit, come from what opened the lane: here, its owner.

export interface GraphInput {
  hash: string;
  parents: string[];
  /** Whose lane this commit opens or sits in, when known: 'main' for main's own line, else an owner. */
  key?: string | null;
  /** The owner of a branch this merge brought in: the colour of the lane to its other parents. */
  mergeKey?: string | null;
}

export interface GraphRow {
  hash: string;
  lane: number;
  /** Whose lane it sits in (for its dot's colour). */
  key: string | null;
}

/** A line from a commit to one of its parents. */
export interface GraphEdge {
  /** The child's row and lane. */
  from: number;
  fromLane: number;
  /** The lane the line runs down in. */
  lane: number;
  /** The parent's row, or the number of rows when the parent is below the window (the line runs off the bottom). */
  to: number;
  toLane: number;
  key: string | null;
}

export interface GraphLayout {
  rows: GraphRow[];
  edges: GraphEdge[];
  /** How many lanes it needs. */
  lanes: number;
}

interface Line {
  /** The parent it heads for. */
  target: string;
  lane: number;
  fromRow: number;
  fromLane: number;
  key: string | null;
}

/**
 * `mainKey`: commits with this key (main's own line) always sit in lane 0, which nothing else takes,
 * so main reads as one straight line on the left and branches open to its right, as in the approved
 * design (ACH-D18), even when a branch's tip is newer than main's.
 */
export function layoutGraph(commits: readonly GraphInput[], options: { mainKey?: string } = {}): GraphLayout {
  const rows: GraphRow[] = [];
  const edges: GraphEdge[] = [];
  let open: Line[] = [];
  let width = 0;
  const index = new Map(commits.map((c, i) => [c.hash, i]));
  const reserved = options.mainKey !== undefined;
  const lowestFree = (taken: Set<number>, main = false) => { let lane = reserved && !main ? 1 : 0; while (taken.has(lane)) lane++; return lane; };

  commits.forEach((commit, row) => {
    const arriving = open.filter(l => l.target === commit.hash);
    const going = open.filter(l => l.target !== commit.hash);
    const busy = new Set(going.map(l => l.lane));
    // Its lane: main's line keeps lane 0; else the first line reaching it (lowest lane), or for a new tip the lowest free one.
    const isMain = reserved && commit.key === options.mainKey;
    const lane = isMain && !busy.has(0) ? 0 : arriving.length ? Math.min(...arriving.map(l => l.lane)) : lowestFree(busy, isMain);
    const key = commit.key ?? arriving.find(l => l.lane === lane)?.key ?? arriving[0]?.key ?? null;
    rows.push({ hash: commit.hash, lane, key });
    width = Math.max(width, lane + 1);
    for (const l of arriving) edges.push({ from: l.fromRow, fromLane: l.fromLane, lane: l.lane, to: row, toLane: lane, key: l.key });

    // Its parents: the first goes on in its lane; another joins a line already heading there, or takes a free lane.
    const next = [...going];
    const taken = new Set([...busy, lane]);
    commit.parents.forEach((parent, i) => {
      if (i === 0) {
        next.push({ target: parent, lane, fromRow: row, fromLane: lane, key });
        return;
      }
      const sharing = next.find(l => l.target === parent);
      const via = sharing ? sharing.lane : lowestFree(taken);
      taken.add(via);
      width = Math.max(width, via + 1);
      next.push({ target: parent, lane: via, fromRow: row, fromLane: lane, key: commit.mergeKey ?? key });
    });
    open = next;
  });

  // Lines whose parent is below the window run off the bottom in their lane.
  for (const l of open) {
    if (!index.has(l.target)) edges.push({ from: l.fromRow, fromLane: l.fromLane, lane: l.lane, to: commits.length, toLane: l.lane, key: l.key });
  }
  return { rows, edges, lanes: width };
}

/**
 * The SVG path of one line, rows `rowHeight` apart and lanes `laneWidth` apart from `left`: straight
 * down its lane, with a rounded turn out of the child (a merge reaching its branch) and into the
 * parent (a branch joining where it forked).
 */
export function edgePath(edge: GraphEdge, rows: number, laneWidth: number, rowHeight: number, left: number): string {
  const x = (lane: number) => left + lane * laneWidth;
  const y = (row: number) => row * rowHeight + rowHeight / 2;
  const x0 = x(edge.fromLane), x1 = x(edge.lane), x2 = x(edge.toLane);
  const y0 = y(edge.from);
  const y2 = edge.to >= rows ? rows * rowHeight + 2 : y(edge.to);
  const half = rowHeight / 2;
  let d = `M${x0} ${y0}`;
  let at = y0;
  if (x1 !== x0) { d += `C${x0} ${y0 + half} ${x1} ${y0 + half} ${x1} ${y0 + rowHeight}`; at = y0 + rowHeight; }
  if (x2 !== x1 && edge.to < rows) {
    const turn = Math.max(at, y2 - rowHeight);
    if (turn > at) d += `V${turn}`;
    d += `C${x1} ${turn + (y2 - turn) / 2} ${x2} ${turn + (y2 - turn) / 2} ${x2} ${y2}`;
  } else if (y2 > at) {
    d += `V${y2}`;
  }
  return d;
}
