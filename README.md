# pi-native-swarm

A native pi package for persistent multi-agent work, recovered from Antigravity CLI's bundled `/swarm` contracts and board UI. Workers are real independent pi SDK conversations, not AGY subprocesses. The default dashboard runs **inside pi's terminal**: Overview, Board, Members, communication graph/replay, raw evidence and persisted session transcripts. No browser or server is needed.

## Install

Requires Node.js 22+ and pi. Developed against `@earendil-works/pi-coding-agent` 1.5.2; older pi APIs are not claimed compatible.

```sh
pi install git:github.com/kahme247/PI-SWARM@v1.2.0
```

Restart pi or `/reload`, then:

```text
/swarm Implement the parser changes and independently verify them
/swarm status
/swarm board
```

Try without saving global settings: `pi -e git:github.com/kahme247/PI-SWARM@v1.2.0`. The package does not change your default model or credentials. Workers inherit the caller's provider/model, reasoning level and configured provider registrations. Each worker makes real billable model requests; dormant workers do not. Load only trusted extensions: workers have normal filesystem and shell access. Ownership briefs and workspace separation are coordination, not an OS security sandbox.

## Commands

| Command | Purpose |
| --- | --- |
| `/swarm` | Open the live dashboard inside pi |
| `/swarm <task>` | Give the coordinator a task with swarm guidance |
| `/swarm help` | Command reference |
| `/swarm status` | Roster, model and workspace |
| `/swarm board [--channel <name>]` | Open the in-pi dashboard, optionally filtering a channel |
| `/swarm web` | Explicitly start the optional browser board |
| `/swarm add <name> <brief>` | Start a named worker |
| `/swarm post <message>` | Public coordinator post |
| `/swarm read [since]` | Recent posts or oldest posts after cursor |
| `/swarm title <title>` | Rename the swarm |
| `/swarm models` | List available pi models |
| `/swarm model <name> <provider/model>` | Change an idle member's model without losing context |
| `/swarm kill <name>` | Permanently retire a worker/group |
| `/swarm channel <operation> [channel] [name]` | Create/list/subscribe/unsubscribe/archive |
| `/swarm stop` | Stop execution and any opt-in browser server without deleting history |

Task text beginning with a reserved subcommand is interpreted as that subcommand. Use ordinary prose such as “Investigate …” to start a task.

### Inside pi

Use Tab or 1–5 to switch Overview, Board, Members, Graph and Raw. Arrow/Page keys scroll; End follows the latest posts, Home returns to the beginning. `c` cycles channels and `/` searches board messages. In Members, `j`/`k` select a worker and Enter opens its transcript **in the same terminal screen**. Esc returns from a transcript or closes the dashboard.

`p` posts a message, `a` adds a worker with a public brief, and `t` changes the title. In Members, `m` chooses a model and `x` retires the selected worker after confirmation. On Graph, `-`/`+` step through actual addressed handoffs, Space plays/pauses replay, and `l` returns live. The screen uses pi's renderer/theme and live runtime events; it does not start a second terminal renderer or poll a web endpoint.

Swarm startup is lazy: loading/reloading pi does not open a server, restore a swarm, or load the worker SDK. A swarm is opened when its command/tool is used. If an older loaded version is stuck, cancel the active operation and restart pi (or `/reload` once idle) to load the updated package.

## Agent tools

The package registers `swarm`, `post_message`, `read_board`, `swarm_wait` immediately; unlike AGY, no extra turn is needed before board tools become available.

```javascript
swarm({ action: "channel", op: "create", channel: "parser", topic: "Parsing" })
swarm({ action: "add", name: "parser", channels: ["parser"],
  brief: "Own src/parser.ts only. Implement the agreed interface. Ask verifier to review by #seq.",
  workspace: "share" })
swarm({ action: "add", name: "verifier",
  brief: "Read-only verifier. Check parser evidence and report defects directly to parser." })
post_message({ text: "@parser use the interface specified in #4", channel: "parser" })
read_board({ seqs: [4] })
swarm_wait({ since: 4 })
```

These illustrate tool arguments, not functions to paste into a shell. Full working guidance is in `skills/swarm/SKILL.md`.

### Messaging and lifecycle

- `@name` wakes a member; `@role` wakes numbered `role-N` copies. `@all` broadcasts. `@#channel` addresses a whole active area across channel boundaries; `@#main` is refused.
- `n` starts identical numbered workers; `tasks` starts one per slice with shared `brief`. These are mutually exclusive.
- Members see main plus subscribed channels, their own posts and posts addressing them. Historical visibility is preserved across subscription changes; explicit channel reads can retrieve earlier history.
- Use sequence references instead of reposting reports. `read_board` supports recent messages, cursor pagination and exact `seqs` lookup.
- `swarm_wait` is event-driven and abortable. Pass the highest sequence actually read, not an unread head. Ordinary worker turn completion also parks it. No model requests run just to wait.
- A stopped worker can be revived by an addressed message; a killed name cannot be reused. Killing a parent does not silently kill its helpers.
- Helpers may manage only themselves and workers they added. Coordinator manages arbitrary members. Working members cannot have their model replaced mid-turn.
- Provider failures remain visible on the member; they are not turned into fabricated completion posts. Switch an idle failed worker's model or explicitly address it after quota returns.

### Context and workspaces

Workers normally start with only their public brief plus project instructions. `fork:"coordinator"` or another member copies persisted pi history. Model switches preserve a member's session.

| Workspace | Native implementation | Starting files |
| --- | --- | --- |
| `inherit` | Same working directory | Current shared files |
| `share` | Separate Git worktree | Committed HEAD |
| `branch` | Isolated local Git clone | Committed HEAD |

Uncommitted coordinator edits are **not** copied into isolated workspaces. Commit and integrate isolated changes; do not push unless requested. Killing a worker preserves its isolated directory and branch and reports `retained_workspace`, so unfinished or unmerged work is never silently erased. Remove retained workspaces yourself after integration. Non-Git directories support inherit only.

### Overview, narrator and monitor

The default Overview uses board evidence and optional `SWARM_DIR/plan.json` for goal/task/thread grouping (see `skills/swarm-pane/SKILL.md`). It does not require a token-consuming narrator. Add a `narrator` worker only when desired; its role guide describes cited `view.json`, preferences and optional custom `view.html`. The terminal displays narrator facts as text. Custom HTML is supported only by the opt-in browser view, inside the recovered sandbox with no network or same-origin privileges.

A worker named `monitor` receives a native three-minute daemon timer, not an AGY scheduling dependency. It diagnoses stalls and calls on one member who can unblock progress. `[done] <summary>` posted by the coordinator without a mention marks the job finished. Optional role guides ship with the package (`swarm-pane`, `swarm-narrator`, `swarm-monitor`).

The terminal displays screenshot references as board evidence (`Screenshot: <path> | <caption>`) and opens real persisted pi transcripts internally. The optional browser view also displays listed screenshot images stored under SWARM_DIR (supporting both narrator `view.json` `reel.frames` and auto-extracted board screenshots) and supports the recovered screenshot timeline and sandboxed custom pages.

## Persistence and security

One swarm per coordinator pi session, under pi's agent directory `swarm/<session-id>/`. Board posts, members, worker sessions, isolated workspaces, plan and narrator facts live there. Switching sessions or shutting down stops active workers and closes any opt-in browser server. After resuming the coordinator, the next swarm command/tool restores the roster with workers stopped until addressed. `/swarm stop` preserves files; it is not kill.

Only `/swarm web` starts a browser server. It binds loopback on an ephemeral port and requires a random capability URL. Treat that URL as access to swarm content. Filesystem routes are restricted to known sessions and listed images beneath the swarm directory. There is no public unauthenticated file browser and no remotely writable HTTP control endpoint.

Workers load pi project context and skills but do not recursively load arbitrary installed extensions. Provider definitions are bridged from the coordinator. MCP/third-party worker extension tools are not automatically inherited; the four swarm tools and pi native filesystem/shell tools are supplied by the SDK.

## Recovery and portability

`RECOVERY.md` distinguishes exact recovered assets from native replacements. AGY cloud identity, live credits/quota services, remote Spanner boards and AGY UI docking cannot be reproduced by a standalone pi plugin and are not represented as working integrations. This package implements the local swarm with native pi equivalents; it does not claim a recovered copy of AGY's proprietary cloud or original Go source.

Reproduce the read-only extraction from your installed binary/assets:

```sh
node scripts/recover.mjs <path-to-agy.exe> <antigravity-cli/builtin> recovery
```

The checked-in manifest records binary SHA-256, recovered schema offsets for all four native tools (`swarm`, `post_message`, `read_board`, `swarm_wait`), and hashes for all 19 bundled files. Original extracted files are excluded under ignored `recovery/assets/`; runtime does not depend on that directory or an installed AGY. The bundled plugin did not provide upstream asset licensing information.

## Known limitations

This is not full AGY parity. AGY cloud services and IDE integration are unavailable; terminal narrator validation and freshness reporting differ from the browser view. The `models` tool's `all: true` option currently does not expand the available-model list. Failure recovery, forks and model switching have not been verified end-to-end with a live provider.

## Development

Use an installed pi SDK as the package peer dependency. `npm test` exercises routing, lifecycle, persistence and board security; `npm run pack:check` inspects the distributable without publishing. No runtime dependency install or build step is required beyond pi's host-provided SDK.
