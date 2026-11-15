# ACH-59 part 2: Settings layout toward the user's reference (ACH-D81), demo only

Demo: `settings-layout-demo.html`, standalone. Click the sections, type in Search settings, or switch
the theme. Rebuild it with `node docs/demos/ACH-59/build.mts dist/assets/styles-*.css` after `vite build`.

## The layout
- **Sidebar.** Compact 13px rows (28px tall, 14px icons), grouped under small muted headers, with
  "Search settings" at the top. Search filters rows on every page and shows each hit under its page
  name.
- **Content.** A centred column, 600px of content, with a 20px page title. Each group has a small
  heading over one flat rounded card.
- **Rows.** Title on the left with a one-line muted description, and the control on the right
  (Toggle, Select, a number field or a quiet text button). Thin dividers between rows.
- Flat throughout: no shadows and no one-sided borders.

## Sections: today's five, mapped
| Group      | Section    | Today                                                  |
|------------|------------|--------------------------------------------------------|
| (none)     | Appearance | Appearance                                             |
| Agents     | Messaging  | Agent communication, renamed (the cut-off label)        |
| Agents     | Engines    | Engines                                                |
| SuperAgent | Autonomy   | SuperAgent: the autonomy level and the ask-first switches |
| SuperAgent | Limits     | SuperAgent: wake-ups, budgets, the creation cap, quiet hours |
| PodCode    | About      | About                                                  |

Copy changes:
- Descriptions are cut to one line. The longer explanations (what Full does, and so on) move behind
  a quiet "Show" row in Autonomy.
- Three- and two-way choices (Theme, Avatars, Who can message, Autonomy) become `Select`, as in the
  reference. Segmented is no longer needed on this page.

## Back
- **A: at the sidebar foot**, where the gear was. This is today's layout (ACH-D77, which you chose
  as "Back at the sidebar foot").
- **B: "<- Settings" at the top**, as in the reference. It replaces the PodCode row, and the foot is
  empty.

Recommendation: **A**. You picked the foot explicitly in ACH-D77, and Back sits where the gear that
opened Settings was. B is the closer match to the reference if you prefer it now.

## Reuse
- **Group:** unchanged in structure. Pages use more Groups, with short headings and no long
  descriptions.
- **Row:** keeps title plus description left and control right. Two class changes: `items-center`,
  and a one-line description (`truncate`, mt-0.5, py-3).
- **Unchanged:** Toggle, Select and INPUT.
- **No new component.**
- **New pieces:**
  - The page title is an h1 in SettingsPage.
  - The sidebar rows are RailAction at 13px, so RailAction gains a compact size.
  - The search field and a small settings index (title and description per row) are new code.
    Search is optional (ACH-D81 says "optional"), so it can wait for phase 2.
