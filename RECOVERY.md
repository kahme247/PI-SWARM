# Recovery record

## Evidence

Source binary: installed `agy.exe`, 231,726,744 bytes, SHA-256 `8803c289cac04d6e53f2211592d9981c2d5760bc0d9b4a7f222ef6ecc7abb38a`.

The installed CLI materialized its bundled assets under `~/.gemini/antigravity-cli/builtin`. Recovery reads only those built-in assets and the executable; it does not read conversations, authentication, private prompts, or user swarm tasks. Original assets are copied unchanged into local ignored `recovery/assets/`; `recovery/manifest.json` records every size/hash. The portable `web/` copies are intentionally adapted.

Recovered asset families:

- `skills/native_swarm`: coordinator responsibilities, helper authority, workers, models, groups, forks, workspace modes, channels, addressing, waits, lifecycle and quota failure semantics.
- `skills/swarm_pane`: newer plan-derived Overview, optional narrator, screenshot evidence format. This supersedes the older instruction to always create a narrator.
- `skills/swarm_monitor`: stall diagnosis, daemon ticks, alert suppression and dormancy.
- `skills/swarm_narrator`: cited Overview schema, threads, preferences, feedback, screenshot reel and untrusted custom-page protocol.
- `plugins/swarm/sidecars/swarm_board`: original app/hive rendering, styles, HTML, channel helpers, narrator bootstrap, server source and integration documentation.

Native executable evidence includes `/swarm board [--channel <name>]`, native swarm package source filenames and workspace validation strings. Four embedded JSON tool schemas and templates were extracted from the binary:

| Tool | Binary byte offset | Recovered behavior |
| --- | --- | --- |
| post_message | 71,352,058 | Required text parameter |
| swarm | 71,445,923 | Template and property fragments: action, name, n, model, all, brief, tasks, workspace, fork, title, channels, op, channel, topic, backend, brief_seq, swarm |
| swarm_wait | 71,627,575 | Required since; mentions_only true; no missed already-posted messages |
| read_board | 71,668,615 | since pagination; default limit 20; exact seqs; status roster |

The extraction script preserves schema text as parsed JSON and records original byte offsets. Other tool shapes are reconstructed from source skills and visible UI contracts, not falsely labelled exact Go source recovery.

## Native conversion

| AGY component | pi implementation |
| --- | --- |
| Native worker conversations | Independent persistent pi SDK AgentSession instances |
| Board/roster | Append-only JSONL plus atomic persisted member state |
| Scheduling | Event-driven wakeups and native unreferenced monitor timer |
| Agent model selection | Configured pi model registry/provider definitions |
| Workspace share/branch | Git worktree / isolated local clone at committed HEAD |
| Conversation fork | pi SessionManager persistent history fork |
| Sidecar server | No server by default; an optional loopback browser board is available through `/swarm web` |
| Host conversation navigation | Persisted pi member transcript viewer inside the terminal |
| Overview/board/graph | Native pi custom screen with keyboard navigation and live runtime events; recovered browser UI retained as opt-in |
| Coordinator skill | Portable installed pi skill and active swarm context injection |

No AGY executable or sidecar SDK is required at runtime. Commands/tools are available immediately rather than AGY's one-turn-late registration. Retirement deliberately preserves isolated workspaces and branches, reporting `retained_workspace` instead of risking uncommitted or unmerged work. This is a documented safety improvement over AGY's destructive workspace cleanup.

## Explicit non-equivalences

The original Go source was not recovered or decompiled. Original source assets and executable strings are evidence for behavior; the runtime is a new implementation.

AGY's cloud backend and identity system, remote/multi-machine Spanner transport, live AI-credit accounting and quota endpoints, IDE docking and its host UI APIs are external services. They are not bundled portable implementations, and this package neither calls them nor supplies fake data. pi model availability reflects configured authentication, not a claimed live credit balance. The native board is scoped to one coordinator runtime on this machine.

No upstream licensing file was present in the recovered swarm plugin. Local recovery is not evidence of permission to republish upstream UI assets. Keep this distinction when distributing the package.
