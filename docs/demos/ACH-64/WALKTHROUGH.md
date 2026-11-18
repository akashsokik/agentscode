# Settings / Storage — approval preview

## Overall storage and the largest agents

Image: `storage-overview.png`

A Storage section under PodCode, using MonoCode's existing Settings rail and flat row cards. The read-only snapshot totals14.45GiB. Agent folders, worktrees and shared data are counted once. Agents are sorted by size, with home/memory, workspace and worktrees separately labelled.

## Shared data and honest ownership

Image: `storage-shared.png`

Transcripts, channels, attachments, archive, project notes, state.json and other app data remain visible. This snapshot has253.8MiB of worktrees without a current agent owner record, so the preview shows them as unassigned instead of guessing. Every per-agent worktree count is0B in this measured snapshot.

## Proposed management actions

Image: `manage-proposal.png`

Reveal in Finder would only open a folder. Review clean up is a proposal: review selected merged worktrees/build outputs, ask first, and verify a backup before removing anything. No filesystem actions run in this demo.

## Light appearance

Image: `storage-light.png`

The same Settings layout follows the existing light theme. Search, Refresh and proposal previews are interactive. Refresh explains that this standalone file is a recorded snapshot.

Approval request: approve the layout and which manage proposal(s), then implement live async measurement and the approved actions. No app change is live yet.
