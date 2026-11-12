import { formatKeys, type KeySpec } from '../keys.ts';
import { IS_MAC } from '../platform.ts';

/**
 * A keyboard shortcut (ACH-D26): one chip for every shortcut the app shows, so they all read the
 * same. `spec` is written once for every platform ('Shift+Mod+Enter') and shown as key symbols
 * on a Mac ('⇧⌘⏎'), short words elsewhere ('Ctrl+Shift+Enter'). Filled where it sits in running
 * text, such as the composer's footer (Composer's KeyHint look); `quiet` in menus and lists, where
 * it sits at the end of a row.
 */
export function Kbd({ spec, quiet = false, className = '' }: { spec: KeySpec; quiet?: boolean; className?: string }) {
  return (
    <kbd
      className={`inline-flex shrink-0 items-center whitespace-nowrap font-sans text-[11px] leading-4 ${
        quiet ? 'text-content/40' : 'rounded bg-content/[0.07] px-1 text-content/55'
      } ${className}`}
    >
      {formatKeys(spec, IS_MAC)}
    </kbd>
  );
}
