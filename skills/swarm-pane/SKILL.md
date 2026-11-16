---
name: swarm-pane
description: >-
  What the coordinator writes so the Swarm UI's Overview can show the swarm's
  goal, its groups of work and a screenshot timeline. Load it before you brief
  and add the first workers to a swarm.
disable-model-invocation: true
---

# The Swarm UI's Overview

The Swarm UI builds its Overview from the board and roster. Two small things
from you make it read well: a plan file, and screenshots your workers flag.

Don't add a narrator; this Overview replaces it. Add one only when the user
asks for it by name.

## Write the plan

Once the workers are added, write `SWARM_DIR/plan.json` where `SWARM_DIR` is
the path given to you in your brief, or if not given, the standard swarm
directory for this coordinator conversation.

```json
{"goal": {"title": "Fix Hub split pane layouts", "line": "Audit, fix, then verify in both themes."},
 "tasks": {"auditor": "Audit split panes across states", "fixer": "Put split panes in one card"},
 "threads": [{"id": "t-split", "title": "Split pane cards", "goal": "Panes share one card with clean headers.",
              "tasks": ["auditor", "fixer"]}]}
```

-   `goal.title` is 4 to 8 words and `goal.line` at most 12 words.
-   `tasks` names each worker's piece in a few words.
-   `threads` are 1 to 6 groups by the outcome they deliver, never by agent,
    and every worker sits in exactly one thread.
-   Rewrite the file when you add workers, move work, or the goal changes;
    nothing else. Status, blockers and asks come from the board, so never put
    them here.

> [!NOTE]
> `SWARM_DIR` for a pi-native-swarm runtime corresponds to the directory the
> runtime uses for board and roster files (reported as `dir` in `/swarm board`'s
> Overview tab). Screenshots must also be reachable from that directory for the
> web board (`/swarm web`) to serve them.

## Screenshots for the timeline

When the user asked for a change they can see (UI, layout, visuals), tell each
worker who takes screenshots, in its brief, to flag the ones that show a step
on its own line of the post:

```
Screenshot: <absolute path> | what changed, at most 10 words
```

-   The path must be an absolute path to a `.png`, `.jpg`, `.jpeg`, or `.webp`
    image file. The web board (`/swarm web`) serves screenshots from anywhere
    within the runtime's data scope; the terminal board shows them as file paths.
-   Same screen, size and theme each time, full window, no crops or diffs.
-   Skip this for backend, infra, data or docs work.
