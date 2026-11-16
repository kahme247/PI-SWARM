import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const helperRole = name => /^(narrator|monitor)(-\d+)?$/.exec(name)?.[1];
const abortError = () => Object.assign(new Error('Swarm wait aborted'), { name: 'AbortError' });
const validName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);

/** Durable message board and independent, serialized-per-member pi sessions. */
export class SwarmRuntime extends EventEmitter {
  constructor({ dir, cwd = process.cwd(), coordinatorId, model, createWorker, onCoordinatorMessage, coordinatorSessionFile, monitorIntervalMs = 180000, listModels, onCoordinatorModel } = {}) {
    super();
    if (!dir) throw new Error('A swarm directory is required');
    Object.assign(this, { dir: path.resolve(dir), cwd: path.resolve(cwd), coordinatorId, model, createWorker, onCoordinatorMessage, coordinatorSessionFile, monitorIntervalMs, listModels, onCoordinatorModel });
    this.id = path.basename(this.dir); this.title = 'Swarm'; this.messages = []; this.members = new Map(); this.channels = new Map();
    this.workers = new Map(); this.pending = new Map(); this.wakeVersions = new Map(); this.running = new Set(); this.waiters = new Set(); this.timers = new Map(); this.queue = Promise.resolve(); this.closed = false;
    this.tasks = new Set();
  }
  init() {
    return this.initializing ??= this._init();
  }
  async _init() {
    await mkdir(path.join(this.dir, 'sessions'), { recursive: true });
    let data;
    try { data = JSON.parse(await readFile(path.join(this.dir, 'members.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (data) {
      this.id = data.id; this.title = data.title;
      for (const channel of data.channels ?? []) this.channels.set(channel.name, channel);
      for (const member of data.members) this.members.set(member.name, { ...member, state: member.state === 'killed' ? 'killed' : member.name === 'coordinator' ? 'waiting' : 'stopped', status: member.state === 'killed' ? 'killed' : member.name === 'coordinator' ? 'waiting' : 'stopped' });
    }
    this.channels.set('main', this.channels.get('main') ?? { name: 'main', topic: 'Shared board', creator: 'coordinator', archived: false });
    if (!this.members.has('coordinator')) this.members.set('coordinator', { name: 'coordinator', conversation_id: this.coordinatorId ?? randomUUID(), model: this.model, role: 'coordinator', state: 'waiting', status: 'waiting', channels: ['main'], last_read_seq: 0, sessionFile: this.coordinatorSessionFile });
    else if (this.coordinatorSessionFile) this.members.get('coordinator').sessionFile = this.coordinatorSessionFile;
    try {
      const text = await readFile(path.join(this.dir, 'board.jsonl'), 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try { this.messages.push(JSON.parse(lines[i])); } catch (error) {
          // An interrupted final append is recoverable; corruption in the middle is not.
          if (i !== lines.length - 1) throw error;
          await writeFile(path.join(this.dir, 'board.jsonl'), this.messages.map(m => JSON.stringify(m) + '\n').join(''));
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this._save(); return this;
  }
  get head() { return this.messages.at(-1)?.seq ?? 0; }
  _actor(actor) {
    const member = this.members.get(typeof actor === 'string' ? actor : actor?.name);
    if (!member || member.state === 'killed') throw new Error('Unknown or killed swarm member');
    return member;
  }
  _privileged(member) { return ['coordinator', 'narrator', 'monitor'].includes(member.role); }
  _state(member, state) { member.state = member.status = state; }
  async _save() {
    const file = path.join(this.dir, 'members.json');
    await writeFile(file + '.tmp', JSON.stringify({ id: this.id, title: this.title, channels: [...this.channels.values()], members: [...this.members.values()] }, null, 2));
    await rename(file + '.tmp', file); this.emit('change');
  }
  syncCoordinatorModel(model) {
    return this._mutate(async () => {
      this.model = model;
      this.members.get('coordinator').model = model;
      await this._save();
    });
  }
  setCoordinatorState(state) {
    return this._mutate(async () => {
      this._state(this.members.get('coordinator'), state);
      await this._save();
    });
  }
  async _mutate(fn) {
    await this.init();
    const result = this.queue.then(() => { if (this.closed) throw new Error('Swarm is closed'); return fn(); });
    this.queue = result.catch(() => {}); return result;
  }
  snapshot() {
    return structuredClone({ id: this.id, title: this.title, head: this.head, dir: this.dir, members: [...this.members.values()].map(m => ({ ...m, session_file: m.sessionFile })), messages: this.messages, channels: [...this.channels.values()].map(c => ({ ...c, subscribers: [...this.members.values()].filter(m => m.state !== 'killed' && (this._privileged(m) || m.channels.includes(c.name))).map(m => m.name) })) });
  }
  _targets(text) {
    const targets = new Set();
    for (const match of text.matchAll(/(?<![\w@./-])@(#?[a-z][a-z0-9-]*)(?![\w-])/gi)) {
      const token = match[1].toLowerCase();
      if (token === '#main') throw new Error('Use @all instead of @#main');
      if (token.startsWith('#')) {
        const channel = this.channels.get(token.slice(1));
        if (channel && !channel.archived) for (const m of this.members.values()) if (this._privileged(m) || m.channels.includes(channel.name)) targets.add(m.name);
      } else for (const m of this.members.values()) if (token === 'all' || m.name === token || m.group === token || m.name.replace(/-\d+$/, '') === token || (token === 'narrator' && m.role === 'narrator') || (token === 'monitor' && m.role === 'monitor')) targets.add(m.name);
    }
    return targets;
  }
  _visible(member, message, channel) {
    if (channel && channel !== '*') return message.channel === channel;
    if (channel === '*' || this._privileged(member)) return true;
    return message.channel === 'main' || message.targets?.includes(member.name) || message.visible_to?.includes(member.name);
  }
  _matches(member, message, since, mentionsOnly) {
    return message.seq > since && message.agent !== member.name && (mentionsOnly && !(member.role === 'monitor' && member.monitor_dormant) ? message.targets?.includes(member.name) : this._visible(member, message));
  }
  async _post(actor, { text, channel }, { route = true, targets: addressed } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Message text must not be empty');
    channel ??= actor.channels.find(c => c !== 'main') ?? 'main';
    const area = this.channels.get(channel);
    if (!area || area.archived) throw new Error('Unknown or archived channel');
    if (!this._privileged(actor) && !actor.channels.includes(channel)) throw new Error('Subscribe before posting to this channel');
    const resultStatus = actor.role === 'worker' ? /^(?:@[a-z][a-z0-9-]*\s+)*\[(done|result|error)\](?:\s|$)/i.exec(text.trim())?.[1].toLowerCase() : undefined;
    const targets = addressed ?? [...this._targets(text)];
    if (resultStatus && !targets.includes('coordinator')) targets.push('coordinator');
    const message = { seq: this.head + 1, agent: actor.name, text, channel, time: new Date().toISOString(), targets, visible_to: [...this.members.values()].filter(m => this._privileged(m) || m.channels.includes(channel)).map(m => m.name) };
    await appendFile(path.join(this.dir, 'board.jsonl'), JSON.stringify(message) + '\n');
    this.messages.push(message); actor.last_post_seq = message.seq; actor.last_post_time = message.time;
    if (resultStatus) actor.last_result = { seq: message.seq, status: resultStatus };
    await this._save();
    if (route) this._route(message);
    if (resultStatus) await this._summarizeResults();
    return { ...message, head: this.head };
  }
  async _summarizeResults() {
    const workers = [...this.members.values()].filter(m => m.role === 'worker' && m.state !== 'killed');
    if (!workers.length || workers.some(m => !m.last_result || this.pending.get(m.name)?.length)) return;
    const coordinator = this.members.get('coordinator');
    const key = workers.map(m => `${m.name}:${m.last_result.seq}`).join(',');
    if (coordinator.last_summary_key === key) return;
    const complete = workers.every(m => m.last_result.status === 'done');
    const lines = workers.map(m => {
      const result = this.messages.find(post => post.seq === m.last_result.seq);
      return `- ${m.name} [${m.last_result.status}] (#${result.seq}): ${result.text}`;
    });
    coordinator.last_summary_key = key;
    await this._post({ name: 'system', channels: ['main'] }, {
      channel: 'main', text: `@coordinator [swarm-results] ${complete ? 'All workers reported completion.' : 'All workers returned results; not all assignments are confirmed successful.'}\n${lines.join('\n')}`,
    }, { targets: ['coordinator'] });
  }
  post(actor, args) { return this._mutate(() => this._post(this._actor(actor), args)); }
  _route(message) {
    const awakened = new Set();
    for (const waiter of [...this.waiters]) if (this._matches(waiter.member, message, waiter.since, waiter.mentionsOnly)) {
      awakened.add(waiter.member.name);
      delete waiter.member.last_result;
      waiter.member.last_wake_seq = message.seq;
      this._resumeMonitor(waiter.member);
      waiter.finish({ head: this.head, messages: this.messages.filter(m => m.seq > waiter.since && this._visible(waiter.member, m)), reason: 'message' });
    }
    for (const member of this.members.values()) {
      if (member.state === 'killed' || member.name === message.agent || awakened.has(member.name)) continue;
      const mentionsOnly = member.wake_mode !== 'anything';
      if (!this._matches(member, message, Math.max(member.wait_since ?? 0, member.last_read_seq ?? 0, member.last_wake_seq ?? 0), mentionsOnly)) continue;
      member.last_wake_seq = message.seq;
      this._resumeMonitor(member);
      if (member.name === 'coordinator') {
        Promise.resolve().then(() => this.onCoordinatorMessage?.(message)).catch(error => this.emit('workerError', { member: member.name, error }));
      } else this._enqueue(member, message);
    }
    if (message.agent === 'coordinator' && /^\[done\](?:\s|$)/i.test(message.text.trim())) {
      for (const timer of this.timers.values()) clearInterval(timer);
      this.timers.clear();
      for (const member of this.members.values()) if (member.role === 'monitor') member.monitor_dormant = true;
    }
  }
  _seen(member, messages) {
    if (!messages.length) return;
    member.last_read_seq = Math.max(member.last_read_seq ?? 0, ...messages.map(m => m.seq));
    const seen = new Set(messages.map(m => m.seq));
    const pending = this.pending.get(member.name)?.filter(m => !seen.has(m.seq));
    if (pending?.length) this.pending.set(member.name, pending);
    else this.pending.delete(member.name);
  }
  read(actor, { since, limit = 20, channel, status = false, seqs } = {}) {
    return this._mutate(async () => {
      const member = this._actor(actor);
      if (channel && channel !== '*' && !this.channels.has(channel)) throw new Error('Unknown channel');
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be 1..1000');
      let messages = this.messages.filter(m => this._visible(member, m, channel));
      if (seqs) messages = messages.filter(m => seqs.includes(m.seq));
      else messages = since === undefined ? messages.slice(-limit) : messages.filter(m => m.seq > since).slice(0, limit);
      this._seen(member, messages);
      await this._save();
      return { messages: structuredClone(messages), head: this.head, ...(status ? { members: this.snapshot().members, tail_from_seq: messages[0]?.seq ?? this.head } : {}) };
    });
  }
  async wait(actor, { since, mentions_only = true, timeout_ms } = {}, signal) {
    await this.init();
    if (signal?.aborted) throw abortError();
    if (this.closed) throw new Error('Swarm is closed');
    const member = this._actor(actor); since ??= member.last_read_seq ?? 0;
    if (!Number.isInteger(since) || since < 0) throw new Error('since must be a nonnegative integer');
    if (timeout_ms !== undefined && (!Number.isFinite(timeout_ms) || timeout_ms < 0)) throw new Error('Invalid wait timeout');
    if (this.messages.some(m => this._matches(member, m, since, mentions_only))) {
      const messages = this.messages.filter(m => m.seq > since && this._visible(member, m));
      this._seen(member, messages);
      await this._mutate(() => this._save());
      return { messages: structuredClone(messages), head: this.head, reason: 'message' };
    }
    return new Promise((resolve, reject) => {
      let timer;
      const previous = member.state;
      const waiter = { member, since, mentionsOnly: mentions_only, finish: (result, error) => {
        if (!this.waiters.delete(waiter)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', aborted);
        if (result?.messages) this._seen(member, result.messages);
        if (member.state !== 'killed' && !this.closed) this._state(member, this.running.has(member.name) ? 'working' : previous === 'stopped' ? 'stopped' : 'waiting');
        this.queue = this.queue.then(() => this._save()).catch(error => this.emit('workerError', { member: member.name, error }));
        error ? reject(error) : resolve(result);
      } };
      const aborted = () => waiter.finish(undefined, abortError());
      this.waiters.add(waiter); this._state(member, 'waiting'); member.wait_since = since; member.wake_mode = mentions_only ? 'mentions' : 'anything';
      if (member.role === 'monitor' && !mentions_only) {
        member.monitor_dormant = true;
        clearInterval(this.timers.get(member.name)); this.timers.delete(member.name);
      }
      this.queue = this.queue.then(() => this._save()).catch(error => this.emit('workerError', { member: member.name, error }));
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
      if (timeout_ms !== undefined) timer = setTimeout(() => waiter.finish({ messages: [], head: this.head, reason: 'timeout' }), timeout_ms);
    });
  }
  _owned(actor, target, self = false) { return actor.name === 'coordinator' || target.added_by === actor.name || (self && target.name === actor.name); }
  async _workspace(member, mode) {
    if (!['inherit', 'share', 'branch'].includes(mode)) throw new Error('workspace must be inherit, share, or branch');
    member.workspace = mode; member.cwd = this.cwd;
    if (mode === 'inherit') return;
    member.cwd = path.join(this.dir, 'workspaces', member.name); member.branch = `swarm/${this.id.replace(/[^a-zA-Z0-9-]/g, '-')}/${member.name}`;
    await mkdir(path.dirname(member.cwd), { recursive: true });
    if (mode === 'share') await exec('git', ['worktree', 'add', '-b', member.branch, member.cwd, 'HEAD'], { cwd: this.cwd });
    else { await exec('git', ['clone', '--no-hardlinks', '--', this.cwd, member.cwd], { cwd: this.cwd }); await exec('git', ['checkout', '-b', member.branch], { cwd: member.cwd }); }
  }
  manage(actor, args = {}) {
    if (args.action === 'kill') return this._kill(actor, args.name);
    return this._mutate(async () => {
      actor = this._actor(actor);
      const { action } = args;
      if (action === 'status') return this.snapshot();
      if (action === 'models') return { models: await this.listModels?.(args) ?? [...new Set([...this.members.values()].map(m => m.model).filter(Boolean))].map(id => ({ id })) };
      if (action === 'title') { if (actor.name !== 'coordinator') throw new Error('Only coordinator may title the swarm'); if (!args.title?.trim()) throw new Error('A title is required'); this.title = args.title.trim(); await this._save(); return this.snapshot(); }
      if (action === 'channel') return this._channel(actor, args);
      if (action === 'add') {
        const { name, brief = '', tasks, n } = args;
        if (args.model !== undefined && (typeof args.model !== 'string' || args.model.indexOf('/') < 1 || args.model.endsWith('/'))) throw new Error('Expected provider/model-id');
        if (!validName(name) || ['all', 'coordinator'].includes(name)) throw new Error('Invalid or reserved member name');
        if (n !== undefined && tasks !== undefined) throw new Error('Use n or tasks, not both');
        const count = tasks ? tasks.length : n ?? 1;
        if (!Number.isInteger(count) || count < 1 || count > 100 || (tasks && !tasks.every(t => typeof t === 'string'))) throw new Error('Invalid worker count/tasks');
        const grouped = tasks !== undefined || n !== undefined;
        const names = Array.from({ length: count }, (_, i) => grouped ? `${name}-${i + 1}` : name);
        if (this.members.has(name) || [...this.members.values()].some(m => m.group === name) || names.some(s => this.members.has(s))) throw new Error('Member names cannot be reused');
        const channels = [...new Set(['main', ...(args.channels ?? actor.channels).filter(c => c !== 'main')])];
        for (const c of channels) if (!this.channels.has(c) || this.channels.get(c).archived) throw new Error('Unknown or archived channel');
        const source = args.fork ? this.members.get(args.fork) : undefined;
        if (args.fork && !source) throw new Error('Unknown fork source');
        const forkSessionFile = source?.sessionFile ?? (args.fork === 'coordinator' ? this.coordinatorSessionFile : undefined);
        if (args.fork && !forkSessionFile) throw new Error('Fork source has no persisted session');
        const added = [];
        try {
          for (let i = 0; i < names.length; i++) {
            const member = { name: names[i], conversation_id: randomUUID(), model: args.model ?? actor.model ?? this.model, role: helperRole(names[i]) ?? 'worker', group: grouped ? name : undefined, added_by: actor.name, channels: [...channels], last_read_seq: this.head, state: 'waiting', status: 'waiting', fork: args.fork, forkSessionFile, brief: [brief, tasks?.[i]].filter(Boolean).join('\n\n') };
            try { await this._workspace(member, args.workspace ?? 'inherit'); }
            catch (error) { if (member.workspace !== 'inherit') error.message += `; workspace may remain at ${member.cwd}`; throw error; }
            this.members.set(member.name, member); added.push(member);
            let message;
            try { message = await this._post(actor, { text: `@${member.name} ${member.brief}`, channel: channels.find(c => c !== 'main') ?? 'main' }, { route: false }); }
            catch (error) {
              this._state(member, 'stopped'); member.error = `Startup brief delivery failed: ${error.message}`;
              error.message += `; ${member.name} was not started; inspect the board before retrying`;
              throw error;
            }
            member.last_read_seq = this.head; member.wait_since = this.head; member.wake_mode = 'mentions';
            this._enqueue(member, message); this._route({ ...message, targets: message.targets.filter(t => !names.includes(t)) });
          }
        } catch (error) {
          await this._save();
          if (added.length) error.message += `; retained members: ${added.map(m => m.name).join(', ')}`;
          throw error;
        }
        await this._save(); return { ...this.snapshot(), added: added.map(m => m.name) };
      }
      const name = args.name ?? actor.name;
      const targets = [...this.members.values()].filter(m => m.name === name || m.group === name);
      if (!targets.length) throw new Error('Unknown member');
      if (action === 'model') {
        if (args.model !== undefined && (typeof args.model !== 'string' || args.model.indexOf('/') < 1 || args.model.endsWith('/'))) throw new Error('Expected provider/model-id');
        for (const member of targets) if (member.state === 'killed' || !this._owned(actor, member, true) || (member.state === 'working' && member.name !== actor.name)) throw new Error('Cannot switch this member model while working, killed, or unowned');
        for (const member of targets) {
          const model = args.model ?? actor.model ?? this.model;
          if (member.name === 'coordinator') { if (!this.onCoordinatorModel) throw new Error('Coordinator model switching is not configured'); await this.onCoordinatorModel(model); }
          else {
            const worker = this.workers.get(member.name);
            if (this.running.has(member.name) && member.name !== actor.name) {
              for (const waiter of [...this.waiters]) if (waiter.member === member) waiter.finish(undefined, abortError());
              await worker?.abort();
            }
            await worker?.setModel(model);
          }
          member.model = model; delete member.error;
          if (member.name !== 'coordinator' && member.name !== actor.name) this._enqueue(member, { seq: this.head, text: 'Model changed. Resume your work from the board.', agent: 'coordinator', channel: 'main' });
        }
        await this._save(); return this.snapshot();
      }
      throw new Error(`Unknown swarm action: ${action}`);
    });
  }
  async _channel(actor, { op = 'list', channel, topic = '', name = actor.name }) {
    if (op === 'list') return { channels: this.snapshot().channels };
    if (op === 'create') {
      if (!validName(channel) || this.channels.has(channel)) throw new Error('Invalid or existing channel');
      this.channels.set(channel, { name: channel, topic, creator: actor.name, archived: false });
    } else {
      const area = this.channels.get(channel); if (!area || channel === 'main') throw new Error('Unknown or immutable channel');
      if (op === 'archive') { if (actor.name !== 'coordinator' && area.creator !== actor.name) throw new Error('Only channel creator or coordinator may archive'); area.archived = true; }
      else if (op === 'subscribe' || op === 'unsubscribe') {
        const targets = [...this.members.values()].filter(m => m.name === name || m.group === name);
        if (!targets.length || targets.some(m => !this._owned(actor, m, true))) throw new Error('Only yourself or your helpers may be moved');
        if (area.archived && op === 'subscribe') throw new Error('Channel is archived');
        for (const member of targets) member.channels = op === 'subscribe' ? [...new Set([...member.channels, channel])] : member.channels.filter(c => c !== channel);
      } else throw new Error('Unknown channel operation');
    }
    await this._save(); return { channels: this.snapshot().channels };
  }
  _enqueue(member, message) {
    if (this.closed || member.state === 'killed') return;
    delete member.last_result;
    const pending = this.pending.get(member.name) ?? []; pending.push(message); this.pending.set(member.name, pending);
    this.wakeVersions.set(member.name, (this.wakeVersions.get(member.name) ?? 0) + 1);
    if (!this.running.has(member.name)) {
      this.running.add(member.name);
      // Defer worker startup until the current board transaction has committed.
      this._schedule(member);
    }
  }
  _schedule(member) {
    const task = new Promise(resolve => setImmediate(resolve)).then(() => this._run(member));
    this.tasks.add(task);
    task.catch(error => this.emit('workerError', { member: member.name, error })).finally(() => this.tasks.delete(task));
  }
  async _run(member) {
    let failed = false;
    let attemptVersion = this.wakeVersions.get(member.name) ?? 0;
    try {
      if (this.closed || member.state === 'killed') return;
      let worker = this.workers.get(member.name);
      if (!worker) {
        if (!this.createWorker) throw new Error('No pi worker factory configured');
        worker = await this.createWorker(member, this);
        if (this.closed || member.state === 'killed') { await worker.abort(); await worker.dispose(); return; }
        this.workers.set(member.name, worker); member.sessionFile = worker.sessionFile;
      }
      this._startMonitor(member);
      while (!this.closed && member.state !== 'killed' && this.pending.get(member.name)?.length) {
        attemptVersion = this.wakeVersions.get(member.name) ?? 0;
        const batch = this.pending.get(member.name); this.pending.delete(member.name);
        const unread = this.messages.filter(m => m.seq > (member.last_read_seq ?? 0) && this._visible(member, m));
        const delivered = [...unread, ...batch.filter(m => !unread.some(u => u.seq === m.seq && u.text === m.text))];
        this._state(member, 'working'); this._seen(member, delivered);
        await this._mutate(() => this._save());
        const startedAt = this.head;
        const result = await worker.prompt(delivered.map(m => `#${m.seq} ${m.agent} [${m.channel}]: ${m.text}`).join('\n\n'));
        member.sessionFile = worker.sessionFile ?? member.sessionFile; delete member.error;
        if (member.role === 'worker' && !this.closed && member.state !== 'killed' && !this.pending.get(member.name)?.length && !(member.last_result?.seq > startedAt)) {
          const text = typeof result === 'string' ? result.trim() : '';
          await this._mutate(() => this._post(member, {
            channel: 'main', text: `@coordinator [result] ${member.name} ended its turn (assignment completion unconfirmed).\n${text || 'No final response was returned.'}`,
          }, { targets: [...new Set(['coordinator', member.added_by ?? 'coordinator'])] }));
        }
      }
    } catch (error) {
      failed = true;
      if (!this.closed && member.state !== 'killed') {
        member.error = String(error.message ?? error);
        this.emit('workerError', { member: member.name, error });
        await this._mutate(() => this._post(member, { text: `@coordinator [error] ${member.name}: ${member.error}`, channel: 'main' }));
      }
    } finally {
      if (!this.closed && member.state !== 'killed') {
        this._state(member, 'waiting'); member.wait_since ??= member.last_read_seq; member.wake_mode ??= 'mentions';
        await this._mutate(() => this._save());
      }
      this.running.delete(member.name);
      if ((!failed || (this.wakeVersions.get(member.name) ?? 0) > attemptVersion) && !this.closed && member.state !== 'killed' && this.pending.get(member.name)?.length) { this.running.add(member.name); this._schedule(member); }
    }
  }
  _resumeMonitor(member) {
    if (member.role !== 'monitor' || !member.monitor_dormant) return;
    member.monitor_dormant = false;
    this._startMonitor(member);
  }
  _startMonitor(member) {
    if (member.role !== 'monitor' || member.monitor_dormant || this.timers.has(member.name)) return;
    const timer = setInterval(() => {
      if (this.closed || member.state === 'killed') return;
      const waiter = [...this.waiters].find(w => w.member === member);
      if (waiter) waiter.finish({ head: this.head, messages: [], reason: 'monitor_tick', instruction: '[monitor] tick: inspect read_board status and detect stalls.' });
      else if (!this.running.has(member.name)) this._enqueue(member, { seq: this.head, agent: 'system', text: '[monitor] tick: inspect read_board status and detect stalls. Post only to break a stall.', channel: 'main' });
    }, this.monitorIntervalMs);
    timer.unref?.(); this.timers.set(member.name, timer);
  }
  async _kill(actor, name) {
    const retired = await this._mutate(async () => {
      actor = this._actor(actor);
      const targets = [...this.members.values()].filter(m => m.name === name || m.group === name);
      if (!targets.length) throw new Error('Unknown member');
      for (const member of targets) if (member.name === 'coordinator' || !this._owned(actor, member)) throw new Error('Only your own helpers may be killed');
      const workers = [];
      for (const member of targets) {
        this._state(member, 'killed'); this.pending.delete(member.name);
        clearInterval(this.timers.get(member.name)); this.timers.delete(member.name);
        for (const waiter of [...this.waiters]) if (waiter.member === member) waiter.finish(undefined, abortError());
        const worker = this.workers.get(member.name);
        this.workers.delete(member.name);
        if (worker) workers.push(worker);
        // Preserve isolated directories, including dirty and unmerged work.
        if (member.workspace !== 'inherit') member.retained_workspace = member.cwd;
      }
      await this._save();
      return workers;
    });
    // Active tools may need the board lock to finish during abort.
    await Promise.all(retired.map(async worker => { await worker.abort(); await worker.dispose(); }));
    return this.snapshot();
  }
  async close() {
    await this.init(); if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers.values()) clearInterval(timer); this.timers.clear();
    for (const waiter of [...this.waiters]) waiter.finish(undefined, abortError());
    const workers = [...this.workers.values()]; this.workers.clear();
    await Promise.allSettled(workers.map(async worker => { await worker.abort(); await worker.dispose(); }));
    await this.queue;
    await Promise.allSettled([...this.tasks]);
    for (const member of this.members.values()) if (member.name !== 'coordinator' && member.state !== 'killed') this._state(member, 'stopped');
    await this._save();
  }
}
