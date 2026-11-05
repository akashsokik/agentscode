/**
 * When the transcript follows new output, after MonoCode's AgentTranscript: following stops on
 * your own input (a wheel or key up, a scrollbar drag, a touch pulling the page down) and starts
 * again only once you scroll back down to the very end. A scroll event alone never stops it, since
 * the transcript's own pins and the browser's clamps fire them too, and while an agent works a
 * small upward move inside a margin would otherwise be pulled straight back to the end.
 */

/** The parts of a scroller this reads and writes; an HTMLElement is one. */
export interface ScrollBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** A trackpad gesture can open with an event that has no direction yet; following waits this long for it. */
export const WHEEL_HOLD_MS = 150;
/** Within this of the end, a downward scroll picks following up again. */
const END_PX = 1;

export function distanceFromEnd(box: ScrollBox): number {
  return box.scrollHeight - box.scrollTop - box.clientHeight;
}

/** The browser pulled the offset down to a new, nearer end: content shrank or the view grew. Nobody scrolled. */
export function clampedToEnd(box: ScrollBox, previousTop: number): boolean {
  const end = Math.max(0, box.scrollHeight - box.clientHeight);
  return previousTop > end && Math.abs(box.scrollTop - end) < 1;
}

/** Whether a scroll from `previousTop` to where the box is now leaves the transcript following. */
export function followsAfterScroll(box: ScrollBox, previousTop: number, following: boolean): boolean {
  const movement = box.scrollTop - previousTop;
  if (movement === 0 || clampedToEnd(box, previousTop)) return following;
  // A small move back down while reading near the end does not resume following; reaching the end does.
  return movement > 0 && distanceFromEnd(box) <= END_PX;
}

/** Keys that scroll up. */
export function scrollsUp(key: string, shift: boolean): boolean {
  return key === 'ArrowUp' || key === 'PageUp' || key === 'Home' || (key === ' ' && shift);
}

export class Follower {
  following: boolean;
  /** The offset at the last scroll seen or written, to tell a move from a clamp. */
  private lastTop = 0;
  /** A mouse or pen is down: a scrollbar drag, or a text selection that may scroll. */
  private pointer = false;
  private holdUntil = 0;
  private heldTop: number | undefined;

  constructor(following = true) {
    this.following = following;
  }

  /** A scroll event. Returns whether the transcript is following afterwards. */
  scrolled(box: ScrollBox): boolean {
    if (this.following && !this.pointer) {
      this.lastTop = box.scrollTop;
      return true;
    }
    this.following = followsAfterScroll(box, this.lastTop, this.following);
    this.lastTop = box.scrollTop;
    return this.following;
  }

  /** Notes an offset the transcript set itself, so it is not read as a move later. */
  track(box: ScrollBox): void {
    this.lastTop = box.scrollTop;
  }

  /** Stops following, as your own scroll up does. */
  release(): void {
    this.following = false;
  }

  /** A wheel event that reached the transcript itself, not a scroller inside it. */
  wheel(box: ScrollBox, deltaY: number, now: number): void {
    if (deltaY < 0) this.release();
    else if (deltaY === 0) this.hold(box, now);
  }

  /** Holds following off for a gesture whose direction is not known yet. */
  hold(box: ScrollBox, now: number): void {
    this.heldTop ??= box.scrollTop;
    this.holdUntil = now + WHEEL_HOLD_MS;
  }

  /** The hold ran out: if the gesture moved the view up, it was you scrolling up. */
  holdEnded(box: ScrollBox): void {
    const top = this.heldTop;
    this.heldTop = undefined;
    if (top !== undefined && box.scrollTop < top && !clampedToEnd(box, top)) this.release();
  }

  pointerDown(onScroller: boolean, touch: boolean): void {
    if (!touch) this.pointer = true;
    // Pressing the scroller itself, not its content, is a press on its scrollbar.
    if (onScroller) this.release();
  }

  pointerUp(box: ScrollBox): void {
    if (this.pointer) this.scrolled(box);
    this.pointer = false;
  }

  /**
   * Keeps the end in view if following, for every change of height. The browser can move the
   * view before its scroll event arrives, so that move is reconciled first.
   */
  follow(box: ScrollBox, now: number): void {
    this.scrolled(box);
    if (!this.following || now < this.holdUntil) return;
    box.scrollTop = box.scrollHeight;
    this.lastTop = box.scrollTop;
  }

  /** Following again from here on, as "jump to latest" does before its smooth scroll down. */
  resume(): void {
    this.following = true;
    this.holdUntil = 0;
    this.heldTop = undefined;
  }

  /** Back to the end and following, as sending a message does. */
  pin(box: ScrollBox): void {
    this.resume();
    box.scrollTop = box.scrollHeight;
    this.lastTop = box.scrollTop;
  }
}
