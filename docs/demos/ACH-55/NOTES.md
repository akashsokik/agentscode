# ACH-55: Settings as a full-screen page (ACH-D71), phase 1 demo

Demo: `settings-demo.html` (standalone; open it in a browser). Frames: `sequence-dark.png`,
`sequence-light.png`. Motion: `settings-real.gif` (real speed, about 200ms) and `settings-slow.gif`.
Rebuild: `node docs/demos/ACH-55/build.mts dist/assets/styles-*.css` after `vite build`.

## References

**MonoCode** (`/private/tmp/monocode`, 7e5a9e3)
- Entry: the gear in the sidebar, Cmd+, and deep links (`openSettings(section, anchor)`).
- The rail slot shows `SettingsNav` (`src/app/shell/SettingsRail.tsx`), which keeps the sidebar's
  width:
  - Sections are grouped under small labels.
  - The active row uses `bg-selection`.
  - A Back row sits at the foot.
- Hidden: the inset sidebar, the title tabs (`shownViewTabId` is undefined) and the workspace.
  `SettingsView` fills the main area, with a breadcrumb in the header.
- Esc: a window listener that skips the event when it is `defaultPrevented`, so dialogs inside
  Settings close first.
- App Back (`onRailBack`, `canGoBack`) also closes Settings.
- The last section is remembered.
- Motion: none. The swap is instant (no `animate(` or transitions in SettingsRail or ProjectRail).
  The motion in this demo is ours.

**Linear**
- Settings replace the sidebar with a "Back to app" row and grouped sections (Account, Workspace,
  Teams), and the page fills the main area.
- Its changelog confirms the "Back to app" row and the 2024 settings regrouping.
- The motion is not documented, so the demo copies none.

**Codex desktop**
- Cmd+, or the gear in the sidebar opens Settings.
- Sections: General, Appearance and so on.
- Cmd+[ navigates back.
- The sidebar motion is not documented.

## PodCode today (main 59fbc48)

**How Settings opens.** Settings is a modal: `web/dialogs/SettingsDialog.tsx` in `Modal`
(`size="md"`), opened by `setDialog({kind:'settings'})` in `web/App.tsx`. Entry points:
- The sidebar foot gear, a `HeaderButton` (`web/sidebar/Sidebar.tsx:688`)
- Cmd+, (`web/shortcutMap.ts:50`)
- The command palette (`web/ui/CommandPalette.tsx:166`)
- The `openSettingsAt` event with group `super`/`about` (`App.tsx:506`)
- The desktop About menu (`App.tsx:514`)

**Sections.** There are none yet. One scrolling column holds five `Group`s: Appearance, Agent
communication, SuperAgent, Engines and About (`AboutGroup.tsx`, `AutonomySettings.tsx`).

**Primitives.** `Group`, `Row`, `Segmented`, `Toggle` and `Select` (`web/mono/settings.tsx`),
`INPUT`, `SecondaryButton`, `EngineIcon`.

**Keys and history.**
- Esc elsewhere answers approvals (Deny) in the transcript.
- Cmd+1..9 is `pickTab` (`shortcutMap.ts:57`).
- ACH-D69 Back/Forward history covers main-pane tabs only.

## Proposal

**Reuse, with no new component.**
- Nav rows: the `RailAction` row look (`bg-selection` when active), as in the demo.
- The foot row: `HeaderButton` for the gear, and the same row slot for Back.
- The page: `Group` and `Row` unchanged, one Group per section.
- Section keys: `settingsSections.ts` already has `sectionForKey`, with arrows, Home/End and
  Cmd+digit; it would gain the app sections.
- State: `layout.ts` keeps an `appSettingsOpen` and a section, beside the existing rail state.
- `SettingsDialog` becomes the page body; `Modal` is dropped for it.

**Motion.** 180ms, ease-out cubic. Only opacity and transform change, and nothing reflows.
1. The app's sidebar rows fade out with a 12px leftward drift.
2. The settings rows fade in from 12px right.
3. The tab strip, the main pane and the right panel fade out together.
4. The settings page fades in with a 6px rise.

The two halves overlap by only 5% so text never doubles up. Under reduced motion it is an instant
swap.

**Refining ACH-D71 (2 lines).**
1. Settings open from the gear, Cmd+, the palette and the deep links (SuperAgent, About). While they
   are open, the sidebar shows the settings sections with Back at its foot where the gear was. The
   tab strip, the main pane and the right panel are hidden, not closed, and come back unchanged.
2. Back, Esc (when nothing inside Settings took it) and Cmd+[ close Settings. Cmd+1..5 pick a
   section while Settings are open, and the last section is remembered. Motion is a 180ms
   opacity/transform crossfade, and an instant swap under reduced motion.
