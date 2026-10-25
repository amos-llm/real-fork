# real-fork

Fork a **pi** agent so the provider's **prefix cache still answers the first turn**, and so the fork opens with the whole conversation in its timeline.

Paseo's built-in Fork builds a `<chat-history-summary>` text attachment and starts a brand-new session from it: different tokens, different session id, cache miss. `real-fork` copies pi's own session instead.

## The two things that decide the cache hit (measured)

Against `opencode-go/deepseek-v4.1-flash`, forking this session's 248k-token branch:

| fork file                  | first turn                                |
| -------------------------- | ----------------------------------------- |
| new session id             | `input 248 384`, `cacheRead 0`, $0.037    |
| **source session id kept** | `input 299`, `cacheRead 248 192`, $0.0008 |

1. **The messages must be byte-identical.** The branch entries are copied verbatim; nothing is summarized or re-rendered.
2. **The header must keep the source session id.** pi hands the session id to the provider as `prompt_cache_key`, so a fork with a fresh id re-prefills the whole branch even though the prefix matches. Keeping the id makes the fork share the source's cache key — several forks of the same agent all hit the same warm prefix.

## What it does

1. Resolve the source session file — Paseo records it as `persistence.nativeHandle`, with an id scan of `~/.pi/agent/sessions` (or `PI_CODING_AGENT_SESSION_DIR`) as fallback.
2. Follow `parentId` from the active leaf to the root and cut it at a chosen user message.
3. Write `<cwd>/.pi/forks/<timestamp>_<suffix>.jsonl`: the source header (id kept, `parentSession` recorded) + the copied entries + a `session_info` naming the fork `<parent title> · fork`. `session_info` never reaches the model, so naming costs no context.
4. Create a new workspace in the same directory (its own sidebar entry), then hand the file to the daemon's import path **targeting that workspace**: the fork opens from the file, so the timeline replays the whole history.

Step 4 matters in two ways. First, the import path opens the agent **from that file**, which is why the fork's timeline replays the whole history. (Creating an agent and then patching its session file does not work — the daemon keeps the live pi process, which never reloads the patched file.) Second, the import must target the new workspace: an untargeted import always lands in the oldest active workspace for the cwd — the parent's — where the fork would be a tab, not a conversation of its own. The `paseo` CLI cannot target a workspace, so the plugin drives the daemon client directly (same wire request, one extra field).

## Installing

Directory plugins are built in place, so the plugin's own dependencies must be present before the daemon compiles it:

```bash
cd real-fork
npm install               # the daemon build resolves types from node_modules
paseo plugin install ~/real-fork
```

If the daemon reports `Could not resolve type dependency "@getpaseo/client"`, `npm install` was skipped (or the checkout is fresh).

## Using it

A composer pill on pi agents only:

```
Real fork  ▾
┌──────────────────────────────────────────────┐
│ Fork without losing the cache                │
│ Copies the pi session, cut at a user         │
│ message, same cache key, same cwd            │
│ latest  168 entries · 2m ago                 │
│ How does the daemon pick a provider?         │
│ 163 entries · 6m ago                         │
│ ‹Forked 168 entries (1 dropped)›              │
│ ✓ Parent task · fork · new sidebar entry      │
└──────────────────────────────────────────────┘
```

- **A user message row** forks there: the copy ends at that question, which the fork re-answers. Anything after the point — including a half-finished turn — stays with the parent.

Either way the parent is untouched and the fork appears in the sidebar as its own entry, `<title> · fork`, in the same directory.

## Limits

- **pi only.** The fork is built on pi's session JSONL; other providers have no equivalent handle reachable from a plugin.
- **Same cwd.** A fork into a new worktree changes the system prompt, so the prefix stops matching and the first turn re-prefills. The pill always forks in place.
- **Cache TTL.** Fork while the source prefix is still cached (Anthropic 5 min / 1 h; OpenAI-compatible gateways a few minutes of idleness). A fork from an hour ago re-prefills once, then continues normally.
- **Two sessions share one id.** The fork's header keeps the parent's id, so pi (if you point it at both files) sees the same id twice. The fork file lives under `<cwd>/.pi/forks`, outside pi's session directory, so `pi --resume` does not list it.
- **Model/thinking come from the file** (the fork's last `model_change` / `thinking_level_change`), not from Paseo's dropdown. Change them after the fork if you need to.
- **No extra dependency.** The fork drives the local daemon over its WebSocket API (the same client the `paseo` CLI uses), so the CLI is not required to be on the daemon's PATH.

## Layout

```
index.server.ts         contributes real-fork.points / real-fork.fork
server/fork-agent.ts    orchestration: resolve source, slice the branch, hand off to import
server/fork-file.ts     fork path + header/entries (id kept, parentSession, session_info)
server/pi-session.ts    pure JSONL parse / branch / slice / render (tested)
server/pi-session-file.ts  session-file discovery (nativeHandle, id scan, env overrides)
server/daemon-import.ts   daemon-client import into the fork's own workspace (injectable for tests)
index.client.tsx        one composer pill per pi agent
client/fork-popover.tsx fork-point picker + status
client/fork-format.ts   relative time / size labels (tested)
shared/fork.ts          RPC contracts, labels
```

Agent labels: `real-fork.source` (parent agent id) and `real-fork.point` (pi entry id the fork was taken at).

## Development

```bash
npm install
npm run check        # typecheck + lint + test + format:check
npm run format       # oxfmt .
paseo plugin install ~/real-fork
paseo plugin reload real-fork     # after editing a directory plugin
paseo plugin logs real-fork       # one line per fork: entries, dropped, cache key
```
