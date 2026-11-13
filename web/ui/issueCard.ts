// The issue chip's card text (web/ui/IssueKeyChip.tsx, ACH-33), pure so it is tested directly.

/** A description's first lines as plain words, for the card's gist (the card clamps it to three lines). */
export function issueGist(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|`|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

/** "Updated 4h 36m ago", or "Updated just now", from relativeTime's words (web/format.ts). */
export function updated(ago: string): string {
  return ago === 'now' ? 'Updated just now' : `Updated ${ago} ago`;
}

