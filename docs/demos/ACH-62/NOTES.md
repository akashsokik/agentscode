# ACH-62: @-mention issues (Phase 1 demo, no app code)

Base: main 2fcdad8. Files: `at-mention-issues-demo.html` (standalone, real compiled CSS, toggle for
light/dark), `ach62-demo-dark.png`, `ach62-demo-light.png` (2x).

Built from the real parts: the `MentionPicker` row and heading class strings (web/composer/Pickers.tsx),
`StatusIcon` for issues, `MatchText`, `AgentAvatar`, and the real `IssueKeyChip` on `ReferenceChip`
with its hover card (ACH-D74, D58). No new component.

## Proposed behaviour

- **Where:** the same @ picker in the agent composer, channels and the Quick window.
- **Matching:** issues join the picker once a character is typed (a bare @ stays agents and projects).
  - The query is the start of a key ("ach-2", "ACH-28"), or each query word starts a word of the title ("filt", "dup hand").
  - No scattered fuzzy letters, which matched unrelated long titles.
  - Open issues only, at most 6, under an "Issues" heading (the picker already uses headings).
  - An exact key, closed or not, leads as Best match.
- **Row:** status mark, key (mono), title with the match marked, and the project name at the right (like an agent's hint).
- **Pick:** inserts the bare key ("ACH-26 "), not "@ACH-26": one form everywhere, as agent replies already show keys.
- **Sent:** a known key in your message renders as the issue chip, the same `IssueKeyChip` agent replies use. Today `MentionText` only chips @mentions and note ids.
- **Context:** the receiving agent gets one line per issue under the existing "Mentioned in this message" note.
  - Format: `- ACH-26: the issue "<title>" (<status>, project <name>).`
  - Any known key in the text counts, picked or typed.
  - Channel deliveries come from explicit member ids, so a key never starts anyone.

## Not possible as asked

The composers are plain textareas (@Ada stays text there too), so a chip *inside* the composer would
need a new overlay component. Asking before building one (ACH-N40, ACH-D23).

## Build plan (after approval)

1. **web/composer/tokens.ts**
   - Add an `issue` kind to `MentionPick` with `rankIssues`.
   - `pickGroup` gets 'Issues'.
   - The pick inserts the key without the sigil.
2. **web/composer/Pickers.tsx**
   - The issue row.
   - The empty text includes issues.
3. **web/ui/MentionText.tsx:** known issue keys in plain parts become `IssueKeyChip`.
4. **shared/mentions.ts:** an issue line in `mentionContext`, from `findIssueKeys` with the projects' codes.
5. **server/manager.ts `send`** and **server/comms/channels.ts:** pass issues to the lookup.
   - Every composer reaches one of these: the Quick window via `api.send` and `createAgent`, which calls `send`.
6. **Tests** for ranking, insert, chip and context.
