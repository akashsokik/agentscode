# ACH-67: approved Work sheet implementation

Current status: integrated Produced-only ACH-73 tip `e922f4b` on this feature branch; uses shared AgentProduced with fresh-on-open requests. Real-backend fixture validation and 1,158 tests passed, including the team review fixes below. No plans, main merge, restart or push. See final integration section below.

Base: local main `a9157e0` (six commits ahead of origin at start). Fetched origin before branching `feat/ACH-67-overview-build`; did not reset or push local main. Demo reference: `954b55c`, concept A (ACH-D98), updated by the later ACH-D100 decision: no plan steps or step bars. This implements the real web panel and retains the approved tab menu (ACH-D92). Initial implementation 9da5158 is superseded by the D100 follow-up; integrate the branch tip, not 9da alone.

## Change

- Agent header, current state and elapsed time, task title/activity, Needs you, one Produced list and the action footer.
- SuperAgent Overview shows live member rows and a team output list, including its own authored outputs. Its own pending approvals are included in attention counts. Issues/PR context keeps the SuperAgent tabs as before.
- No model/engine header, usage wall, memories or handoff categories. No boxed Overview cards, shadows or colored edge rules. RefChip and its neighbors are untouched (Hal owns ACH-72).
- Questions reuse exported QuestionPrompt and its existing QuestionForm/resolveApproval path; simple single questions with short options can be answered inline. Other/custom answers and complex questions use the existing form. Tool/plan approvals reuse exported ApprovalRow in compact flat mode, retaining command details/scope, explicit allow/deny, optional denial note and existing always-allow semantics. Existing transcript/composer presentation stays default.
- Tabs use existing ContextMenu/MenuRow, IconTab, HeaderButton and fitPanelTabs. MenuRow/ContextMenu gained checkbox semantics and checkbox keyboard traversal. Preferences live in the existing persisted layout, separately per agent/SuperAgent panel. The open tab and last configured tab are guarded. A hidden view opened from CommandPalette is transient; leaving it re-hides it. Overflow fits only configured plus active views. Reset restores that panel type.
- Footer Message opens the agent and focuses its existing composer; Stop uses api.stop; diff opens the current first changed file in the existing diff view; branch opens existing Work/project/branch selection. No new generic UI component.

## ACH-73 contract (initial UI-only phase)

Coordinated file ownership with Ada by PodCode message before data integration. Read her concrete shared/types.ts + server/app.ts contract read-only and sent acceptance:

- `GET /api/agents/:id/produced -> {at,where,commits,uncommitted,walkthroughs,reports}` (exact structural fallback in overviewModel.ts).

Ada owns server/shared types. This paragraph records the initial UI-only phase; the combined validation below supersedes its integration limitation. Her commit was not merged during that initial phase. Therefore UI adapter uses a typed Produced structural fallback and omits unavailable output. ACH-D100 drops all plan data from both workstreams; the UI has no plan field, parser, collector, segmented meter or step list. The final combined server/UI integration must be checked after ACH-73 lands; this evidence does **not** claim verification of her server git attribution.

Now shows task/activity and elapsed time only, for every engine. No steps, bar, percentage or ETA. Claude’s disabled todo tool remains untouched. Outputs distinguish current uncommitted snapshots (and unknown attribution in shared checkouts), commits, authored walkthroughs and agent-reported results. A blocked report alone is not treated as a user approval. A waiting agent with no loaded approval directs the user to its conversation rather than saying nothing is waiting.

Output requests only run while Overview is mounted, refresh every 15 seconds, and cap team concurrency at 3; activity text changes do not cause repeated git requests. Old requests cannot repopulate a different selection. Team items are deduplicated by stable IDs and capped at the 12 most recent. Output navigation uses existing layout/Work/diff/walkthrough/Comms flows.

## Tests and verification

Initial UI-only checks (the final combined result is below):

- `npm run typecheck`: exit 0 (web, server and desktop configs).
- `npm test`: 1,144 passed, 0 failed/cancelled/skipped. Includes the full existing suite, not only the new tests.
- `npm run build`: exit 0.
- `git diff --check`: clean.

New tests:

- `tests/panelTabVisibility.test.ts`: malformed/old saved config, canonical order, active and last view protection, transient reveal, per-panel persistence/reset, keyboard/overflow filtering.
- `tests/overviewPresentation.test.ts`: working/waiting/idle/error, elapsed/unknown start, stale current-task handling.
- `tests/overviewOutputRows.test.ts` (renamed before combining Ada’s server test of the original name): uncommitted vs shared attribution and reported result labeling. The former plan tests were removed with plan UI, per ACH-D100.

Built UI was served by the real createServer on **127.0.0.1:4777** against a fresh temporary HOME/PODCODE_HOME and a fresh temporary Git project/worktrees. FakeRunner prevented provider calls; superWake was disabled. Used actual UserKey one-time login. `fixture.mts` documents the setup. No real user data was read or mutated.

Rendering tests use the agreed ACH-73 contract fixtures: produced HTTP responses are fulfilled by Playwright from fixture JSON. Real snapshots, git status/diff, approvals and all built UI are served by the real temp server. This is a UI contract/render test, not an end-to-end test of Ada's backend. Fixture identity/counts/timestamps differ from the static demo (for example, one real uncommitted fixture file rather than four). User-controlled avatar style remains in force; Ink was selected only in this browser fixture.

Browser assertions passed:

1. Working shows task/activity/elapsed and mixed Produced list. All four states assert no meter and no plan-step text.
2. Waiting shows inline choices; Idle shows the last result; SuperAgent shows each fixture member plus team output.
3. An inline answer hit the **real** `POST /api/approvals/demo-question` with HTTP 200 and `answers['Which empty state should the search use?'] === 'Keep the helpful hint'`.
4. Message focused the existing composer; Open diff opened SearchView.tsx from the temporary worktree.
5. Checkbox menu/current guard and arrow focus worked; Notes stayed hidden after reload.
6. Command palette opened hidden Notes; leaving it hid Notes again; Reset restored it.
7. Narrow overflow excluded user-hidden Notes.
8. Interaction checks reported no page exceptions. Final captures use an isolated browser context with fixture layout injected before app startup, then assert each expected agent header and 372px panel width before capture. This corrects a bootstrap layout race in an earlier screenshot pass. Final comparison images assert both embedded images loaded.

Temporary server stopped after capture. No live app restart, local main merge or push. Independent review remains for the coordinator. Combined ACH-73 validation was completed in the later phase below.

## Screenshots

All relative to this directory:

- `working-app.png`, `waiting-app.png`, `idle-app.png`, `team-app.png`: built app with the Work sheet.
- `working-panel.png`, `waiting-panel.png`, `idle-panel.png`, `team-panel.png`: cropped real panel at 372px.
- `demo-working-panel.png`, `demo-waiting-panel.png`, `demo-idle-panel.png`, `demo-team-panel.png`: approved concept A reference.
- `comparison-working.png`, `comparison-waiting.png`, `comparison-idle.png`, `comparison-team.png`: demo vs built UI. Adjacent HTML comparison pages reproduce the arrangement with local images.
- `tab-menu.png`, `narrow-overflow.png`: real tab menu and overflow.

## Replay rendering

With dependencies installed, build the app, then run `node docs/demos/ACH-67/build/fixture.mts` from the repo. It prints a temporary login URL, fixture IDs and `produced` JSON. Keep provider runners fake. For pre-ACH-73 UI-contract replay, Playwright fulfills only `**/api/agents/*/produced` with that JSON keyed by agent ID. Set `podcode:avatars` to `ink` and `podcode:layout` to open the chosen agent, `rightPanel:true`, `rightView:'overview'`, `superView:'overview'`, width `panel:372`. Navigate and capture the actual built panel. Once ACH-73 is integrated, remove the route fulfillment and seed real output evidence instead.

## Latest decision update

ACH-D100 was discovered in current refs during handoff and read in full before finishing. It supersedes the step-bar part of ACH-D98. Final screenshots were regenerated from the rebuilt no-plan UI. Comparisons intentionally label the old A demo as a historical reference; its steps/bar are not part of the final approved implementation. Full suite re-run after removal: 1,144/1,144, typecheck/build passed.

## Compact/full action parity follow-up

`approvalVariants.tsx` mounts the actual exported QuestionPrompt, QuestionForm and ApprovalRow in real React/DOM. Only `api.resolveApproval` is replaced by a recorder; unexpected network calls fail. Eight scenarios run with both compact=false and compact=true: short option, custom answer, skipped question, Allow, Always allow, denial with a trimmed note, plan approval and multiselect form submission. Checks assert identical approval IDs and decisions, no action on mount, and no early decision while a denial note or multiselect answer is being entered. Existing approval of a proposed plan is separate from the removed agent progress-plan collection.

Replay without a server:

```sh
node tests/ui/buildApprovalVariants.mts /tmp/ach67-approval-variants
```

Open the printed local file in a browser. An automation client must wait for `body[data-result]`, assert `data-result="passed"`, and parse the body's JSON. A failed assertion reports `data-result="failed"` and its error. This is a browser regression, separate from the Node `npm test` suite. The fixture is outside tests/ so the server-only TypeScript project does not treat DOM/JSX as server code; its builder is checked by the server project. The fixture itself was checked with `tsc --ignoreConfig --noEmit --target es2022 --lib es2023,dom,dom.iterable --module esnext --moduleResolution bundler --jsx react-jsx --strict --allowImportingTsExtensions --skipLibCheck --types vite/client docs/demos/ACH-67/build/approvalVariants.tsx`.

Fresh isolated browser result: 8 passed, 0 failed; each scenario exercises both variants; no page exceptions. Product typecheck and the fixture's explicit typecheck passed. No product source or RefChip changes in this follow-up. The preceding 1,144-test suite/build result still covers the identical product tree.

## Whole tab labels at narrow widths

Follow-up to the 320px chip screenshot: the existing grid-width reveal interpolates from 0fr to 1fr, so a correctly fitted label can still cut through a letter for part of its 200ms transition. The built pre-fix app reproduced that: Notes text measured 33.40625px while its overflow-hidden container traversed widths 0.8671875px through 27.765625px in sampled frames. This was transient; a settled 320px label was whole. `label-before-transition-320.png` freezes an actual pre-fix transition at 175ms for illustration (the outgoing Comms word is visibly partial).

IconTab now renders an explicitly fitted showLabel as a whole, non-shrinking word or no word. Only RightPanel passes showLabel, so the existing animations of uncontrolled tabs elsewhere are retained. The fit order is unchanged: other names, then other tabs into overflow, then the active name only if necessary. Badge width estimates now account for every digit instead of assuming a one-digit count. The boundary regression proves one pixel below the minimum drops the entire active name while retaining its icon. RefChip remains untouched.

`tests/ui/panelTabLabels.browser.mjs` exports checkPanelTabLabels(page, spec) for an authenticated fresh Playwright context against fixture.mts. Spec fields: origin, agentId, projectId, panelType (agent or super), artifactDir. It navigates every tab, using overflow when necessary, at 260/320/372px and audits clipping ancestors for 14 animation frames after each switch. It verifies the selected tab and its whole label, then records screenshots. It does not start a server or call any provider. Produced is not mocked in this run; the not-yet-integrated endpoint is safely absent. This check concerns tab geometry only.

Final results: 15 agent cases + 21 SuperAgent cases, 504 sampled frames, zero clipped labels/page exceptions. Focused fit/visibility tests: 12/12. Full suite: 1,145/1,145; typecheck and build exited 0. Logs: /tmp/ach67-label-{tests,typecheck,build}.log. New PNGs: label-after-agent-320.png, label-after-super-320.png, label-after-agent-260.png, label-after-super-260.png; comparison-labels-320.png compares the actual old transition with the final 320px strip. All were captured from the built UI against a fresh temporary data directory with FakeRunner. Temporary server stopped.

## Final Produced-only integration

Merged Ada's `e922f4b` (Produced only, based on local main bedf566) into this feature branch. Main was not modified. The only prospective merge collision was both workstreams naming tests/overviewData.test.ts; the UI test was renamed to overviewOutputRows.test.ts before merging, retaining both suites. Server/shared files match Ada's tip exactly. Her base also carries Hal's chip changes; none were hand-edited here. The UI's structural fallback is now an alias of the committed shared AgentProduced type. Missing/unavailable endpoint data is still safely omitted at runtime.

Each Overview opening/agent selection sends fresh=1 once per agent. Status/turn and 15s refreshes use plain GET and server caching; activity changes cause no extra load. The actual React hook fixture overviewRefresh.tsx passes seven checks: opening, activity-only update, turn end, timer, new selection, returning selection, and unmount/remount with timer cleanup. Replay with `node tests/ui/buildApprovalVariants.mts /tmp/ach67-overview-refresh docs/demos/ACH-67/build/overviewRefresh.tsx`; open the printed file and assert body[data-result] equals passed. Its explicit DOM/JSX typecheck also passed.

For real backend validation, run `ACH67_REAL_PRODUCED=1 node docs/demos/ACH-67/build/fixture.mts` after building. This seeds synthetic persisted report and walkthrough records in the temporary data directory only; it neither publishes a walkthrough nor delivers a message or starts a live agent. Git commits/changes are real temporary worktree data. Playwright used actual user-key authentication and no HTTP response fulfillment.

Verified: fresh=1 request on Overview open and reopen; real endpoint own=true, one branch commit, one current changed file, one stored walkthrough and one stored report. After adding a three-line untracked fixture file, cached GET retained files=1/added=1; fresh=1 returned files=2/added=4. The real UI rendered all four output kinds together, plus working/waiting/idle/team states without plan meters. Clicking each output selected its actual existing diff path (SearchView.tsx), Work view, walkthrough ID and Comms conversation ID. This tests routing and real output reads, not a provider run.

Current built captures: integrated-{working,waiting,idle,team}-{app,panel}.png. Integrated-comparison-{working,waiting,idle,team}.png and their HTML pages compare the real-backend UI with the earlier A reference (D100 intentionally removes its bar). Initial contract-fixture screenshots remain as historical evidence; these integrated captures supersede their backend limitation.

Final combined source checks: typecheck exit 0, build exit 0, full Node suite 1,156 passed/0 failed/0 skipped. Logs /tmp/ach67-combined-{typecheck,build,tests}.log. Separate hook lifecycle browser check: 7 passed/0 failed. Temporary server stopped; no real data or provider calls, app restart, main merge or push. Independent review remains.

## Review fixes after e987800

One follow-up commit on e987800, with no rebase.

- M1: team Needs you passes the asking agent into the existing compact QuestionPrompt. Both its inline choices and its QuestionForm fallback say “Rowan asks: …”. Display-only attribution never changes the original question text used as the API answer key. Individual Overview questions retain their existing presentation.
- M2: the shared selector now deduplicates team commits by full hash, walkthroughs by walkthrough ID and reports by message ID. Changes remain distinct per folder. One known source is labeled “Ellis’s branch”; a shared hash lists the known branches. AgentProduced supplies no commit-author field, so the UI does not invent who authored a shared commit. Individual output identities remain unchanged.
- Produced retains the prior snapshot while a reload is pending. A delayed-response hook regression proves the existing output stays visible until the replacement arrives. Selection changes still only render the selected agents' snapshots.
- Removed the unreachable blocked-report Needs you branch and the unused needsUser field. Reports remain in Produced.
- Divider comparison: the approved demo 954b55c, docs/demos/ACH-67/round2/index.html, has `.strip{height:36px;display:flex;align-items:center;gap:4px;padding:0 6px}` with no border. The MonoCode reference's MonoSidebarHeader in src/features/monos/ui/MonoSidebar.tsx:87 uses `border-b border-stroke`. The approved demo intentionally drops that divider, consistent with the requested flat style, so this follow-up keeps the strip borderless and records that difference explicitly.

Tests: two new Node selector regressions cover hash dedupe across different worktree folders, branch-source attribution without invented authors, stable walkthrough/report IDs and distinct diff folders. The actual React question/approval harness now passes 9 scenarios in full/compact variants, including the team asker's display and unchanged answer key. The hook harness passes 8 lifecycle scenarios, including retention during a held response. Both harnesses were typechecked explicitly. These browser harnesses remain separate from the Node npm test suite.

Real temporary backend capture: the fixture deliberately creates the same actual Git commit object on three branches. Three server responses reported a59e9fc339989c0de2350d7accf944b70a78aa9a; the team UI showed exactly one commit row, labeled Branches: Ellis, Rowan, June. The team question showed Rowan asks. Clicking its real inline answer returned HTTP 200 and sent answers['Which empty state should the search use?'], with no asker prefix in the key. No response fulfillment or provider calls. Updated integrated-team-app.png, integrated-team-panel.png and integrated-comparison-team.png document the result.

Final checks: typecheck 0, full suite 1,158 passed/0 failed/0 skipped, build 0, git diff --check clean. Logs: /tmp/ach67-review-{typecheck,tests,build}.log. Temporary server stopped. No server/shared or RefChip edits, main merge, rebase or push.
