/**
 * Agent Settings > General > Avatar: pick a shape, a colour and eyes, or shuffle. Quiet rows of
 * small choices, no boxes; the chosen one carries the selection fill. Saved with the dialog.
 */
import type { ReactNode } from 'react';
import { AVATAR_COLORS, AVATAR_EYES, AVATAR_SHAPES, freshLook, isSuperPair, type AvatarLook } from '../../shared/avatar.ts';
import { AVATAR_FILL, AvatarGlyph } from '../ui/Avatar.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';

const SHAPE_NAMES: Record<AvatarLook['shape'], string> = {
  circle: 'Circle', squircle: 'Squircle', triangle: 'Triangle', pebble: 'Pebble', capsule: 'Capsule', pentagon: 'Pentagon', blob: 'Blob', diamond: 'Diamond',
};
const EYE_NAMES: Record<AvatarLook['eyes'], string> = { round: 'Round eyes', tall: 'Tall eyes', wide: 'Wide eyes' };

function Choice({ selected, label, onPick, disabled = false, children }: { selected: boolean; label: string; onPick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onPick}
      disabled={disabled}
      className={`grid size-8 place-items-center rounded-md transition-colors duration-150 disabled:opacity-30 ${selected ? 'bg-selection' : 'hover:bg-content/6'}`}
    >
      {children}
    </button>
  );
}

export function AvatarPicker({ look, others, onChange }: { look: AvatarLook; others: AvatarLook[]; onChange: (look: AvatarLook) => void }) {
  return (
    <div className="flex flex-col gap-2 px-4 pb-4 pt-1">
      <div className="flex items-center gap-3">
        <AvatarGlyph look={look} seed="preview" className="size-10" />
        <SecondaryButton onClick={() => onChange(freshLook(others))}>Shuffle</SecondaryButton>
      </div>
      <div role="radiogroup" aria-label="Shape" className="flex flex-wrap gap-0.5">
        {AVATAR_SHAPES.map(shape => (
          <Choice key={shape} label={isSuperPair({ shape, color: look.color }) ? `${SHAPE_NAMES[shape]} (the SuperAgent's in this colour)` : SHAPE_NAMES[shape]} disabled={isSuperPair({ shape, color: look.color })} selected={look.shape === shape} onPick={() => onChange({ ...look, shape })}>
            <AvatarGlyph look={{ ...look, shape }} animate={false} className="size-5" />
          </Choice>
        ))}
      </div>
      <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-0.5">
        {AVATAR_COLORS.map(color => (
          <Choice key={color} label={isSuperPair({ shape: look.shape, color }) ? `${color[0].toUpperCase() + color.slice(1)} (the SuperAgent's in this shape)` : color[0].toUpperCase() + color.slice(1)} disabled={isSuperPair({ shape: look.shape, color })} selected={look.color === color} onPick={() => onChange({ ...look, color })}>
            <span aria-hidden className="size-4 rounded-full" style={{ background: AVATAR_FILL[color] }} />
          </Choice>
        ))}
      </div>
      <div role="radiogroup" aria-label="Eyes" className="flex flex-wrap gap-0.5">
        {AVATAR_EYES.map(eyes => (
          <Choice key={eyes} label={EYE_NAMES[eyes]} selected={look.eyes === eyes} onPick={() => onChange({ ...look, eyes })}>
            <AvatarGlyph look={{ ...look, eyes }} animate={false} className="size-5" />
          </Choice>
        ))}
      </div>
    </div>
  );
}
