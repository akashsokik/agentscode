# Plan: AgentsCode becomes Podcode

Status: plan only, nothing changed yet. Written 2026-11-11 against `main` at f137f8c (0.2.6 is the
latest release) and orca-site `main` at 6e67cd4. The launch plan is separate, in okikorg/orca-marketing
(`podcode-launch.md`), because marketing plans live there.

**The name.** Podcode: one word, capital P only, the way the site writes Orcacode. A pod is a group
of orcas that hunt together and talk all the time; Podcode is that for coding agents: Claude Code,
Codex and Orcacode agents side by side, messaging each other. The family: Orcacode (the harness),
Podcode (the desktop app), orcapods.ai. Where the brand needs anchoring: "Podcode, by Orca".

**The rule for this rename:** change every name a person sees; change no identifier that existing
installs, their data or their updates depend on.

## 1. The app

### What changes

| Where | Today | After |
|---|---|---|
| `package.json` `productName`, `build.productName` | AgentsCode | Podcode (window title, menus, About, Dock, DMG volume, installer, `Podcode.app`) |
| `build.artifactName` | `${productName}-${os}-${arch}.${ext}` | same template, so `Podcode-mac-arm64.dmg`, `Podcode-win-x64.exe`, `Podcode-linux-x86_64.AppImage` |
| UI strings (`web/`): sidebar, document title, About, empty states, errors | AgentsCode | Podcode |
| Agent prompts and system text (`server/`): "a coding agent in AgentsCode", mail and channel framing, error strings | AgentsCode | Podcode |
| Release tooling: `release.yml` asset globs and the required asset list, `scripts/release/verify-package.mjs`, `scripts/release.mjs` notes table, notarize comments | `AgentsCode*` | `Podcode*` |
| `install.sh` | installs `AgentsCode.app` from `AgentsCode-mac-<arch>.zip` | installs `Podcode.app`; downloads `Podcode-mac-<arch>.zip` and falls back to `AgentsCode-mac-<arch>.zip` if the latest release doesn't have it yet; removes an `AgentsCode.app` it replaces |
| README, NOTICE, `index.html` title, icon comments, alt text, tests that assert strings | AgentsCode | Podcode, paired with what it is ("Podcode, the desktop app where coding agents message each other"), because "pod" alone reads as podcast |

About 290 hits in 89 files. Most are mechanical; the agent prompts and the README need a reading, not a replace.

### What must not change, and why

| Keep | Why |
|---|---|
| **userData folder** `~/Library/Application Support/AgentsCode` (and the Windows and Linux equivalents) | Electron derives it from `productName`. It holds the window's localStorage (layout, drafts, what's been seen), the integrated browser's `persist:agentscode-browser` partition (its logins and cookies), and the single-instance lock. Fix: one line at the top of `electron/main.ts`, before `requestSingleInstanceLock()`: `app.setPath('userData', path.join(app.getPath('appData'), 'AgentsCode'))`. Pinning beats migrating: no copy, nothing to fail halfway, and an old `AgentsCode.app` and a new `Podcode.app` share one lock, so they can never run side by side on port 4320. |
| **`~/.agentscode`, `AGENTSCODE_HOME` and the other `AGENTSCODE_*` variables** | Agents, projects, transcripts, memory. The path doesn't depend on the app name. Invisible to users. |
| **`appId` / bundle id `com.agentscode.app`** | Squirrel.Mac only installs an update whose signature satisfies the running app's designated requirement, and that requirement includes the identifier. A new id would strand every signed 0.2.3+ Mac user on their version, reset their macOS privacy grants, and make the Windows installer treat Podcode as a second app (the NSIS uninstall key and AppUserModelId come from appId). Notarization doesn't care either way. |
| **`package.json` `name` `agentscode`** | Sets the per-user NSIS install folder (`%LOCALAPPDATA%\Programs\agentscode`) and electron-updater's cache folder. Never shown. |
| **The MCP server name `agentscode`** (`COMMS_SERVER`) | See below. |
| **Release asset *roles*** (one dmg and zip per Mac arch, an NSIS exe, an AppImage, `latest*.yml`, `SHA256SUMS`) | The updater reads file names from `latest*.yml`, so renaming files is safe for it; only the links (site, README, install.sh) need the cutover below. |

### The MCP server name: keep `agentscode`

Agents see the comms tools as `mcp__agentscode__send_message`, `delegate_task`, `report_result` and the rest.
Renaming the server would change every tool name. Specifically, it would:

- change the `allowedTools` policy and the SuperAgent's tool check (`server/agents/claude.ts`);
- break the regexes that render tool calls in transcripts (`web/activity.ts`, `web/toolPresentation.ts`, `server/agents/describe.ts`), unless they keep accepting the old name for old transcripts;
- make resumed sessions see old names in their history and new names in their tools;
- break any memory, soul or skill text that names a tool.

Users don't see the server name: the app already shows these calls as "Comms". **Recommendation: keep it.** Revisit only if it starts appearing in the UI. (The site test also expects "agentscode" in the page copy; that check changes to the new copy.)

### Known cosmetic effect on Mac

A Mac that auto-updates from 0.2.x keeps the file name `/Applications/AgentsCode.app`, because ShipIt installs at the running bundle's path. Inside, it's Podcode: the menu bar, Dock, About and windows all say Podcode. A fresh download, or `install.sh`, gives `Podcode.app`. **Recommendation: accept it.** Renaming a running, signed bundle ourselves is riskier than the cosmetic gain. The 0.3.0 release notes should say "drag the new DMG in if you'd like the file name to match". Check this on a real update during verification.

### Windows and Linux

- **Windows:** the per-user install folder stays the same (it comes from the package name). The Start menu shortcut and the uninstall entry become Podcode, because the one-click installer runs the old uninstaller first.
- **Linux:** the AppImage updater writes the new version over the running file.

Both are checked during verification.

## 2. The repository: the user decides

The repo's location matters in two places:

- **Installed apps' update feed:** `app-update.yml`, baked in at build time with owner and repo.
- **Every link:** the site, the README, `install.sh`, and the install command shown by unsigned 0.2.2 builds, which is `raw.githubusercontent.com/akashsokik/agentscode/main/install.sh`.

Signing doesn't depend on the repo at all. The personal Developer ID (team A5VD5J8JYG) lives in the five Actions secrets and is the same wherever the repo is.

| Option | Updater for installed 0.2.x | Links | Risk |
|---|---|---|---|
| **A. Keep akashsokik/agentscode** | Unchanged | Launch links say "agentscode" under a personal account | None, but every launch post points at the old name forever |
| **B. Rename to akashsokik/podcode** | Works through GitHub's redirect (web, release downloads, API, git) | Old links redirect | The redirect breaks if anyone ever creates a new `akashsokik/agentscode`. Secrets stay with the repo. |
| **C. Transfer to okikorg/podcode** (the name is free) | Same redirect | Old links redirect | Same redirect caveat. After the transfer, check that the five Actions secrets came along. If they didn't, they're re-added the same way as before; the `.p12` and its password are on the user's Mac, and the app-specific password would be new. okikorg's Actions settings must allow the pinned actions the workflow uses. |

**Recommendation: C, transfer to okikorg/podcode, before the 0.3.0 release.**

- Launch links are permanent, and the org is where Orca, Orcacode and the site already live.
- 0.3.0 is then built with `publish.owner: okikorg, repo: podcode`, so new installs never depend on the redirect. Only 0.2.x installs use it, once, to reach 0.3.0.
- One rule must hold forever: never create a repo named `agentscode` under akashsokik again.
- An org repo signed with an individual's Developer ID works. The name in the signature changes when that membership is converted to an organization; the Team ID stays the same, so updates keep working.

B is the low-effort middle. A is fine if launch is soon and the move can wait. Moving after launch costs the same mechanically, but then the launch links all go through the redirect.

## 3. Release numbering

- Published releases: 0.1.0, 0.2.2, 0.2.3, **0.2.6 (latest)**.
- Tags v0.2.4 and v0.2.5 exist, but their runs were cancelled and they have no releases. electron-updater only looks at the latest published release, so they're harmless. **Leave them.** Deleting them would change nothing for users and rewrite history others may have.
- **The rename ships as 0.3.0.** That's newer than 0.2.6 for every updater, and a minor bump marks the name change.

## 4. Cutover order

Each step needs the user's go. Nothing is published, renamed or deployed before then.

1. Merge the app rename PR to `main`. The `install.sh` fallback keeps the install command working while the latest release still has the old asset names.
2. If C or B: transfer or rename the repo. Then update `publish`, the README links, `install.sh`'s `REPO`, `MAC_INSTALL_COMMAND` (`shared/updates.ts`) and the workflow comments in the same PR, or a small follow-up before tagging.
3. Tag v0.3.0. CI builds, notarizes asynchronously and publishes `Podcode-*` assets.
4. Merge the site PR, which deploys `/podcode` with new asset links and the redirect from `/agentscode`. Between steps 3 and 4 the old page's links 404, because the latest release has no `AgentsCode-*` assets, so do 4 right after 3 publishes. To remove even that gap, the 0.3.0 publish step can also upload copies under the old names, once. That's an option, not in the base plan.

## 5. Verification before announcing

- A signed **0.2.6 installed on a Mac** sees 0.3.0, installs it in place, keeps its layout, drafts, integrated-browser logins and agents, and opens as Podcode. Note the bundle's file name.
- **Windows:** 0.2.6 to 0.3.0 auto-update. One app in Apps & features, the shortcut is named Podcode, and data is kept.
- **Linux:** the AppImage self-updates.
- A **fresh DMG downloaded in a browser** opens without Open Anyway; `spctl -a -vv` says Notarized Developer ID.
- `curl .../install.sh | bash` installs `Podcode.app` and removes an old `AgentsCode.app`.
- Agents still call comms tools: a delegate and report round trip, and a channel post.
- Old URLs: `orcapods.ai/agentscode` and the old repo URLs redirect, and the old raw `install.sh` URL still serves the script (if the repo moved).

## 6. The site (okikorg/orca-site)

| Item | Change |
|---|---|
| Path | `/podcode`. `agentscode.html` becomes `podcode.html`, `src/agentscode-main.tsx` becomes `src/podcode-main.tsx`, `AgentscodePage.tsx` becomes `PodcodePage.tsx`, and `src/content/agentscode.ts` becomes `src/content/podcode.ts` (constants `PODCODE_PATH`, `PODCODE_REPO`, ...). |
| Routes | `vite.config.ts` `cleanHTMLRoutes`: `['/podcode', '/podcode.html']`. |
| Redirects (`vercel.json`) | New: `/agentscode` to `/podcode`, permanent. Change the existing orcacode-host rule for `/agentscode` to point at `https://orcapods.ai/podcode`, so there's one hop, not two. |
| Copy | Renamed throughout, always "Podcode", never bare "Orca" for the app, with "by Orca" / orcapods.ai visible. The lead is what Stably's Orca and the others don't do: agents **messaging each other** (Comms: send, delegate, report), **Channels** across projects, and the **SuperAgent**. Pair the name with what it is in the title, meta description and H1. Say nothing the README doesn't, so the README's lead is rewritten first in the app PR. |
| Downloads | Asset names `Podcode-mac-arm64.dmg`, `Podcode-mac-x64.dmg`, `Podcode-win-x64.exe`, `Podcode-linux-x86_64.AppImage`, on the new repo's `/releases/latest/download/`. |
| Assets | `public/agentscode/` becomes `public/podcode/` (favicons, icons, screenshots). There's a new Open Graph image `og/podcode.jpg` with the name on it; the old image path keeps working for old shares. |
| Generated files | `scripts/generate-static-html.mts` gets `{ path: '/podcode' }` and the llms.txt line. Regenerate the sitemap, llms.txt and static HTML with the site's own script, not by hand. |
| Nav and footer | `src/content/site.ts` `agentscodePath` becomes `podcodePath`, label "Podcode". |
| Tests | `scripts/agentscode.test.tsx` becomes `scripts/podcode.test.tsx`, with the same rules: no emoji, every README feature covered, no version numbers, every screenshot with size and alt text. It gains two checks: the old path redirects, and the copy never says "Orca" alone for the app. |

## 7. Decisions for the user

1. **Repo home:** C, okikorg/podcode (recommended); B, akashsokik/podcode; or A, keep.
2. **Old-name asset copies on the 0.3.0 release:** no (recommended; deploy the site right after publishing) or yes (no 404 gap at all).
3. **Mac file name after auto-update** stays `AgentsCode.app` until a fresh install: accept (recommended) or ask for an in-app fix.
4. **Domain:** podcode.dev and podcode.ai look unregistered, and podcode.com is for sale. Optional; `/podcode` on orcapods.ai doesn't need one. The user's call.
5. **Version:** 0.3.0 (recommended).
