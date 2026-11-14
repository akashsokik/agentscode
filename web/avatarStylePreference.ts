// The Avatars setting (Appearance: Colour or Ink, ACH-46, ACH-D62), as values: no DOM, so it is
// tested directly (web/avatarStyle.ts stores it, web/ui/Avatar.tsx draws it).
import { AVATAR_LEAD_INK, type AvatarPart } from '../shared/avatar.ts';

export type AvatarStyle = 'colour' | 'ink';

/** The stored choice: anything unknown (or nothing yet) is Colour, the default. Pure, tested. */
export function parseAvatarStyle(value: string | null): AvatarStyle {
  return value === 'ink' ? 'ink' : 'colour';
}

/**
 * An avatar drawn in ink: every agent the way the SuperAgent is (ACH-D60), its body in the theme's
 * text colour and its eyes in the page colour (AVATAR_LEAD_INK). Shapes, moods and tilt stay as
 * they are; only the fills change. Pure, tested.
 */
export function inkParts(parts: readonly AvatarPart[]): AvatarPart[] {
  return parts.map(part => ({ ...part, fill: part.kind === 'body' ? AVATAR_LEAD_INK.body : AVATAR_LEAD_INK.eye }));
}
