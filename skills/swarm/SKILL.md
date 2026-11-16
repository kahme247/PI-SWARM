---
name: swarm
description: Coordinate several native pi agents working concurrently through a persistent shared message board. Use for independently runnable slices and peer verification.
---

# Coordinate a native pi swarm

The user talks to the coordinator. Workers have their own persistent pi conversations and collaborate through a shared board. Tools: `swarm`, `post_message`, `read_board`, `swarm_wait`.

## Start deliberately

Read enough to split the task into genuinely independent pieces. Give every author explicit file ownership; never assign the same file to concurrent authors. Keep shared interfaces explicit. Briefs are public and are the worker's entire initial context unless you use `fork`.

1. `swarm{action:"title",title:"Short meaningful goal"}`.
2. Create area channels if several areas need independent traffic: `swarm{action:"channel",op:"create",channel:"parser",topic:"Parsing and validation"}`.
3. Add workers named for their job: `swarm{action:"add",name:"parser",brief:"Own src/parser.ts only. Implement the agreed interface ... Do not edit other files. Post @verifier with evidence when ready.",channels:["parser"]}`.
4. Add a read-only verifier for every two to four authors. Verifiers report to authors, not edit their files. Delegate technical work, including builds/tests/research and review fixes; keep coordinator turns short and responsive.
5. Tell the user to open `/swarm board` **inside pi**. The tools' `open_board` value is that native command, not a URL. Never start `/swarm web` unless the user wants the optional browser view.

Omit `model` to inherit the calling member's selected model. Never independently switch models for variety or cost. Switch only at user request or an explicit quota/capacity failure; explain the reason. `swarm{action:"models"}` lists pi's configured models; provider credit balances are not available through pi.

Use `n` for identical numbered copies or `tasks` for one slice per numbered copy with shared instructions in `brief`. The group prefix addresses all copies. Names are unique lowercase job names; `all` and `coordinator` are reserved. Killed names cannot be reused.

## Run the board loop

- `swarm{action:"status"}` shows `working`, `waiting`, `stopped`, `killed`, selected model, workspace, channels and failure details.
- Hand work to idle members **by name**. A waiting member costs no model tokens. A stopped member resumes its persisted conversation when addressed. A killed member is permanent; add a fresh named replacement.
- `post_message{text:"@verifier check #4 and #6"}`. Cite sequence numbers instead of re-quoting reports. Mentions are wakeup doorbells, not CCs. Name only the next actor; tag the coordinator for a final deliverable, blocker or decision.
- `read_board{since:LAST}` pages oldest-first. `read_board{seqs:[4,6]}` reads cited posts directly. Omitting `since` reads recent posts. Update LAST only through posts actually read.
- `swarm_wait{since:LAST}` parks until mentioned without model requests. `mentions_only:false` hears any visible post. Never poll the board; never substitute an unread head for LAST. Messages posted while you were working must not be slept through.
- Workers post one final `@coordinator [done]` report describing what happened, the concrete result, verification, and limitations. Do not confuse a quiet worker, `[result]` (turn ended without confirmed completion), or interim update with success.
- The runtime posts one `[swarm-results]` summary per completed set of worker results to the main session. Give the user a concise outcome and any failures or unfinished work. Do not acknowledge notifications already handled, reply just to say thanks, or mention finished workers unless assigning genuinely new work.
- If all task workers are waiting and the goal is unfinished, the coordinator must hand out the next step. Nothing is coming otherwise.
- Before reporting final completion, `post_message{text:"[done] <summary>"}` with no mention so monitoring can go dormant.

## Ownership, context and workspaces

Workers may add helpers, kill their own helpers, and switch themselves or their own helpers. Only the coordinator may rename the swarm or manage arbitrary members. Killing a parent does not kill its helpers. Review orphan helpers explicitly.

`fork:"coordinator"` or another member copies persisted conversation context rather than starting cold. It does not copy arbitrary uncommitted files. Default `workspace:"inherit"` shares the coordinator working directory. `share` creates a Git worktree at repository HEAD; `branch` creates an isolated local clone at HEAD. Uncommitted coordinator edits are not in either isolated workspace. Brief authors accordingly. Authors commit in their own workspace; land changes before killing them. Never push without user request or destroy unmerged work.

## Channels

Everyone sees `main`; coordinator, narrator and monitor see all channels. Keep area chatter out of main. Add `channels:["parser"]` to a worker to subscribe; its first area is its default posting channel. Helpers inherit their creator's subscriptions.

`channel` operations: `create`, `list`, `subscribe`, `unsubscribe`, `archive`. Subscription changes affect later posts, not historical visibility. A member may explicitly read a channel's history with `read_board{channel:"parser"}`; `channel:"*"` reads all channels.

`@name` and group mentions reach across channels. `@all` wakes every member. `@#parser` wakes subscribers of an existing active channel and global roles; `@#main` is refused. Archive an area to prohibit new posts while retaining history.

## Overview and role workers

The built-in Overview derives state from board evidence. Do not add a narrator unless the user asks for it. Write `SWARM_DIR/plan.json` when grouping work helps:

```json
{"goal":{"title":"Rewrite and verify the parser","line":"Implement, review, and exercise edge cases."},"tasks":{"parser":"Implement parser","verifier":"Verify behavior"},"threads":[{"id":"t-parser","title":"Parser","goal":"Reliable parsing","tasks":["parser","verifier"]}]}
```

Plan files describe goals and ownership, never invented progress. Board posts determine progress and blockers. For visible product changes, workers may post `Screenshot: <absolute path under SWARM_DIR> | short caption` to add real evidence to the timeline. Do not add screenshots for backend work.

Optional narrator: brief a worker named `narrator` with `SWARM_DIR` and the narrator skill. It writes cited `view.json` facts and user-requested sandboxed `view.html`, never board chatter. Relay feedback exactly as `@narrator user feedback: <user words>`; omit @ signs inside the quoted feedback.

A monitor is for stalls, not busy workers. Read status and cite unread results, unanswered mentions, or dependency cycles by #seq; address one member who can act, never broadcast or repeatedly acknowledge alerts. A long model call/build is not itself a stall. Quota failures retain context: switch the failed worker's model when idle, or re-address it when quota is restored; do not kill and recreate it.

The board is durable. After compaction use status, exact sequence reads and board history instead of assuming lost conversation context. `/swarm stop` closes runtime activity without killing members; addressed posts later revive stopped members.
