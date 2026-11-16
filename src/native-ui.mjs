import { readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Input, matchesKey, truncateToWidth, wrapTextWithAnsi, visibleWidth } from '@earendil-works/pi-tui';
import { generateBigBee, generateMiniBee, memberColorAnsi } from './bee-sprite.mjs';

const tabs = ['Overview', 'Board', 'Members', 'Graph', 'Raw'];
const clean = value => String(value ?? '')
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '')
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f]/g, '');
const stateOf = m => m.state ?? m.status ?? 'waiting';
const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(c => c.type === 'text' ? c.text : c.type === 'toolCall' ? `[${c.name}] ${JSON.stringify(c.arguments)}` : '').filter(Boolean).join('\n');

function padToWidth(str, width) {
  const vis = visibleWidth(str);
  const diff = width - vis;
  return diff > 0 ? str + ' '.repeat(diff) : str;
}

function transcript(member) {
  const file = member?.sessionFile ?? member?.session_file;
  if (!file) return ['No persisted session yet.'];
  let fd;
  try {
    const size = statSync(file).size, start = Math.max(0, size - 256 * 1024);
    const bytes = Buffer.alloc(Math.min(size, 256 * 1024));
    fd = openSync(file, 'r'); readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.toString('utf8').split('\n');
    if (start) lines.shift();
    return [file, ...(start ? ['Showing the most recent 256 KiB of session history.'] : []), ...lines.flatMap(line => {
      try { const entry = JSON.parse(line), m = entry.message; return m ? [`${m.role}${m.toolName ? ` (${m.toolName})` : ''}  ${entry.timestamp ?? ''}`, textOf(m), ''] : []; } catch { return []; }
    })];
  } catch (error) { return [`Cannot read session: ${error.message}`]; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function parseDone(text) {
  const doneRegex = /^\s*\[done\]\s*|^\s*✓\s*done\s*/i;
  const isDone = doneRegex.test(text);
  const cleanText = text.replace(doneRegex, '');
  return { isDone, cleanText };
}

function highlightMentions(text) {
  return text.replace(/(@[a-zA-Z0-9_\-#]+)/g, '\x1b[38;2;210;168;255m$1\x1b[0m');
}

/** One pi-owned screen; never starts a renderer, HTTP server, or model request. */
export class SwarmDashboard {
  constructor(runtime, tui, theme, keybindings, done, state = {}) {
    Object.assign(this, { runtime, tui, theme, keybindings, done, state });
    state.tab ??= 1; // Default to Board tab
    state.channel ??= '*';
    state.query ??= '';
    state.selected ??= 0;
    state.selectedPost ??= 0;
    state.offset ??= 0;
    state.follow ??= true;
    this.input = new Input({ prompt: 'Search: ' });
    this.input.onSubmit = value => { state.query = value; state.offset = 0; this.searching = false; this.input.focused = false; this.refresh(); };
    this.input.onEscape = () => { this.searching = false; this.input.focused = false; this.refresh(); };
    this.changed = () => {
      this.snapshot = runtime.snapshot();
      const msgs = this.messages();
      if (state.follow && msgs.length) {
        state.selectedPost = msgs.length - 1;
      }
      this.invalidate();
      tui.requestRender();
    };
    runtime.on('change', this.changed);
    this.snapshot = runtime.snapshot();
    const msgs = this.messages();
    if (state.follow && msgs.length) state.selectedPost = msgs.length - 1;
  }
  set focused(value) { this._focused = value; this.input.focused = value && !!this.searching; }
  get focused() { return this._focused; }
  invalidate() { this.cached = undefined; this.input.invalidate(); }
  refresh() { this.invalidate(); this.tui.requestRender(); }
  dispose() { this.runtime.off('change', this.changed); clearInterval(this.playing); }
  selectedMember() {
    const members = this.snapshot.members;
    this.state.selected = Math.max(0, Math.min(this.state.selected, members.length - 1));
    return members[this.state.selected];
  }
  readJson(name) {
    try {
      const file = join(this.runtime.dir, name), stat = statSync(file);
      if (stat.size > 64 * 1024) return null;
      this.files ??= new Map();
      const prior = this.files.get(name);
      if (prior?.mtime === stat.mtimeMs) return prior.value;
      const value = JSON.parse(readFileSync(file, 'utf8'));
      this.files.set(name, { mtime: stat.mtimeMs, value });
      return value;
    } catch { return null; }
  }
  messages() {
    const query = this.state.query.toLowerCase();
    return this.snapshot.messages.filter(m =>
      (this.state.channel === '*' || (m.channel || 'main') === this.state.channel) &&
      (!query || `${m.agent} ${m.text}`.toLowerCase().includes(query))
    );
  }

  renderBoard(width, rows) {
    const s = this.snapshot;
    const msgs = this.messages();
    const members = s.members;
    const waitingCount = members.filter(m => stateOf(m) === 'waiting' || stateOf(m) === 'stopped').length;
    const anyWorking = members.some(m => stateOf(m) === 'working');

    // 1. Header (Big Bee + Title)
    const bigBee = generateBigBee('coordinator', anyWorking ? 'working' : 'waiting');
    const followBadge = this.state.follow ? '\x1b[38;2;73;214;117m[follow: on]\x1b[0m' : '\x1b[38;2;138;144;152m[follow: off]\x1b[0m';
    const headerTitle = `\x1b[1;38;2;138;180;248mSwarm board\x1b[0m \x1b[1m"${s.title}"\x1b[0m · ${msgs.length} posts · ${followBadge}`;

    const subTitle = (this.state.channel !== '*' ? `\x1b[38;2;154;160;166mchannel: #${this.state.channel}\x1b[0m` : '') +
      (this.state.query ? ` \x1b[38;2;255;210;80m[search: ${this.state.query}]\x1b[0m` : '');
    const header = [
      `${bigBee[0]}`,
      `${bigBee[1]}   ${headerTitle}`,
      `${bigBee[2]}${subTitle ? `   ${subTitle}` : ''}`,
      `${bigBee[3]}`,
      ''
    ];

    // 2. Roster Section
    const rosterHeader = `\x1b[38;2;154;160;166mRoster · ${members.length} members, ${waitingCount} waiting\x1b[0m`;
    const rosterLines = [rosterHeader];

    const idealCols = Math.min(members.length, Math.floor((width - 2) / 20));
    const maxCols = Math.max(1, idealCols);
    const cardWidth = Math.floor((width - 2) / maxCols);

    for (let i = 0; i < members.length; i += maxCols) {
      const chunk = members.slice(i, i + maxCols);
      const rowZ = [];
      const row1 = [];
      const row2 = [];
      const row3 = [];

      for (const m of chunk) {
        const isCoord = m.name === 'coordinator';
        const st = stateOf(m);
        const isWaiting = st === 'waiting' || st === 'stopped';
        const mini = generateMiniBee(m.name, st);
        const nameText = memberColorAnsi(m.name, m.name) + (isCoord ? ' 👑' : '');
        const statusText = isWaiting ? '\x1b[38;2;138;144;152mo waiting\x1b[0m' : '\x1b[38;2;73;214;117m* working\x1b[0m';

        let modelClean = String(m.model ?? 'No model').replace(/^[^/]+\//, '');
        if (modelClean.length > 17) modelClean = modelClean.slice(0, 16) + '…';
        const modelText = `\x1b[38;2;128;134;139m${modelClean}\x1b[0m`;

        rowZ.push(padToWidth(isWaiting ? '  \x1b[38;2;140;144;166mz\x1b[0m' : '', cardWidth));
        row1.push(padToWidth(`${mini[0]} ${nameText}`, cardWidth));
        row2.push(padToWidth(`${mini[1]} ${statusText}`, cardWidth));
        row3.push(padToWidth(`   ${modelText}`, cardWidth));
      }
      rosterLines.push(rowZ.join(''));
      rosterLines.push(row1.join(''));
      rosterLines.push(row2.join(''));
      rosterLines.push(row3.join(''));
      rosterLines.push('');
    }

    const topLines = [...header, ...rosterLines];

    if (msgs.length) {
      this.state.selectedPost = Math.max(0, Math.min(this.state.selectedPost, msgs.length - 1));
    }
    const selectedMsg = msgs[this.state.selectedPost];

    // 4. Message Detail Preview Pane (Bottom)
    const previewLines = [];
    if (selectedMsg) {
      const { isDone: selDone, cleanText: selClean } = parseDone(selectedMsg.text);
      const selDoneTag = selDone ? ' \x1b[38;2;73;214;117m✓ done\x1b[0m' : '';
      const exactTime = selectedMsg.time ?? '';
      previewLines.push(`\x1b[38;2;154;160;166mMessage · #${selectedMsg.seq} ${selectedMsg.agent}${selDoneTag} · ${exactTime}\x1b[0m`);
      const wrapped = wrapTextWithAnsi(highlightMentions(clean(selectedMsg.text)), Math.max(1, width - 2));
      previewLines.push(...wrapped.slice(0, Math.min(6, Math.max(2, Math.floor(rows * 0.2)))));
    }

    // 3. Posts Table (Middle Area)
    const availableForPosts = Math.max(3, rows - topLines.length - previewLines.length - (previewLines.length ? 1 : 0));
    const postsHeader = `\x1b[38;2;154;160;166mPosts · ${msgs.length} total\x1b[0m`;

    const postRows = [];
    if (!msgs.length) {
      postRows.push('  No matching board posts. Press p to post, / to search, or c to change channel.');
    } else {
      const maxVisiblePosts = Math.max(1, availableForPosts - 1);
      const half = Math.floor(maxVisiblePosts / 2);
      let startIdx = Math.max(0, this.state.selectedPost - half);
      if (startIdx + maxVisiblePosts > msgs.length) {
        startIdx = Math.max(0, msgs.length - maxVisiblePosts);
      }
      const endIdx = Math.min(msgs.length, startIdx + maxVisiblePosts);

      for (let idx = startIdx; idx < endIdx; idx++) {
        const m = msgs[idx];
        const isSelected = idx === this.state.selectedPost;
        const cursor = isSelected ? '\x1b[1;38;2;255;255;255m>\x1b[0m ' : '  ';
        const seqStr = padToWidth(`\x1b[38;2;138;144;152m#${m.seq}\x1b[0m`, 5);
        const timeStr = `\x1b[38;2;110;118;129m${(m.time ?? '').slice(11, 16) || '12:00'}\x1b[0m`;
        const authorStr = padToWidth(memberColorAnsi(m.agent, m.agent), 13);

        const { isDone, cleanText } = parseDone(m.text);
        const doneTag = isDone ? '\x1b[38;2;73;214;117m✓ done\x1b[0m ' : '';

        const firstLine = cleanText.split('\n')[0].trim();
        const snippet = highlightMentions(firstLine);

        const linePrefix = `${cursor}${seqStr} ${timeStr} ${authorStr} ${doneTag}`;
        const prefixWidth = visibleWidth(linePrefix);
        const remainingWidth = Math.max(10, width - prefixWidth - 1);

        const truncatedSnippet = truncateToWidth(snippet, remainingWidth);
        postRows.push(`${linePrefix}${truncatedSnippet}`);
      }
    }

    const postsSection = [postsHeader, ...postRows];

    const allLines = [...topLines, ...postsSection];
    if (previewLines.length) {
      allLines.push('', ...previewLines);
    }
    return allLines.slice(0, rows).map(l => truncateToWidth(l, width));
  }

  body() {
    const s = this.snapshot, member = this.selectedMember();
    if (this.state.transcript) return [`Session: ${this.state.transcript}`, '', ...transcript(s.members.find(m => m.name === this.state.transcript))];

    if (this.state.tab === 0) {
      const plan = this.readJson('plan.json'), view = this.readJson('view.json');
      const source = view ?? plan;
      const refs = item => (Array.isArray(item?.refs) ? item.refs : []).map(ref => ref?.seq ? `#${ref.seq}` : ref?.member ? `@${ref.member}` : '').filter(Boolean).join(', ');
      const workstreams = Array.isArray(view?.workstreams) ? view.workstreams.filter(item => item && typeof item === 'object') : [];
      const attention = Array.isArray(view?.attention) ? view.attention.filter(item => item && typeof item === 'object') : [];
      const out = [
        `\x1b[1;38;2;255;210;80m${clean(source?.goal?.title ?? s.title)}\x1b[0m`,
        `\x1b[38;2;200;200;200m${clean(source?.goal?.line ?? view?.headline ?? 'Coordinate work, inspect evidence, and hand off by @name.')}\x1b[0m`,
        ''
      ];
      if (view?.headline) out.push(`Narrator: ${clean(view.headline)}`);
      if (view?.running_summary) out.push(`Now: ${clean(view.running_summary)}`);
      if (view?.phase?.label) out.push(`Phase: ${clean(view.phase.label)}${view.phase.index != null && view.phase.total != null ? ` (${clean(view.phase.index)}/${clean(view.phase.total)})` : ''}`);
      for (const thread of (Array.isArray(source?.threads) ? source.threads.filter(item => item && typeof item === 'object') : [])) {
        out.push('', `\x1b[1m${clean(thread.title)}\x1b[0m: ${clean(thread.goal ?? '')}`);
        if (thread.now) out.push(`  Now: ${clean(thread.now)}`);
        const ids = Array.isArray(thread.workstreams) ? thread.workstreams : Array.isArray(thread.tasks) ? thread.tasks : [];
        for (const id of ids) {
          const work = workstreams.find(item => item.id === id);
          if (!work) { out.push(`  ${clean(id)}`); continue; }
          const progress = work.progress?.done != null && work.progress?.total != null ? ` ${clean(work.progress.done)}/${clean(work.progress.total)}` : '';
          out.push(`  [${clean(work.state ?? 'unknown')}] ${clean(work.title ?? work.short?.title ?? work.id)}${progress}${work.note ? `: ${clean(work.note)}` : ''}${refs(work) ? ` (${clean(refs(work))})` : ''}`);
        }
      }
      const listed = new Set((Array.isArray(source?.threads) ? source.threads : []).flatMap(thread => Array.isArray(thread?.workstreams) ? thread.workstreams : []));
      for (const work of workstreams.filter(item => !listed.has(item.id))) {
        const progress = work.progress?.done != null && work.progress?.total != null ? ` ${clean(work.progress.done)}/${clean(work.progress.total)}` : '';
        out.push(`  [${clean(work.state ?? 'unknown')}] ${clean(work.title ?? work.short?.title ?? work.id)}${progress}${work.note ? `: ${clean(work.note)}` : ''}${refs(work) ? ` (${clean(refs(work))})` : ''}`);
      }
      for (const item of attention) out.push(`[${clean(item.kind)}] ${clean(item.title ?? item.short?.title ?? item.id)}: ${clean(item.why ?? item.short?.line ?? '')}${refs(item) ? ` (${clean(refs(item))})` : ''}`);
      for (const [label, items] of [['Milestone', view?.milestones], ['Risk', view?.risks]]) {
        for (const item of (Array.isArray(items) ? items.filter(item => item && typeof item === 'object') : [])) out.push(`${label}: ${clean(item.text ?? item.title ?? '')}${refs(item) ? ` (${clean(refs(item))})` : ''}`);
      }
      out.push('');
      for (const m of s.members) {
        const last = s.messages.findLast(p => p.agent === m.name);
        out.push(
          `${m.name}  ${stateOf(m)}${m.error ? '  \x1b[31mERROR\x1b[0m' : ''}`,
          `  ${plan?.tasks?.[m.name] ?? m.brief ?? (m.role === 'coordinator' ? 'Coordinate the swarm' : '')}`,
          ...(m.error ? [`  \x1b[31m${m.error}\x1b[0m`] : []),
          ...(last ? [`  #${last.seq} ${last.text}`] : []),
          ''
        );
      }
      if (s.members.length === 1) out.push('No workers yet. Press a to add a worker, or Esc to return to the task.');
      return out;
    }

    if (this.state.tab === 2) {
      return s.members.flatMap(m => [
        `${m === member ? '>' : ' '} ${m.name}  ${stateOf(m)}  ${m.role ?? 'worker'}`,
        `  ${m.model ?? 'No selected model'}  |  ${m.workspace ?? 'inherit'}  |  ${(m.channels ?? []).join(', ')}`,
        `  Read #${m.last_read_seq ?? 0}; last post #${m.last_post_seq ?? 0}${m.error ? `; \x1b[31mERROR: ${m.error}\x1b[0m` : ''}`,
        ...(m.cwd ? [`  ${m.cwd}`] : []),
        ''
      ]);
    }

    if (this.state.tab === 3) {
      const end = Math.min(this.state.replay ?? s.head, s.head), edges = new Map();
      for (const m of s.messages.filter(m => m.seq <= end)) for (const target of m.targets ?? []) {
        if (target === m.agent) continue;
        const key = `${m.agent} -> ${target}`; edges.set(key, (edges.get(key) ?? 0) + 1);
      }
      return [
        `Communication graph: through #${end} of #${s.head}${this.state.replay === undefined ? ' (live)' : ' (replay)'}`,
        '-/+ step   Space play/pause   l live',
        '',
        ...[...edges].map(([edge, count]) => `${edge}  (${count} post${count === 1 ? '' : 's'})`),
        ...(!edges.size ? ['No addressed handoffs at this position.'] : []),
        '',
        ...(s.messages.filter(m => m.seq === end).flatMap(m => [`#${m.seq} ${m.agent}`, m.text]))
      ];
    }

    return JSON.stringify({ ...s, messages: this.messages() }, null, 2).split('\n');
  }

  render(width) {
    const rows = Math.max(1, (this.tui.terminal?.rows ?? 30) - 3);
    if (rows < 8) return ['Swarm', 'Enlarge the terminal to view the dashboard.', 'Esc returns to pi.'].slice(0, rows).map(line => truncateToWidth(line, width));

    if (this.searching) {
      return this.input.render(width);
    }

    if (this.state.tab === 1 && !this.state.transcript) {
      return this.renderBoard(width, rows);
    }

    const key = `${width}:${rows}:${this.state.tab}:${this.state.offset}`;
    if (this.cached?.key === key) return this.cached.lines;

    const bigBee = generateBigBee('coordinator', 'waiting');
    const header = [
      `${bigBee[0]}   ${tabs.map((name, i) => this.state.tab === i ? `\x1b[1;38;2;255;200;80m${i + 1} [${name}]\x1b[0m` : `\x1b[38;2;140;140;140m${i + 1} ${name}\x1b[0m`).join('  ')}`,
      `${bigBee[1]}   \x1b[1;38;2;138;180;248mSwarm | ${this.snapshot.title}\x1b[0m`,
      `${bigBee[2]}   ${this.state.channel !== '*' ? `\x1b[38;2;140;140;140mchannel: #${this.state.channel}\x1b[0m` : ''}${this.state.query ? ` \x1b[38;2;255;210;80m[search: ${this.state.query}]\x1b[0m` : ''}`,
      `${bigBee[3]}`,
      ''
    ];

    const availableHeight = Math.max(3, rows - header.length);
    const rawBody = this.body();
    const bodyLines = rawBody.flatMap(line => wrapTextWithAnsi(clean(line), Math.max(1, width - 2)));

    this.state.offset = Math.max(0, Math.min(this.state.offset, Math.max(0, bodyLines.length - availableHeight)));
    const content = bodyLines.slice(this.state.offset, this.state.offset + availableHeight);
    while (content.length < availableHeight) content.push('');

    const lines = [...header, ...content].slice(0, rows).map(line => truncateToWidth(line, width));
    this.cached = { key, lines };
    return lines;
  }

  handleInput(data) {
    if (this.searching) { this.input.handleInput(data); this.refresh(); return; }
    const s = this.state;
    const msgs = this.messages();

    if (matchesKey(data, 'escape') || data === 'q') {
      if (s.transcript) { s.transcript = undefined; s.offset = 0; this.refresh(); } else this.done(undefined);
      return;
    }
    if (matchesKey(data, 'tab') || matchesKey(data, 'right')) {
      s.tab = (s.tab + 1) % tabs.length;
      s.offset = 0;
    } else if (matchesKey(data, 'shift+tab') || matchesKey(data, 'left')) {
      s.tab = (s.tab + tabs.length - 1) % tabs.length;
      s.offset = 0;
    } else if (/^[1-5]$/.test(data)) {
      s.tab = Number(data) - 1;
      s.offset = 0;
    } else if (matchesKey(data, 'up')) {
      if (s.tab === 1 && msgs.length) {
        s.selectedPost = Math.max(0, s.selectedPost - 1);
        s.follow = false;
      } else {
        s.offset--; s.follow = false;
      }
    } else if (matchesKey(data, 'down')) {
      if (s.tab === 1 && msgs.length) {
        s.selectedPost = Math.min(msgs.length - 1, s.selectedPost + 1);
        if (s.selectedPost === msgs.length - 1) s.follow = true;
      } else {
        s.offset++; s.follow = false;
      }
    } else if (matchesKey(data, 'pageUp')) {
      if (s.tab === 1 && msgs.length) {
        s.selectedPost = Math.max(0, s.selectedPost - 5);
        s.follow = false;
      } else {
        s.offset -= 10; s.follow = false;
      }
    } else if (matchesKey(data, 'pageDown')) {
      if (s.tab === 1 && msgs.length) {
        s.selectedPost = Math.min(msgs.length - 1, s.selectedPost + 5);
        if (s.selectedPost === msgs.length - 1) s.follow = true;
      } else {
        s.offset += 10; s.follow = false;
      }
    } else if (matchesKey(data, 'home')) {
      if (s.tab === 1 && msgs.length) s.selectedPost = 0;
      s.offset = 0; s.follow = false;
    } else if (matchesKey(data, 'end')) {
      if (s.tab === 1 && msgs.length) {
        s.selectedPost = msgs.length - 1;
        s.follow = true;
      }
      s.offset = Number.MAX_SAFE_INTEGER;
    } else if (data === '/') {
      this.searching = true; this.input.setValue(s.query); this.input.focused = true;
    } else if (data === 'c') {
      const channels = ['*', ...this.snapshot.channels.map(c => c.name)];
      s.channel = channels[(channels.indexOf(s.channel) + 1) % channels.length];
      s.offset = 0;
    } else if (s.tab === 2 && (data === 'j' || data === 'k')) {
      s.selected += data === 'j' ? 1 : -1;
      s.selected = Math.max(0, Math.min(this.snapshot.members.length - 1, s.selected));
      s.offset = Math.max(0, s.selected * 5 - 5);
    } else if (s.tab === 2 && matchesKey(data, 'enter')) {
      s.transcript = this.selectedMember()?.name; s.offset = 0;
    } else if (s.tab === 3 && ['-', '+', '='].includes(data)) {
      s.replay = Math.max(0, Math.min(this.snapshot.head, (s.replay ?? this.snapshot.head) + (data === '-' ? -1 : 1)));
    } else if (s.tab === 3 && data === 'l') {
      s.replay = undefined; clearInterval(this.playing); this.playing = undefined;
    } else if (s.tab === 3 && data === ' ') {
      if (this.playing) { clearInterval(this.playing); this.playing = undefined; }
      else {
        s.replay = s.replay ?? 0;
        this.playing = setInterval(() => {
          s.replay = Math.min(this.snapshot.head, s.replay + 1);
          if (s.replay === this.snapshot.head) { clearInterval(this.playing); this.playing = undefined; }
          this.refresh();
        }, 800);
      }
    } else if (['p', 'a', 't'].includes(data) || (s.tab === 2 && ['m', 'x'].includes(data))) {
      this.done({ type: data, member: this.selectedMember()?.name, channel: s.channel });
      return;
    } else return;
    this.refresh();
  }
}

export async function showNativeDashboard(runtime, ctx, { channel } = {}) {
  if (ctx.mode !== 'tui') throw new Error('The embedded swarm board requires interactive pi. Use /swarm status in RPC/print mode.');
  const state = { channel: channel ?? '*', tab: 1 }; // Default to Board
  for (;;) {
    const action = await ctx.ui.custom((tui, theme, keys, done) => new SwarmDashboard(runtime, tui, theme, keys, done, state));
    if (!action) return;
    try {
      if (action.type === 'p') {
        const text = await ctx.ui.input('Post to swarm', '@member message');
        if (text?.trim()) await runtime.post('coordinator', { text, ...(action.channel !== '*' ? { channel: action.channel } : {}) });
      } else if (action.type === 'a') {
        const name = await ctx.ui.input('Worker name', 'parser'); if (!name?.trim()) continue;
        const brief = await ctx.ui.editor('Public worker brief: ownership, constraints, acceptance'); if (!brief?.trim()) continue;
        await runtime.manage('coordinator', { action: 'add', name: name.trim(), brief });
      } else if (action.type === 't') {
        const title = await ctx.ui.input('Swarm title', runtime.snapshot().title);
        if (title?.trim()) await runtime.manage('coordinator', { action: 'title', title });
      } else if (action.type === 'x' && action.member !== 'coordinator') {
        if (await ctx.ui.confirm(`Retire ${action.member}?`, 'Permanent. Its workspace and history are preserved.')) await runtime.manage('coordinator', { action: 'kill', name: action.member });
      } else if (action.type === 'm') {
        const { models } = await runtime.manage('coordinator', { action: 'models' });
        const model = await ctx.ui.select(`Model for ${action.member}`, models.map(m => m.id));
        if (model) await runtime.manage('coordinator', { action: 'model', name: action.member, model });
      }
    } catch (error) { ctx.ui.notify(error.message, 'error'); }
  }
}
