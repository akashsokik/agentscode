# ACH-67: approved Work sheet implementation

Base: local main `a9157e0` (six commits ahead of origin at start). Fetched origin before branching `feat/ACH-67-overview-build`; did not reset or push local main. Demo reference: `954b55c`, concept A (ACH-D98). This implements the real web panel and retains the approved tab menu (ACH-D92).

## Change

- Agent header, current state and elapsed time, task title/activity, reported plan steps with segmented progress, Needs you, one Produced list and the action footer.
- SuperAgent Overview shows live member rows and a team output list, including its own authored outputs. Its own pending approvals are included in attention counts. Issues/PR context keeps the SuperAgent tabs as before.
- No model/engine header, usage wall, memories or handoff categories. No boxed Overview cards, shadows or colored edge rules. RefChip and its neighbors are untouched (Hal owns ACH-72).
- Questions reuse exported QuestionPrompt and its existing QuestionForm/resolveApproval path; simple single questions with short options can be answered inline. Other/custom answers and complex questions use the existing form. Tool/plan approvals reuse exported ApprovalRow in compact flat mode, retaining command details/scope, explicit allow/deny, optional denial note and existing always-allow semantics. Existing transcript/composer presentation stays default.
- Tabs use existing ContextMenu/MenuRow, IconTab, HeaderButton and fitPanelTabs. MenuRow/ContextMenu gained checkbox semantics and checkbox keyboard traversal. Preferences live in the existing persisted layout, separately per agent/SuperAgent panel. The open tab and last configured tab are guarded. A hidden view opened from CommandPalette is transient; leaving it re-hides it. Overflow fits only configured plus active views. Reset restores that panel type.
- Footer Message opens the agent and focuses its existing composer; Stop uses api.stop; diff opens the current first changed file in the existing diff view; branch opens existing Work/project/branch selection. No new generic UI component.

## ACH-73 contract and integration status

Coordinated file ownership with Ada by PodCode message before data integration. Read her concrete shared/types.ts + server/app.ts contract read-only and sent acceptance:

- `Agent.plan?: {steps:{text,status:'done'|'active'|'pending'}[],updatedAt,engine:'claude'|'codex'} | null`.
- `GET /api/agents/:id/produced -> {at,where,commits,uncommitted,walkthroughs,reports}` (exact structural fallback in overviewModel.ts).

Ada owns server/shared types; this UI commit edits neither. Her commit is not merged here. Therefore UI adapter uses typed structural fallback and omits absent/unavailable data. The final combined server/UI integration must be checked after ACH-73 lands; this evidence does **not** claim verification of her server normalization or git attribution.

Plan rendering rejects missing, malformed, empty and stale-current-turn records. Remaining steps are never marked complete merely because an agent became idle. No overall percentage or ETA. Outputs distinguish current uncommitted snapshots (and unknown attribution in shared checkouts), commits, authored walkthroughs and agent-reported results. A blocked report alone is not treated as a user approval. A waiting agent with no loaded approval directs the user to its conversation rather than saying nothing is waiting.

Output requests only run while Overview is mounted, refresh every 15 seconds, and cap team concurrency at 3; activity text changes do not cause repeated git requests. Old requests cannot repopulate a different selection. Team items are deduplicated by stable IDs and capped at the 12 most recent. Output navigation uses existing layout/Work/diff/walkthrough/Comms flows.

## Tests and verification

Commands on this UI tree:

- `npm run typecheck`: exit 0 (web, server and desktop configs).
- `npm test`: 1,146 passed, 0 failed/cancelled/skipped. Includes the full existing suite, not only the new tests.
- `npm run build`: exit 0.
- `git diff --check`: clean.

New tests:

- `tests/panelTabVisibility.test.ts`: malformed/old saved config, canonical order, active and last view protection, transient reveal, per-panel persistence/reset, keyboard/overflow filtering.
- `tests/overviewPresentation.test.ts`: working/waiting/idle/error, elapsed/unknown start, stale current-task handling.
- `tests/overviewData.test.ts`: absent/stale/malformed/current plans, idle preservation, uncommitted vs shared attribution and reported result labeling.

Built UI was served by the real createServer on **127.0.0.1:4777** against a fresh temporary HOME/PODCODE_HOME and a fresh temporary Git project/worktrees. FakeRunner prevented provider calls; superWake was disabled. Used actual UserKey one-time login. `fixture.mts` documents the setup. No real user data was read or mutated.

Rendering tests use the agreed ACH-73 contract fixtures: plan fields are seeded on fixture agents; produced HTTP responses are fulfilled by Playwright from fixture JSON. Real snapshots, git status/diff, approvals and all built UI are served by the real temp server. This is a UI contract/render test, not an end-to-end test of Ada's backend. Fixture identity/counts/timestamps differ from the static demo (for example, one real uncommitted fixture file rather than four). User-controlled avatar style remains in force; Ink was selected only in this browser fixture.

Browser assertions passed:

1. Working shows 3/5 reported plan steps, task, current activity and mixed Produced list.
2. Waiting shows inline choices; Idle hides an absent plan; SuperAgent shows each fixture member plus team output.
3. An inline answer hit the **real** `POST /api/approvals/demo-question` with HTTP 200 and `answers['Which empty state should the search use?'] === 'Keep the helpful hint'`.
4. Message focused the existing composer; Open diff opened SearchView.tsx from the temporary worktree.
5. Checkbox menu/current guard and arrow focus worked; Notes stayed hidden after reload.
6. Command palette opened hidden Notes; leaving it hid Notes again; Reset restored it.
7. Narrow overflow excluded user-hidden Notes.
8. Final four-state capture run reported no page exceptions. Initial screenshot failures/partial animations were corrected; final comparison images assert both embedded images loaded.

Temporary server stopped after capture. No live app restart, local main merge or push. Review and combined ACH-73 validation remain for the coordinator.

## Screenshots

All relative to this directory:

- `working-app.png`, `waiting-app.png`, `idle-app.png`, `team-app.png`: built app with the Work sheet.
- `working-panel.png`, `waiting-panel.png`, `idle-panel.png`, `team-panel.png`: cropped real panel at 372px.
- `demo-working-panel.png`, `demo-waiting-panel.png`, `demo-idle-panel.png`, `demo-team-panel.png`: approved concept A reference.
- `comparison-working.png`, `comparison-waiting.png`, `comparison-idle.png`, `comparison-team.png`: demo vs built UI. Adjacent HTML comparison pages reproduce the arrangement with local images.
- `tab-menu.png`, `narrow-overflow.png`: real tab menu and overflow.

## Replay rendering

With dependencies installed, build the app, then run `node docs/demos/ACH-67/build/fixture.mts` from the repo. It prints a temporary login URL, fixture IDs and `produced` JSON. Keep provider runners fake. For pre-ACH-73 UI-contract replay, Playwright fulfills only `**/api/agents/*/produced` with that JSON keyed by agent ID. Set `podcode:avatars` to `ink` and `podcode:layout` to open the chosen agent, `rightPanel:true`, `rightView:'overview'`, `superView:'overview'`, width `panel:372`. Navigate and capture the actual built panel. Once ACH-73 is integrated, remove the route fulfillment and seed real normalized plan/output evidence instead.
