# Changelog

## [1.2.1] - 2026-11-16

- Rename the package to `@kahme247/pi-swarm`.

## [1.2.0] - 2026-11-15

- Add terminal UI features inspired by AGY's live board (not full parity):
  * Halfblock pixel-art bee mascot and dynamic member bee avatars with deterministic hue ramps.
  * Visual Roster cards displaying member sprites, crowns, status dots, and truncated model tags.
  * Structured Posts list with `✓ done` completion badges, cursor navigation (`>`), and `@mention` syntax highlighting.
  * Split-pane bottom message preview displaying the selected post's full multi-line content.
  * Follow mode toggle (`[follow: on]`/`[follow: off]`) with keyboard navigation (`Up`/`Down`/`PageUp`/`PageDown`/`Home`/`End`).
  * Default `/swarm board` and `/swarm` opening directly to the Board view.
- Add `swarm-pane` skill (`skills/swarm-pane/SKILL.md`) providing coordinator instructions for plan-derived Overview (`plan.json`) and visual screenshot evidence conventions.
- Accept `all: true` in the models tool schema; the current implementation still lists available models and does not expand that list.
- Restore progress reel precedence in `web/hive.js` so that narrator-curated `vj.reel.frames` in `view.json` takes priority over auto-extracted board frames.
- Update recovery extraction script (`scripts/recover.mjs`) to capture embedded static schema for `post_message` and dynamic schema template with properties for `swarm` from `agy.exe`, refreshing `recovery/manifest.json`.

## [1.1.0] - 2026-11-15

- Make `/swarm` and `/swarm board` open a live dashboard inside pi, with Overview, Board, Members, communication replay, raw data and session transcripts.
- Support posting, adding workers, selecting models and retiring workers from the native screen.
- Start no HTTP server by default; the recovered browser UI is explicitly opt-in through `/swarm web`.
- Defer worker SDK loading and swarm restoration until a swarm command/tool is used; pi startup no longer waits for swarm initialization.

## [1.0.0] - 2026-11-15

- Recover AGY's bundled swarm skills, board UI and two native JSON tool schemas with reproducible hashes and offsets.
- Add native pi swarm command and four tools, independent persistent workers, messaging, groups, channels, model changes, forks and Git workspace isolation.
- Adapt the full live board to a secured loopback server and persisted pi transcripts.
- Include portable coordinator/narrator/monitor guidance and document external AGY service boundaries.
