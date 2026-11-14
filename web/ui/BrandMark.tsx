import { SUPER_LOOK } from '../../shared/avatar.ts';
import { AvatarGlyph } from './Avatar.tsx';

/**
 * The app's mark at 16px: the SuperAgent's Block (ACH-D63), in the theme's text colour with its eyes
 * in the page colour, still (a logo does not blink). The app icon (build/icon.svg), the favicon
 * (public/favicon.svg) and the menu bar icon (electron/trayMark.ts) draw the same Block on a tile.
 */
export function BrandMark() {
  return <AvatarGlyph look={SUPER_LOOK} animate={false} seed="podcode" className="size-4" />;
}
