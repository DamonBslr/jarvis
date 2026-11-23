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
```

Shortcuts: `⌘⇧Space` summon from anywhere · `⌘N` new chat · `Esc` stop run.

## Concepts

- **Engine**: which CLI/model answers. Switch per chat; each engine keeps its own session id, so resume works.
- **Mode**: focused persona (instructions + preferred engine). Built-in: `Jarvis`, `Code · Git · Linear`, `Local quick`. See `src/main/modes.ts`.
- **Autonomy**: `Read-only` (Claude plan mode / Codex read-only sandbox), `Edit files` (acceptEdits / workspace-write), `Full access` (bypass / no sandbox).
- **Workspace**: folder the agent runs in (click the folder chip).

## Layout

```
src/main/            Electron main: IPC, window, hotkey
  providers/         one adapter per engine -> normalized AgentEvent stream
  shellEnv.ts        loads PATH/env from your login shell (GUI apps don't get it)
  modes.ts           personas
  store.ts           JSON persistence in ~/Library/Application Support/jarvis
src/preload/         typed bridge (window.jarvis)
src/renderer/        React UI
src/shared/types.ts  contracts shared by all three
scripts/smoke.ts     headless adapter test: bun scripts/smoke.ts codex "prompt"
```

## Notes

- Claude Code children load your normal `~/.claude` config (hooks, MCP servers, skills, CLAUDE.md). Your Linear MCP / skills are available to Jarvis automatically.
- In headless mode Claude can't ask permission interactively; actions outside the chosen autonomy are denied, not prompted.
