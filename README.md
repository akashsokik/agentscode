# AgentsCode

An IDE where several coding agents work side by side on your local projects and talk to each other.
Each agent is a real **Claude Code** or **Codex** session. You give agents work in their own tabs;
agents hand each other requests, reviews and validations through built-in messaging tools, and every
exchange is visible in the Comms view. Channels put you in a room with agents from several projects.

The engine and messaging layer are ported from Agent Office. The interface is built from MonoCode's
UI: its primitives are vendored in `web/mono/`, and the transcript, composer and inset layout follow
its markup. See [NOTICE](NOTICE).

## Run it

```bash
npm install
npm start          # builds the web app and serves everything at http://localhost:4320
```

For development with hot reload:

```bash
npm run dev        # API on :4320, Vite on http://localhost:5174
```

Requirements: Node 23.6 or newer (the server runs TypeScript directly), plus the CLIs you want to
use, already signed in:

- Claude Code: `claude` on your PATH (uses your existing login)
- Codex: `codex` on your PATH (run `codex login` if it reports a login problem)

AgentsCode uses port 4320 and keeps its data in `~/.agentscode`, so it can run next to Agent Office.
Override with `PORT=...` and `AGENTSCODE_HOME=...`.

### Desktop app (macOS)

```bash
npm run dist:mac   # builds release/AgentsCode-0.1.0-arm64.dmg
npm run desktop    # or build and open it straight from the source tree
```

The app bundles its own runtime (Electron), so it needs no Node install; it still needs the
`claude` and `codex` CLIs, which it finds through your login shell's PATH. It starts the server
in the background and opens a window on it. If an AgentsCode server already answers on port 4320
(for example `npm run dev`), the window opens on that one instead, so two servers never share
`~/.agentscode`. Quitting the app stops its agents; closing the window keeps them working.
The build is not code-signed: the first time, right-click the app and choose Open.

## Using it

1. **Add a project**: any folder on your machine (sidebar footer, or the empty state).
2. **Create agents**: pick a name, engine (Claude Code or Codex), model, effort, role and autonomy.
   Turn on **Own git worktree** to give an agent its own branch and folder, so parallel agents never
   edit the same checkout.
3. **Talk to an agent**: click it in the sidebar to open its tab. Enter sends; messages sent while it
   works wait in line. Stop interrupts the current turn. Cmd+click opens an agent in a pane to the side;
   the split button in a pane header adds another pane (up to three). Right-click an agent in the
   sidebar, or hover it and click its **...** button, to open it beside, close its tab, stop it, start
   a new session, change its settings or remove it. Right-click a project to remove it once it has no
   agents (its files stay on disk).
4. **Let agents coordinate**: ask one agent to work with another, for example
   "Ask Bo to review your changes to src/auth.ts and fix what Bo finds." The agents use their
   messaging tools; each message runs as a turn in the recipient's own session.
5. **Watch the traffic**: the right panel's **Comms** tab is a live feed; the **Comms** tab in the
   title bar shows every conversation as a thread with its participants, status and budget, and lets
   you stop a conversation. Peer messages also appear as cards in both agents' transcripts.
6. **Work in a channel**: see [Channels](#channels).
7. **Review changes**: the right panel's **Changes** tab lists the focused agent's working-tree
   changes against HEAD; click a file for its diff. The **Files** sidebar tab browses any agent's
   workspace or project read-only.
8. **Use a terminal**: see [Terminal](#terminal).

### Terminal

A terminal panel opens under the panes with **Cmd+J** (or Ctrl+`), the **Terminal** button in the status bar,
**Open terminal** on a project's menu, or the command palette. It runs Ghostty's terminal emulator
(through [ghostty-web](https://github.com/coder/ghostty-web), its core compiled to WebAssembly). It
is not the Ghostty app, so `~/.config/ghostty` does not apply.

- **One set per project**: the panel follows the project in view, as the sidebar does. Opening an
  agent brings its project's terminals forward. Each new shell is your login shell, started in the
  project's folder. **+** or Cmd+T in a terminal adds another.
- **Shells outlive the page**: they run in the server. Reloading the page, or opening a second
  window, reattaches to them with their recent output (about 1 MB each). They end when you close
  their tab, type `exit` (the panel hides with the project's last one), remove the project or quit
  AgentsCode.
- **Splits, as in Ghostty**: Cmd+D splits right and Cmd+Shift+D splits down; the new shell starts in
  the folder the one you split from is in (it reads the OSC 7 that zsh and fish send). Cmd+W closes
  the split, Cmd+[ and Cmd+] move through the splits, Cmd+Option+arrows move by direction,
  Cmd+Shift+Enter zooms one split to fill the tab, and Cmd+Ctrl+= makes them equal. Drag a divider
  to resize; double-click it to halve. The panel's buttons and the right-click menu do the same
  (with Copy, Paste and Clear). Closing a terminal that still runs a program, such as a dev server,
  asks first.
- **Keys, as in Ghostty on macOS**: Cmd shortcuts stay with the app and menus, Cmd+C copies (selecting
  text copies too), Cmd+V pastes. Option types the character it makes, such as # on a British keyboard.
  Cmd+Left, Cmd+Right and Cmd+Backspace edit the line; Option+Left, Option+Right and
  Option+Backspace work by word. Ctrl chords go to the shell. Cmd+click opens a link.
- Drag the panel's top edge to resize it; double-click it to reset.

### Channels

A channel is a room for you and agents you invite, from any project, like a Slack channel. Create one
from **Channels** at the top of the sidebar: give it a name, an optional topic, and switch on the
agents you want in it. Change members later from the channel's member list or its settings.

- **Mention to start**: `@Ada` in a post starts Ada on it, in her own session and project, as your own
  request. `@all` starts every member. A post without a mention is a note: it starts nobody, and
  members see it as context the next time they work in the channel. The line under the composer says
  exactly who a post will start before you send it.
- **Replies come back**: each started agent's final reply is posted to the channel. If it hits a
  problem, or asks for an approval, that is posted too; answer approvals in the agent's own tab.
  Under each post, every recipient shows Queued, Working, Needs you, Replied, Failed or Stopped.
- **Agents talk to each other**: an agent can post with `post_to_channel` and start other members by
  id. The member it mentions answers in the channel, and the asker is told. Agents posting without a
  mention start nobody.
- **Across projects**: each agent's channel prompt lists the members with their project, workspace path
  and branch, plus the last 20 posts. Channel membership is your explicit opt-in, so members can
  reach each other there whatever **Who can agents message?** says. Direct messages still follow it.
- **Limits**: mentions between agents go through the mailbox, so they share the message budget and
  one-turn-at-a-time delivery. Only you can invite agents. Plan-only agents can post findings but
  cannot start other members. Stopping an agent ends the collaborations it is in.
- A channel cannot be deleted while a member is still working on one of its posts. Removing an agent
  takes it out of every channel. After a restart, deliveries that were in flight are marked failed.

### Agent-to-agent tools

Every agent gets an `agentscode` MCP server with these tools:

| Tool | What it does |
| --- | --- |
| `list_agents` | Teammates with engine, role, project, branch, status, current task and queue |
| `send_message` | Send a request or information; returns a receipt at once, the reply arrives as a later turn |
| `reply` | Answer a received message by its id |
| `read_messages` | The agent's last 50 sent and received messages |
| `set_task_summary` | Update the one-line task summary shown to you and teammates |
| `delegate_task` | Lead only: assign implementation, testing, validation or review with acceptance criteria |
| `report_result` | Return a delegated task's outcome (passed, failed, blocked, done) with evidence |
| `list_delegations` | Lead only: track delegated tasks and their reports |
| `list_channels` | The channels the agent is in, with each member's project, workspace, branch and status |
| `read_channel` | Recent posts in one of its channels |
| `post_to_channel` | Post in a channel; members in `mention_agent_ids` get a turn to answer |

How delivery works:

- Messages are durable and asynchronous. A recipient handles one peer message at a time, after any
  user messages already queued for it. An idle recipient starts right away.
- Peer text is framed as context from a teammate, not as instructions from you. Agents keep their own
  permissions; plan-only agents can reply but cannot start conversations or delegate.
- Each collaboration chain has a **message budget** (12 by default, Settings). Replies and hand-offs to a
  third agent share it, which stops ping-pong loops.
- **Stop** on an agent cancels its queued messages and pauses incoming mail until you send it a new task.
  **New session** (the composer's session menu) clears the agent's context and ends its collaborations, but teammates
  can message it again right away.
- After a restart, unfinished messages are marked failed instead of being replayed, because they may
  already have edited files.
- Identity comes from a per-process token: each agent process gets its own credential, and the MCP
  server is passed per process, so your global Claude Code and Codex configuration is never edited.

Settings control who agents can see (nobody, same project, all projects), whether current tasks are
shared, whether each task starts with a team snapshot, and the message budget.

### Autonomy

| Level | Claude Code | Codex |
| --- | --- | --- |
| Plan only | plan mode; you approve the plan before edits | read-only sandbox |
| Supervised | asks before every edit and command | workspace-write sandbox |
| Auto-accept edits | edits freely, asks before commands | workspace-write sandbox |
| Full access | no approvals | no sandbox |

Claude agents raise permission requests and plans inline in their transcript, with Allow and Deny
(Deny takes an optional note). Questions open above the composer. Codex runs
non-interactively (`codex exec --json`, resumed per thread), so its sandbox is the safety net.

### Engines

- Claude agents run through the Claude Agent SDK with your installed `claude` binary: one long-lived
  process per agent, closed after 20 idle minutes and resumed on the next message. They load your
  CLAUDE.md, settings and plugins. Your own MCP servers are off unless you enable them per agent.
- Codex agents run one `codex exec` process per turn and resume the same thread for follow-ups.
- Model lists come from the CLIs themselves (no tokens spent). Change model, effort or autonomy from
  the composer chips at any time.

## Security

The server binds to 127.0.0.1, answers only requests addressed to localhost (against DNS rebinding)
and refuses cross-origin writes and WebSocket connections, including each terminal's socket. A
terminal always starts in its project's folder; requests name a project, never a path or a command.
The file viewer resolves real paths and
refuses anything outside the agent's workspace or project. Agents can still change files in their
folders, so use Full access only where you can restore from git.

## Checks

```bash
npm test           # mailbox and channel rules, manager routing, HTTP and WebSocket guards, MCP stdio round trip,
                   # terminals against a real /bin/sh, terminal keys and split layout; no provider calls
npm run typecheck
npm run build
```

## Layout

```
electron/main.ts     desktop app: starts the server in a utility process and opens a window on it
server/
  index.ts           HTTP + WebSocket entry
  app.ts             REST API and localhost guards
  manager.ts         agents, projects, approvals, turn lifecycle
  agents/            Claude (Agent SDK) and Codex (codex exec) runners, per-agent FIFO
  comms/             mailbox, channels, MCP tool definitions, stdio MCP entry
  workspace.ts       file tree, file reads, git status and diffs
  terminals.ts       shells for the terminal panel (node-pty), output kept for reattaching pages
web/
  mono/              UI primitives vendored from MonoCode (Popover, Modal, QuestionForm, AccessPicker, ...)
  App.tsx            Classic layout: tab strip over the main column, status footer, dialogs
  turns.ts           groups a transcript into turns using the server's turn markers
  sidebar/           navigation column (channels, projects) and workspace column (agents, files, changes)
  panes/             agent session, transcript, composer, channel, Comms, file and diff views
  right/             Overview, Comms feed and Changes panel
  terminal/          terminal panel: Ghostty's emulator (ghostty-web), per-project tabs and splits, key handling
shared/types.ts      the contract between server and client
tests/               node --test suites with fake providers
```
