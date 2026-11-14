// The Avatars setting (Appearance: Colour or Ink, ACH-46, ACH-D64), as values: no DOM, so it is
// tested directly (web/avatarStyle.ts stores it, web/ui/Avatar.tsx draws it).
import { AVATAR_FILL, AVATAR_INK, AVATAR_LEAD_INK, type AvatarLook, type AvatarPart } from '../shared/avatar.ts';

export type AvatarStyle = 'colour' | 'ink';

/** The stored choice: anything unknown (or nothing yet) is Colour, the default. Pure, tested. */
export function parseAvatarStyle(value: string | null): AvatarStyle {
  return value === 'ink' ? 'ink' : 'colour';
}

/**
 * An avatar drawn in ink, the SuperAgent included (ACH-D64): its body in the theme's text colour and
 * its eyes in the page colour (AVATAR_LEAD_INK, the ink ACH-D60 gave the SuperAgent). Shapes, moods
 * and tilt stay as they are; only the fills change. Pure, tested.
 */
export function inkParts(parts: readonly AvatarPart[]): AvatarPart[] {
  return parts.map(part => ({ ...part, fill: part.kind === 'body' ? AVATAR_LEAD_INK.body : AVATAR_LEAD_INK.eye }));
}

/**
 * An avatar drawn in colour, the SuperAgent included (ACH-D64): its body in its own colour and the
 * near-black pills every teammate has. The SuperAgent's Block then takes its violet back (the colour
 * it had before ACH-43); everyone else is drawn as avatarParts already draws them. Outside the app
 * (the logo, the tray and notification icons) the SuperAgent stays ink: those draw avatarParts
 * directly. Pure, tested.
 */
export function colourParts(look: AvatarLook, parts: readonly AvatarPart[]): AvatarPart[] {
  return parts.map(part => ({ ...part, fill: part.kind === 'body' ? AVATAR_FILL[look.color] : AVATAR_INK }));
}
