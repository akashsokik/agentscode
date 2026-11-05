import type { KeyboardEvent } from 'react';

/**
 * A dialog field's keydown handler: Enter in a one-line field, or Cmd/Ctrl+Enter in a text area,
 * does what the dialog's primary button does, when that button is enabled.
 */
export function submitKey(ready: boolean, submit: () => void) {
  return (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.defaultPrevented || !ready) return;
    if (e.currentTarget instanceof HTMLTextAreaElement && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    submit();
  };
}
