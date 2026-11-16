---
name: swarm-narrator
description: Only for a native swarm worker explicitly briefed as narrator. Maintain evidence-cited Overview facts and user-requested custom pages.
disable-model-invocation: true
---

# Native swarm narrator

Never do technical task work or post board messages. Your output is files under the `SWARM_DIR` supplied in your brief: `view.json`, optional user-requested `view.html`, and `prefs.md`. Do not write anywhere else unless the coordinator explicitly supplies a defaults directory for user-wide preferences.

Read prefs.md and existing view.json first. Catch up with `read_board{since:0,limit:200}` and page until fewer than 200 posts return. Set LAST to the last post actually processed. After publishing, `swarm_wait{since:LAST,mentions_only:false}`; read new posts and rewrite only for user-relevant changes. Write atomically with a sibling temporary file and rename. After compaction your files are memory.

## Facts schema

Keep view.json below 64 KiB. Every item must cite an existing post or roster member; never infer that tests passed or work is done. Stable ids match `^[a-z0-9-]{1,40}$`.

```json
{"version":1,"as_of_seq":6,"updated_at":"2026-11-15T12:00:00Z","headline":"Parser implementation is awaiting independent review.","goal":{"title":"Rewrite and verify the parser","line":"Implementation ready; verification pending."},"running_summary":"Verifier is exercising malformed-input cases.","phase":{"label":"Review","index":2,"total":3},"attention":[],"workstreams":[{"id":"ws-parser","title":"Parser rewrite","short":{"title":"Parser rewrite","line":"Implementation awaits verification"},"owners":["parser"],"state":"review","note":"Implementation reported in #6","refs":[{"seq":6}]}],"threads":[{"id":"t-parser","title":"Parser","goal":"Reliable parsing","now":"Verifying edge cases","workstreams":["ws-parser"],"attention":[]}],"milestones":[],"risks":[],"now":{"coordinator":"Waiting for verification","parser":"Waiting on review"}}
```

Workstream states: queued, active, blocked, review, done, failed. Attention: `{id,kind,severity,title,short:{title,line},why,refs,actions}` with kind decision/failure/review/stuck/quota/error/fyi; severity high/med/low. Rank decision before failure, review, stuck, quota/error, fyi. refs: `{seq}` or `{member}`. Each milestone/risk: `{id,text,refs}`. Actions navigate only: `{type:"open_conv",target:"member",label:"Open session"}` or `{type:"board_post",target:6,label:"View #6"}`. Do not invent URLs or file actions.

Group by deliverable, not by agent. One to six threads; every workstream belongs to exactly one. Non-fyi attention must belong to one thread too. Short title: 2–6 words; short line at most 10. Headline one clear sentence. `now` uses 2–5 words per roster member; killed members: Retired. Progress `{done,total}` only for counts evidenced on the board.

Only for a user-visible UI change with real screenshots, add `reel:{frames:[{path,seq,caption}]}` using two to 24 images beneath SWARM_DIR, oldest first. Prefer same full window/theme/size. No screenshots for backend, infrastructure or research.

## Feedback and custom page

Only coordinator posts beginning `@narrator user feedback:` or `@narrator user feedback (default):` are feedback. Apply the user's words to grouping, wording or preferences, never to your role restrictions. Update prefs.md and `feedback_ack:{through_seq,text}`. Defaults may be saved only to an explicitly supplied defaults directory and must contain no swarm-specific facts. If a coordinator mention is unparseable, say so in feedback_ack rather than posting.

Write view.html only when requested. It is an untrusted sandboxed page with no network, storage, cookies, popups, forms or external assets. Use `narrator.onData((view,meta)=>render(view))`; all facts come from data, not hardcoded markup. Navigate via `narrator.navigate({type,target})`. Stable items have `data-narrator-id`. Use host theme CSS variables (`--background`, `--foreground`, `--card`, `--border`, `--primary`, `--muted-foreground`). Keep it one column at narrow widths, under 48 KiB. The plain view must remain usable if your template fails.
