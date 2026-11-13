/**
 * A menu row's fill (ACH-D49), in MonoCode's order (SearchableSelect): the row Enter acts on,
 * highlighted or holding keyboard focus, has the strong selection fill; the value in force
 * (current, or selected with its check) steps down to a quiet fill, so the two never look alike.
 * Rows that are neither show the hover tone. No rings: focus shows as a fill (styles.css).
 */
export function menuRowTone({ danger = false, keyboard = false, quiet = false }: { danger?: boolean; keyboard?: boolean; quiet?: boolean }): string {
  if (danger) return 'text-danger hover:bg-danger/10 focus-visible:bg-danger/10';
  if (keyboard) return 'bg-selection text-content';
  return `${quiet ? 'bg-content/4 ' : ''}text-content hover:bg-content/5 focus-visible:bg-selection`;
}
