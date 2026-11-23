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

## Tests

```bash
JARVIS_DB_DIR=$(mktemp -d) npx tsx scripts/memory-test.mts          # memory, RAG, routing
JARVIS_DB_DIR=$(mktemp -d) npx tsx scripts/memory-test.mts --learn  # + real learner call
bun scripts/smoke.ts codex "prompt"                                  # provider adapters
```

## Layout

```
src/main/            Electron main: IPC, window, hotkey
  providers/         one adapter per engine -> normalized AgentEvent stream
  shellEnv.ts        loads PATH/env from your login shell (GUI apps don't get it)
  modes.ts           personas (+ Auto)
  classify/          Jev client + router
  memory/            SQLite store, embeddings, hybrid search, folder indexer, context builder, learner
  store.ts           JSON persistence in ~/Library/Application Support/jarvis
src/preload/         typed bridge (window.jarvis)
src/renderer/        React UI
src/shared/types.ts  contracts shared by all three
scripts/smoke.ts     headless adapter test: bun scripts/smoke.ts codex "prompt"
```

## Notes

- Claude Code children load your normal `~/.claude` config (hooks, MCP servers, skills, CLAUDE.md). Your Linear MCP / skills are available to Jarvis automatically.
- In headless mode Claude can't ask permission interactively; actions outside the chosen autonomy are denied, not prompted.
