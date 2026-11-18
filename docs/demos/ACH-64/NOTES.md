# ACH-64 — Settings / Storage, phase 1

## Current design: ACH-D89 rework

This revision supersedes the first row-led preview (262cd2c). One horizontal stacked bar shows the entire recorded14.45GiB total, with a large total above and a wrapping inline dot/name/size legend beneath. Each agent uses its actual saved avatar colour, derived read-only from current state metadata through shared/avatar.ts agentLook(agent) and AVATAR_FILL, including saved avatar overrides and the SuperAgent role. Bar segments, legend dots and row dots share that exact colour. Shared data and unassigned worktrees use quiet greys. The bar’s Other groups project metadata,state.json and other app data; their separate rows remain below. Free disk space is not shown.

Agents are quiet dot/name/size disclosure rows, collapsed initially; opening shows home/memory, workspace and worktrees. There is no per-row bar or main table. The existing MonoCode Settings shell, PageHeader and supporting groups remain unchanged.

Segments are proportional to exact bytes, with no artificial minimum width: tiny categories can be subpixel. The inline legend preserves every category and its size, including Channels0B; only nonzero categories draw a segment. There are17legend items and16nonzero segments, whose byte sum equals the overall total. Hover or keyboard focus shows category/name and size; Escape dismisses it.

References: ACH-D89 (user redirect); [Apple Storage settings](https://support.apple.com/guide/mac-help/change-storage-settings-mchl3d437fbc/mac) and [Apple storage overview](https://support.apple.com/en-us/102624). The user requested the one-bar/legend feel, while D83 remains the Settings shell reference.

Production reuse additions: inline flex segment markup within the existing Storage view, with shared/avatar.ts agentLook/AVATAR_FILL for colours; web/ui/HoverCard.tsx for hover/focus placement, delay and Escape; web/mono/RevealHeight.tsx for existing expansion mechanics if animated. No new generic component is proposed. Standalone HTML uses native details and a small tooltip simulation only; no production component was added.

Rework validation: one bar,0tables,all11agent disclosures initially closed,16positive-byte segments and17legend entries,proportions sum100%; agent colours equal the saved-avatar colour source. Hover/Fen reads Fen·4.71GiB, keyboard focus also exposes it and Escape hides it. Expansion, search (Fen=>1agent), Refresh, proposal modals and dark/light previews work. No page errors, no horizontal overflow at390/768/1280px,0computed shadows. Arithmetic/source checks and node --check pass. No app tests run for this documentation-only rework.

Current images: storage-overview.png (bar/legend/quiet rows),storage-expanded.png (Fen open),storage-hover.png (segment hover),storage-light.png,storage-shared.png,manage-proposal.png and full-page storage.png. All initial PNG paths have been refreshed; they no longer show the superseded primary table-like layout.


Demo only. Base: `92638f7ca8f2da8729a4406ded733ba778b26b6c` (main and origin/main matched after `git fetch origin --tags` and `git merge --ff-only origin/main`). Branch: `feat/ACH-64-settings-storage`. Issue-key branch naming takes precedence over the task's shorter `feat/settings-storage` example. No application source changed. No push, merge, restart or deletion.

Open `storage.html` directly in a browser. It is standalone, with inline CSS, inline avatars/icons, and no external requests. `?theme=light` previews light mode. Search filters settings rows. Refresh explains that this is a recorded snapshot, without falsifying the measured timestamp. Reveal and clean up open proposal previews; neither accesses the file system. Back/other nav items explain that this preview includes Storage only.

## Reference and reuse

The historical `/private/tmp/monocode` is now an empty source-directory skeleton, not a usable checkout. Read a fresh temporary public checkout `/private/tmp/ach64-monocode-reference`, commit `09d04436babb39ad72198cdf22f735067027fc04`:

- `src/app/shell/SettingsRail.tsx`: SettingsNav and NavRow, grouped gap-5 rail; text-sm medium labels; inactive content/50, active bg-selection; 16px icons; Back at the foot.
- `src/features/settings/ui/SettingsView.tsx:613`: 40px header, max-w-5xl body with px-8/py-8.
- `SettingsView.tsx:4371`: PageHeader, 20px title and 13px content/45 description.
- `SettingsView.tsx:4396`: Group, 13px semibold heading/12px description; rounded-xl bordered card and bg-content/3.
- `SettingsView.tsx:4441`: Row, px-4 py-3.5, 13px label, 12px description, border-b content/5, right-aligned controls up to60% width.
- MonoCode has Worktrees and Archive settings plus provider account-usage views (`UsageDisplaySettings`, `ProviderAccountUsage`), but no disk-storage summary in the inspected SettingsView/WorktreesPage. Provider usage is rate-limit/account usage, not disk use. Use the existing Settings row language, rather than relabelling its meters.

The demo inlines PodCode's compiled CSS and mirrors those exact existing class strings. The standalone document overrides only the app-level fixed-body shell so the page scrolls normally. Icons and avatars were rendered from the actual existing source. Attribution: MonoCode by Nick, MIT; see repository NOTICE.

Phase2 reuses these existing files/components (ACH-N40/N41/N42):

- `web/panes/SettingsPage.tsx`: existing page shell, PageHeader and SettingsSearch. Add a Storage branch within this page.
- `web/sidebar/Sidebar.tsx`: existing SettingsNav/RailAction; add Storage to the PodCode group via `web/settingsSections.ts` and `web/settingsIndex.ts`.
- `web/mono/settings.tsx`: Group and Row, unchanged.
- `web/mono/SecondaryButton.tsx`: Refresh, Reveal and review actions.
- `web/ui/common.tsx`: HeaderButton if a compact reveal action is needed.
- `shared/avatar.ts`: agentLook and AVATAR_FILL for the agent-colour dots; no avatar face in the quiet row (D89).
- `web/mono/icons.tsx`: FolderTree, FolderOpen, RefreshCw, Archive, all existing.
- `web/mono/Modal.tsx`: proposal/confirmation dialog; no separate dialog primitive.
- `web/ui/StatusMark.tsx`: pending state while a live scan is running; no new spinner.

No new generic UI component is needed. A Storage-specific render function in SettingsPage composes these primitives. No shortcut hints, shadows, gradients or one-sided accent marks. Structural rail/header/card separators match the reference.

## Measured data

Read-only measurement on18Nov2026 at21:34UTC. `du -k -d 2 ~/.podcode`, then `du -sk` for each agent home, its workspace and each shared root entry. No contents of credentials or transcripts read. Only state.json agent name/id/worktree metadata was read for attribution. No live server or real-provider turns were started. All filesystem measurement commands are read-only.

`du` reports allocated KiB, converted to bytes with1024; UI uses binary GiB/MiB/KiB. This is an estimate of allocated disk usage, not guaranteed reclaimable APFS space. Symlinks are not followed. Large symlinked node_modules targets outside managed folders therefore do not inflate their workspace totals.

The captured totals reconcile exactly:

- Total:15,520,436,224 bytes =14.45GiB.
- Eleven agent homes, including each private workspace exactly once:15,123,619,840 bytes =14.08GiB.
- Unassigned worktrees:266,166,272 bytes =253.8MiB.
- Shared data:130,650,112 bytes =124.6MiB.
- Agents + unassigned worktrees + shared = total, with0byte difference.

`Home / memory` is agents/id excluding its workspace. `Workspace` includes local builds and manually created checkouts inside that workspace. The server's current state has no registered `agent.worktree` for any measured agent, so per-agent Worktrees is honestly0B; the253.8MiB worktrees root is shown as unassigned, not guessed onto an agent. This makes the snapshot realistic without inventing nonzero attributed worktrees. Original project checkouts outside PodCode data are excluded. Shared transcripts and attachments are in their named shared categories, not added to agent-row totals.

`snapshot.json` contains only names, aggregated sizes and measurement time, with no absolute machine paths, tokens, transcript text or agent ids. Data can change after measurement; the demo deliberately keeps its timestamp and totals fixed. Refresh is a preview, not a fresh scan.

## Proposed server implementation after approval

1. Add a storage service beside Store/AgentHomes. Inputs are the configured Store.dataDir, manager worktreesRoot and agent ownership metadata. Read the layout from `server/store.ts:27`, `server/manager.ts:265-278`, `server/agentHome.ts`, `server/worktrees.ts`, `server/superAgent.ts` and `server/projectRefs.ts`; do not assume the directory is always ~/.podcode.
2. Use fs.promises.opendir/lstat with bounded I/O concurrency and periodic yields. Avoid synchronous recursive walking on the server event loop. Use lstat, never follow symbolic links. Sum blocks*512 when supported (with a documented apparent-size fallback), and deduplicate hard links by device/inode across the scan. Track already visited roots so nested paths cannot count twice. APFS clones/compression are not a promise of reclaimable bytes.
3. Attribute registered worktree.path roots to their agent; resolve registered subproject cwd to its worktree root. Prefer persisted ownership records when available. A worktree nested in a workspace is measured once: subtract its subtree from Workspace if shown in Worktrees. Do not infer ownership from a branch slug alone. Stale/unregistered roots remain visible as unassigned; unknown agent directories also stay in the total. Original shared project checkouts are excluded; an agent merely running there does not own their bytes.
4. Cache one snapshot with measuredAt/startedAt/completedAt, per-agent categories, shared categories, unassigned bytes and partial/error state. A60-second freshness window and a single in-flight scan prevent duplicate work. GET returns the cached snapshot immediately; Refresh queues a scan, preserves the previous values with a pending StatusMark, then swaps in one consistent completed result. Coalesce concurrent refreshes and cancel on server shutdown. Report permission-denied/disappearing roots as partial instead of silently calling them0B. Publish scan progress only at coarse intervals; no disk walk on every websocket snapshot.
5. Use existing user authentication and user-only settings endpoints (not an agent tool exposing other agents' filesystem contents). Return aggregate sizes only. Fixture tests cover symlinks, hard links, nested workspace/worktree roots, unknown ownership, deleted/inaccessible roots, cache/coalescing and exact subtotal reconciliation. Add UI tests for sorting, timestamp, pending/partial/error states and Settings search. No production code is part of this phase.

## Manage proposals — require approval of scope

1. **Reveal in Finder:** open a managed agent folder or data directory using the existing desktop reveal/open path flow. Does not remove files. Agent-row folder icons are part of this proposal.
2. **Review clean up:** show candidate merged worktrees and recognised build outputs, owner/path/allocated size and clean/merged status. Start with nothing selected. Revalidate paths, active agent use, dirty state and merge status immediately before an operation. Ask before every confirmed selection. Create and verify a restorable backup before removing anything; show its location, retention and disk cost. Never automatically delete that backup. Exclude unknown/unassigned folders and original repositories until reviewed. Never remove memory, transcripts or credentials as build leftovers.

Both are proposals, not implemented cleanup or disk actions. A backup retains disk usage until the user removes it; do not label the candidate size as space instantly reclaimed. No new generic UI primitive is proposed; if a future cleanup flow cannot fit existing Modal/Row/SecondaryButton, return to the user before adding one.

## Validation and screenshots

Browser opened the standalone file directly; no server needed. Search for Fen returns one agent row, Refresh retains the original timestamp, both proposal dialogs open, Close/Escape dismiss. No page errors after fixes. Horizontal scrollWidth equals clientWidth at390/768/1280px. Eleven agent rows, zero computed box shadows, zero kbd hints, zero external assets. Arithmetic validation: all agent subcategories and stacked-bar parts reconcile, ordering descending and overall total exact. Full application tests were not run because no application source changed.

- `storage.png`: full dark page.
- `storage-overview.png`:1280x1000 overview and largest agents.
- `storage-shared.png`: shared-data section.
- `storage-light.png`: same layout in light mode.
- `manage-proposal.png`: cleanup proposal preview.

`WALKTHROUGH.md` provides image steps for the lead to publish. Publication is intentionally not attempted by this delegated agent: create_walkthrough allows a direct user request only. No published walkthrough id is claimed.
