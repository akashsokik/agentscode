// The calendar mark in front of the due date (ACH-D46 date A): hugeicons' Calendar03, deep-imported
// like the rest of the set (web/mono/icons.tsx), in its stroke.
import { HugeiconsIcon } from '@hugeicons/react';
import Calendar03Icon from '@hugeicons/core-free-icons/Calendar03Icon';

export function CalendarGlyph({ className = '' }: { className?: string }) {
  return <HugeiconsIcon icon={Calendar03Icon} aria-hidden className={`size-3.5 shrink-0 ${className}`} strokeWidth={1.75} />;
}
