# Jarvis

Local desktop agent. Electron + React shell that drives the AI CLIs you already pay for:

| Engine | How | Auth |
|---|---|---|
| Claude Code | `claude -p --output-format stream-json` | your Pro/Max login (API key hidden by default) |
| Codex | `codex exec --json` | your ChatGPT login / `~/.codex/config.toml` |
| Ollama | HTTP `localhost:11434/api/chat` | local, offline |

## Run

```bash
pnpm install
pnpm dev        # dev with hot reload
pnpm build && pnpm start
pnpm dist       # signed Jarvis.app + dmg + zip in dist/
```

Shortcuts (change in Settings → Shortcuts):

| Keys | What |
|---|---|
| `⌥Space` | quick bar — floating Spotlight-style ask from anywhere |
| `⌥⇧Space` | talk — quick bar opens listening |
| `⌥⇧L` | live conversation — hands-free voice loop in the main window (press again to end) |
| `⌘⇧Space` | main window |
| `⌘N` / `Esc` / `⌘B` / `⌘D` | new chat / stop run / workbench / dictate into the composer |

Jarvis lives in the menu bar (ring icon; dashed while an agent works). Closing the window keeps it running; quit from the menu or `⌘Q`. Settings → App → *Menu bar only* hides the Dock icon.

## Concepts

- **Engine**: which CLI/model answers. Switch per chat; each engine keeps its own session id, so resume works.
- **Mode**: focused persona (instructions + preferred engine). Built-in: `Jarvis`, `Code · Git · Linear`, `Local quick`. See `src/main/modes.ts`.
- **Autonomy**: `Read-only` (Claude plan mode / Codex read-only sandbox), `Edit files` (acceptEdits / workspace-write), `Full access` (bypass / no sandbox).
- **Workspace**: folder the agent runs in (click the folder chip).

## Workbench: Git + Linear (`⌘B`)

Right-hand panel for the active chat's workspace:

- **Git**: branch, ahead/behind, changed files (click for a diff), recent commits, the current PR with checks and review state (`gh`). One-click asks to the agent: **Commit · Open PR/Push · Sync · Review**.
- **Linear**: your open assigned issues, sorted by state and priority. Clicking **Work on it →**:
  1. opens a new chat in `Code · Git · Linear` mode, running Claude Code with **Edit files** autonomy, in the repo set for that team (the first use remembers the current workspace for the team);
  2. moves the ticket to *In Progress*;
  3. sends a starter prompt: read the issue, branch with Linear's `branchName`, plan, implement, test, commit, open a PR.
- When a GitHub PR URL appears in that chat, a banner offers **Link PR**, which attaches the PR to the ticket, comments, and moves the ticket to *In Review*.

The Linear API key is stored encrypted using the macOS keychain (`safeStorage`). Create one at https://linear.app/settings/account/security.

## Agent tools + approvals (Jarvis MCP bridge)

Every Claude Code / Codex run gets a built-in `jarvis` MCP server (`src/main/mcp/bridge.ts`, a zero-dependency stdio server launched with Electron-as-Node). It forwards calls to the app over loopback HTTP, protected by a token created at launch.

| Tool | What it does |
|---|---|
| `approve` | Claude's `--permission-prompt-tool`. In **Edit files** mode, shell, git and network actions open a popup: **Allow** (`⌘↵`), **Deny** (`Esc`), or **Always allow \<tool\> in this chat**. |
| `memory_search`, `remember` | Read and write your long-term memory |
| `linear_my_issues`, `linear_get_issue` | Read Linear issues (allowed without a prompt) |
| `linear_set_state`, `linear_comment` | Update Linear issues (asks first in Edit mode) |

Codex gets the memory and Linear tools through `-c mcp_servers.jarvis.*`. `codex exec` can't stop to ask for approval, so its safety comes from its sandbox.

## Memory & knowledge

Jarvis keeps a local SQLite store (`~/Library/Application Support/jarvis/jarvis.db`):

- **Memories**: short facts about you (`profile`, `preference`, `workflow`, `project`, `person`, `fact`). Pinned ones go into every run; others are retrieved by relevance.
- **Knowledge**: folders you add (notes, docs, repos), chunked and indexed incrementally.
- **Retrieval**: hybrid BM25 (FTS5) + embeddings (Ollama `embeddinggemma`), merged with reciprocal rank fusion. Without Ollama it runs keyword-only.
- **Learning**: after each turn, Jev decides whether you said something worth remembering (`noul` question). If so, Claude Haiku runs with no tools, MCP, hooks or saved session, or a local Ollama model if you choose that, and returns add/update operations. Near-duplicates (cosine > 0.92) update the existing memory instead of adding a new one.
- Manage everything in **Memory** (sidebar): edit, pin, forget, add folders, status.

## Jev classifier

[Jev-style](https://github.com/lawrence3699/jev-style) decision models answer `choice` / `noul` / `score` questions with probabilities through `POST /v1/systemone`. Jarvis uses Jev for:

- **Auto mode routing**: picks the mode and engine for a new chat's first message.
- **Memory gating**: decides whether a turn should be learned from.

```bash
uvx --from "jev-style[mlx]" jev-style serve      # :8765, Apple silicon
```

When the Jev server is offline, Jarvis uses keyword heuristics instead. The URL is set in Settings; jevos (`:8017`) works too. To test without the model: `bun scripts/mock-jev.ts`.

## Quick bar

`⌥Space` opens a floating bar over any app (also over full-screen apps). Type, Enter. The first message is auto-routed (Jev/heuristic) like a new chat; follow-ups continue the same session. `⌘O` opens the thread in the main window, `⌘N` starts fresh, `⌘.` stops, `Esc` hides (the run keeps going). Quick chats show up in the sidebar tagged *quick*. Approval popups appear inside the bar.

## Voice (all local)

- **Speech-to-text**: whisper.cpp (`whisper-cli`) + a ggml model. Settings → Voice → *Install* builds whisper-cli from source into `~/Library/Application Support/Jarvis/whisper` (works without Homebrew; needs Xcode tools and `cmake` or `uv`). Or `brew install whisper-cpp` — anything on your shell PATH is picked up. *Download* fetches the model (default `base`, 142 MB, multilingual). Warm transcription of a sentence is ~0.3 s on Apple Silicon.
- **Push-to-talk**: `⌥⇧Space` or the mic button. Recording stops after ~1.2 s of silence (or click again). The transcript is sent as the prompt with a "keep it short" hint.
- **Dictation**: the mic button in the main composer (or `⌘D`) records until you pause, then puts the transcript in the message box to edit before sending.
- **Live mode**: the waveform button, `⌥⇧L`, the menu bar, or "Jarvis, live mode" (with the wake word on). A hands-free loop in the current chat: it listens, sends what you said when you pause (~0.9 s), reads the answer aloud sentence by sentence as it streams (code blocks stay on screen), then listens again. The agent gets a "spoken conversation" hint, so answers stay short. `Esc` or *Interrupt* stops the answer and cancels the run; `Esc` again, *End*, or saying "stop live mode" / "goodbye" ends it. It also ends after 3 quiet minutes. Approvals still pop up, and Jarvis says so. The mic is ignored while Jarvis speaks so it doesn't hear itself; with headphones, turn on Settings → Voice → *interrupt by talking* to cut it off just by speaking. Keeps running when the window is hidden.
- **Spoken replies**: when you spoke, the answer is read aloud (code and links skipped); `Esc` stops it. Default is a natural neural voice, [Kokoro-82M](https://github.com/thewh1teagle/kokoro-onnx) running on this Mac: Settings → Voice → *Natural voice* downloads it (338 MB into `~/Library/Application Support/Jarvis/kokoro`; needs `uv`, which installs the Python runtime once). A long-lived worker (`resources/kokoro-worker.py`) renders the next sentence while the current one plays, about 6× faster than real time on Apple Silicon. Pick from British and American voices (default *George*) and a speed. Kokoro can't speak German, so German answers, or any reply when the neural voice isn't set up, use macOS `say` with the fallback voice you choose.
- **Wake word** (off by default): Settings → Voice → *Listen for "Jarvis"*, or the menu-bar toggle. An energy VAD cuts speech into ≤6 s clips; each is transcribed locally and only acted on if it starts with "Jarvis…" / "Hey Jarvis…". "Jarvis, what's on my board?" runs immediately; "Jarvis" alone opens the bar listening. Paused while Jarvis is speaking or the bar is open. Audio is never stored or uploaded; macOS shows the mic indicator while it's on.

## Routines

Scheduled prompts with fresh data, answered into a new chat (tagged *routine*) plus a notification (click opens it); optionally read aloud. Manage in the sidebar → Routines or the menu bar.

- Placeholders filled before the run: `{{linear}}` (your open issues), `{{prs}}` (your open PRs + review requests via `gh search prs`), `{{repos}}` (branch/uncommitted/unpushed for mapped repos), `{{date}}`.
- Schedules: time of day on chosen weekdays, or every N minutes. Missed runs catch up after sleep (within 6 h — no morning briefing at 9 pm).
- Runs are unattended and read-only: no approval tool is attached, so anything beyond reading is declined.
- Built-in *Morning briefing* (weekdays 08:30) ships **disabled** — flip it on. Templates: PR review sweep, end-of-day wrap-up.

## Packaging + auto-update

`pnpm dist` builds `dist/Jarvis-<v>-arm64.dmg` and the `-mac.zip` update payload with electron-builder (`electron-builder.yml`): hardened runtime, mic entitlement, signed with the first identity in your keychain. `bridge.js` is unpacked from the asar so agent CLIs can spawn it.

Auto-update uses electron-updater against GitHub Releases (`publish` in `electron-builder.yml`, currently `DamonBslr/jarvis`). To ship an update: bump `version` in package.json, then `GH_TOKEN=… pnpm release` — it uploads dmg, zip and `latest-mac.yml`; installed apps download it in the background and install on quit (Settings → App). For other Macs without Gatekeeper warnings, sign with a *Developer ID Application* certificate and set `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` (or `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`) so electron-builder notarizes. A private repo also needs a token at runtime, so a public releases repo is simpler.

## Tests

```bash
JARVIS_DB_DIR=$(mktemp -d) npx tsx scripts/memory-test.mts          # memory, RAG, routing
JARVIS_DB_DIR=$(mktemp -d) npx tsx scripts/memory-test.mts --learn  # + real learner call
bun scripts/smoke.ts codex "prompt"                                  # provider adapters
npx tsx scripts/integrations-test.mts                                 # git parser + Linear auth errors
```

## Layout

```
src/main/            Electron main: IPC + boot (index.ts)
  runner.ts          one run pipeline (memory context, MCP bridge, learning, approval routing per window)
  windows.ts         main window + floating quick bar
  tray.ts            menu-bar icon and menu
  voice.ts           whisper.cpp transcription, model download/install, Kokoro neural voice + macOS speech
  routines.ts        scheduler + data gatherers for scheduled prompts
  updater.ts         electron-updater wiring
  providers/         one adapter per engine -> normalized AgentEvent stream
  shellEnv.ts        loads PATH/env from your login shell (GUI apps don't get it)
  modes.ts           personas (+ Auto)
  classify/          Jev client + router
  memory/            SQLite store, embeddings, hybrid search, folder indexer, context builder, learner
  mcp/               bridge.ts (stdio MCP server for agents) + server.ts (loopback endpoint, approvals)
  integrations/      git.ts (status/diff/PR via git + gh), linear.ts (GraphQL)
  secrets.ts         keychain-encrypted secrets
  store.ts           JSON persistence in ~/Library/Application Support/jarvis
src/preload/         typed bridge (window.jarvis)
src/renderer/        React UI
src/shared/types.ts  contracts shared by all three
src/shared/chat.ts   event->message reducer, history, speakable text
src/renderer/src/QuickBar.tsx, voice.ts   quick bar UI; mic capture, VAD, WAV, wake listener
resources/           tray icons + install-whisper.sh (shipped as extraResources)
assets/, build/      icon sources (pnpm icons) + builder resources/entitlements
scripts/smoke.ts     headless adapter test: bun scripts/smoke.ts codex "prompt"
```

## Notes

- Claude Code children load your normal `~/.claude` config (hooks, MCP servers, skills, CLAUDE.md). Your Linear MCP / skills are available to Jarvis automatically.
