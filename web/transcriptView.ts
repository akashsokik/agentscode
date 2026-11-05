/**
 * Where an agent's transcript stood when its tab went to the back. MonoCode keeps a tab's
 * transcript mounted while another tab is in front; here a tab switch remounts it, so this carries
 * the same state across: the latest turn keeps filling the view, the scroll position comes back,
 * and folds stay as you left them. A page reload starts fresh, as a cold mount does in MonoCode.
 */
export interface TranscriptView {
  /** The latest prompt you had sent here when the transcript was last on screen. */
  promptId?: string;
  /** The latest turn fills the view, its prompt at the top. Once on, it stays on. */
  anchored: boolean;
  /** Following the end. */
  pinned: boolean;
  /** How far above the end you were, in px. Only read when not pinned. */
  fromBottom: number;
  showAll: boolean;
  /** Folds you opened or closed, by turn id. */
  toggled: Map<string, boolean>;
}

const views = new Map<string, TranscriptView>();

export function rememberedView(agentId: string): TranscriptView | undefined {
  return views.get(agentId);
}

export function rememberView(agentId: string, patch: Partial<TranscriptView>): void {
  const previous = views.get(agentId) ?? { anchored: false, pinned: true, fromBottom: 0, showAll: false, toggled: new Map() };
  views.set(agentId, { ...previous, ...patch });
}

export function forgetViews(): void {
  views.clear();
}

/** What the transcript measures your latest prompt against, from when it first had entries. */
export interface Opening {
  id?: string;
  anchored: boolean;
}

/**
 * A transcript opened mid-turn anchors that turn. One you come back to keeps the anchoring it had,
 * and anchors if you sent a prompt while it was away; a first open of a settled one does not.
 */
export function openingAnchor(remembered: Pick<TranscriptView, 'promptId' | 'anchored'> | undefined, ownLatest: string | undefined, busy: boolean): Opening {
  if (!remembered) return { id: ownLatest, anchored: busy };
  return { id: remembered.promptId, anchored: busy || remembered.anchored };
}

/** Whether the latest turn fills the view: once a prompt is sent after opening, it does from then on. */
export function isAnchoring(opening: Opening, ownLatest: string | undefined): boolean {
  return opening.anchored || ownLatest !== opening.id;
}
