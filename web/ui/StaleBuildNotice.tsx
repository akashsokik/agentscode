import { reloadFor, useStaleBuild } from '../staleBuild.ts';
import { fieldsHaveText } from '../unsent.ts';
import { Kbd } from './Kbd.tsx';
import { TextButton } from './common.tsx';

/**
 * One quiet item in the footer when this page is older than the build the server serves now
 * (web/staleBuild.ts): "PodCode was updated · Reload ⌘R". In the footer's own row and type, flat,
 * theme colours, no box or shadow, so it never covers anything. Reloading keeps composer drafts
 * (web/draftStore.ts); with other text typed somewhere (a dialog), it asks first.
 */
export function StaleBuildNotice() {
  const server = useStaleBuild();
  if (!server) return null;
  const reload = () => {
    // Composer drafts are kept; text in any other field (an issue, a routine, a rename) is not, so ask.
    if (fieldsHaveText() && !window.confirm('Reload PodCode? Text typed outside a composer is not kept.')) return;
    reloadFor(server);
  };
  return (
    <span role="status" className="flex shrink-0 items-center gap-1.5 text-content/60">
      <span>PodCode was updated</span>
      <span aria-hidden className="text-content/30">·</span>
      <TextButton onClick={reload} className="-mx-1 text-[11px] text-content/85">Reload</TextButton>
      <Kbd spec="Mod+R" quiet />
    </span>
  );
}

/** For a window with no room for the notice (the quick composer): only the automatic reload. */
export function StaleBuildWatch() {
  useStaleBuild();
  return null;
}
