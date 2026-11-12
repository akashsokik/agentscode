// Text typed outside a composer (a dialog's field, say), counted so a page with any is never
// reloaded on its own (web/staleBuild.ts). Composer drafts are kept in web/draftStore.ts, which
// saves them when the page goes away.
import { stashDrafts } from './draftStore.ts';

/** Whether a text field on screen has text: a composer's (also a draft) or any other (a dialog's, say). */
export function fieldsHaveText(root: ParentNode = document): boolean {
  for (const el of root.querySelectorAll<HTMLTextAreaElement | HTMLInputElement | HTMLElement>('textarea, input, [contenteditable="true"]')) {
    if (el instanceof HTMLInputElement && !['text', 'search', 'url', 'email', ''].includes(el.type)) continue;
    if ((el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && (el.readOnly || el.disabled)) continue;
    const text = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.textContent ?? '';
    if (text.trim()) return true;
  }
  return false;
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', stashDrafts);
