// Text typed outside a composer (a half-typed issue, a routine form, a rename), which a reload
// would lose (web/staleBuild.ts). Composer drafts are kept across a reload (web/draftStore.ts,
// which saves them when the page goes away), so composer textareas carry `data-draft` and are
// left out here; a field with `data-unsent-baseline` (the browser address bar) counts only once
// its text differs from that.
import { typedOutsideComposers, type FieldState } from '../shared/staleBuild.ts';
import { stashDrafts } from './draftStore.ts';

/** The text fields on screen, as the reload decision sees them. */
export function fieldsOnScreen(root: ParentNode = document): FieldState[] {
  const fields: FieldState[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('textarea, input, [contenteditable="true"]')) {
    if (el instanceof HTMLInputElement && !['text', 'search', 'url', 'email', ''].includes(el.type)) continue;
    if ((el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && (el.readOnly || el.disabled)) continue;
    const value = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.textContent ?? '';
    fields.push({ value, draft: el.hasAttribute('data-draft'), baseline: el.getAttribute('data-unsent-baseline') });
  }
  return fields;
}

/** Whether a reload would lose text typed outside a composer. */
export function fieldsHaveText(root: ParentNode = document): boolean {
  return typedOutsideComposers(fieldsOnScreen(root));
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', stashDrafts);
