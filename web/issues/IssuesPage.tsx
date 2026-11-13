import { CircleDashed } from '../mono/icons.tsx';
import { PaneFrame, type PaneChrome } from '../panes/PaneFrame.tsx';
import { Empty } from '../ui/common.tsx';

// A stub so the sidebar's "Issues" entry has somewhere to go (ACH-D42). Fen owns this file and
// web/issues/** from here on, and replaces it with the full Issues page in phase 3 (ACH-D43).
export function IssuesPage({ chrome }: { chrome: PaneChrome }) {
  return (
    <PaneFrame chrome={chrome} title={<span className="flex items-center gap-2"><CircleDashed className="size-3.5 text-content/55" strokeWidth={1.75} /><span className="text-content">Issues</span></span>}>
      <Empty icon={CircleDashed} title="The Issues page is on its way">
        The full Linear-style list comes next. Meanwhile, the SuperAgent's Issues tab in the right panel lists them.
      </Empty>
    </PaneFrame>
  );
}
