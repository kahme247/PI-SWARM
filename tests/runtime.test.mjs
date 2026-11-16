import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwarmRuntime } from '../src/runtime.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

function until(runtime, predicate) {
  if (predicate()) return Promise.resolve();
  return new Promise(resolve => {
    const changed = () => { if (predicate()) { runtime.off('change', changed); resolve(); } };
    runtime.on('change', changed);
  });
}
async function setup(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-swarm-'));
  const turns = [];
  const runtime = new SwarmRuntime({ dir, model: 'test/one', createWorker: async (member) => ({
    async prompt(text) { turns.push({ name: member.name, text }); },
    async abort() {}, dispose() {}, async setModel() {},
  }), ...extra });
  await runtime.init();
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  return { runtime, turns, dir };
}
async function idle(runtime, name) {
  await until(runtime, () => runtime.members.get(name)?.state === 'waiting' && runtime.workers.has(name));
  // Change is emitted before the per-worker runner drops its final task handle.
  await new Promise(resolve => setImmediate(resolve));
}
const options = { timeout: 5000 };

test('simultaneous posts get stable unique sequences and exact lookup ignores pagination', options, async t => {
  const { runtime } = await setup(t);
  await Promise.all(Array.from({ length: 30 }, (_, i) => runtime.post('coordinator', { text: `post ${i}` })));
  const result = await runtime.read('coordinator', { seqs: [2, 9, 28], since: 29, limit: 1 });
  assert.deepEqual(result.messages.map(m => m.seq), [2, 9, 28]);
  assert.deepEqual((await runtime.read('coordinator', { since: 20, limit: 3 })).messages.map(m => m.seq), [21, 22, 23]);
});

test('wait returns ambient history plus addressed post, including an already-posted wakeup', options, async t => {
  const { runtime } = await setup(t);
  await runtime.manage('coordinator', { action: 'add', name: 'reader', brief: 'Read assigned evidence.' });
  await idle(runtime, 'reader');
  const since = runtime.head;
  const sleeping = runtime.wait('reader', { since });
  await runtime.post('coordinator', { text: 'ambient evidence' });
  await runtime.post('coordinator', { text: '@reader inspect it' });
  assert.deepEqual((await sleeping).messages.map(m => m.text), ['ambient evidence', '@reader inspect it']);
  const immediate = await runtime.wait('reader', { since });
  assert.equal(immediate.messages[0].text, 'ambient evidence');
});

test('channel subscriptions preserve historical views and direct mentions cross areas', options, async t => {
  const { runtime } = await setup(t);
  await runtime.manage('coordinator', { action: 'channel', op: 'create', channel: 'parser' });
  await runtime.manage('coordinator', { action: 'add', name: 'reader', brief: 'Read only.' });
  await idle(runtime, 'reader');
  const hidden = await runtime.post('coordinator', { channel: 'parser', text: 'older private area note' });
  await runtime.manage('coordinator', { action: 'channel', op: 'subscribe', channel: 'parser', name: 'reader' });
  const visible = await runtime.post('coordinator', { channel: 'parser', text: 'current area note' });
  await runtime.manage('coordinator', { action: 'channel', op: 'unsubscribe', channel: 'parser', name: 'reader' });
  const addressed = await runtime.post('coordinator', { channel: 'parser', text: '@reader cross-area ask' });
  const messages = (await runtime.read('reader', { since: 0 })).messages;
  assert.ok(!messages.some(m => m.seq === hidden.seq));
  assert.ok(messages.some(m => m.seq === visible.seq));
  assert.ok(messages.some(m => m.seq === addressed.seq));
  assert.equal((await runtime.read('reader', { seqs: [hidden.seq], channel: 'parser' })).messages[0].seq, hidden.seq);
  await runtime.manage('coordinator', { action: 'channel', op: 'archive', channel: 'parser' });
  await assert.rejects(runtime.post('coordinator', { channel: 'parser', text: 'no more posts' }), /archived/);
  await assert.rejects(runtime.post('coordinator', { text: '@#main forbidden' }), /@all/);
});

test('numbered groups route case-insensitively without matching longer names', options, async t => {
  const { runtime, turns } = await setup(t);
  await runtime.manage('coordinator', { action: 'add', name: 'review', tasks: ['one', 'two'], brief: 'Check your slice.' });
  await Promise.all(['review-1', 'review-2'].map(n => idle(runtime, n)));
  const before = turns.length;
  await runtime.post('coordinator', { text: '@REVIEW inspect #1' });
  await until(runtime, () => turns.length >= before + 2);
  assert.deepEqual(turns.slice(before).map(x => x.name).sort(), ['review-1', 'review-2']);
  const message = await runtime.post('coordinator', { text: '@review-extra must not ring review copies' });
  assert.deepEqual(message.targets, []);
});

test('helper authority blocks sibling management and killed names cannot revive', options, async t => {
  const { runtime } = await setup(t);
  for (const name of ['author', 'peer']) await runtime.manage('coordinator', { action: 'add', name, brief: 'Own your work.' });
  await runtime.manage('author', { action: 'add', name: 'helper', brief: 'Help author.' });
  await assert.rejects(runtime.manage('author', { action: 'kill', name: 'peer' }), /helpers/);
  await assert.rejects(runtime.manage('author', { action: 'title', title: 'not allowed' }), /coordinator/);
  await runtime.manage('author', { action: 'kill', name: 'helper' });
  await runtime.post('coordinator', { text: '@helper this cannot revive you' });
  assert.equal(runtime.members.get('helper').state, 'killed');
  await assert.rejects(runtime.manage('coordinator', { action: 'add', name: 'helper', brief: 'Reuse name.' }), /reused/);
});

test('restart preserves board, historical visibility and stopped-worker revival', options, async t => {
  let second;
  t.after(() => second?.close());
  const first = await setup(t);
  await first.runtime.manage('coordinator', { action: 'add', name: 'reader', brief: 'Retain your context.' });
  await idle(first.runtime, 'reader');
  await first.runtime.post('coordinator', { text: 'retained evidence' });
  await first.runtime.close();
  const turns = [];
  second = new SwarmRuntime({ dir: first.dir, createWorker: async () => ({ prompt: async text => { turns.push(text); }, abort: async () => {}, dispose() {} }) });
  await second.init();
  assert.equal(second.members.get('reader').state, 'stopped');
  assert.ok((await second.read('reader', { since: 0 })).messages.some(m => m.text === 'retained evidence'));
  await second.post('coordinator', { text: '@reader resume' });
  await idle(second, 'reader');
  assert.match(turns[0], /@reader resume/);
});

test('abort removes parked wait and kill releases active tool without taking board lock', options, async t => {
  let release;
  const active = new Promise(resolve => { release = resolve; });
  let runtime;
  ({ runtime } = await setup(t, { createWorker: async () => ({
    prompt: async () => { await active; },
    abort: async () => { await runtime.read('coordinator', {}); release(); }, dispose() {},
  }) }));
  const controller = new AbortController();
  const parked = runtime.wait('coordinator', { since: 0 }, controller.signal);
  controller.abort(); await assert.rejects(parked, { name: 'AbortError' });
  assert.equal(runtime.waiters.size, 0);
  await runtime.manage('coordinator', { action: 'add', name: 'busy', brief: 'Await abort.' });
  await until(runtime, () => runtime.members.get('busy')?.state === 'working');
  await runtime.manage('coordinator', { action: 'kill', name: 'busy' });
  assert.equal(runtime.members.get('busy').state, 'killed');
});

test('changing coordinator model affects future workers without changing existing members', options, async t => {
  const { runtime } = await setup(t);
  await runtime.manage('coordinator', { action: 'add', name: 'first', brief: 'First assignment.' });
  await runtime.syncCoordinatorModel('test/two');
  await runtime.manage('coordinator', { action: 'add', name: 'second', brief: 'Second assignment.' });
  assert.equal(runtime.members.get('first').model, 'test/one');
  assert.equal(runtime.members.get('second').model, 'test/two');
});

test('recovering an interrupted final append preserves earlier evidence', options, async t => {
  let restored;
  t.after(() => restored?.close());
  const { runtime, dir } = await setup(t);
  await runtime.post('coordinator', { text: 'durable result' }); await runtime.close();
  const file = join(dir, 'board.jsonl');
  await writeFile(file, (await readFile(file, 'utf8')) + '{"seq":2');
  restored = new SwarmRuntime({ dir }); await restored.init();
  assert.equal(restored.head, 1);
  assert.equal((await restored.read('coordinator', {})).messages[0].text, 'durable result');
});

test('isolated workspaces start at committed HEAD and retirement preserves dirty work', { timeout: 15000 }, async t => {
  const { runtime, dir } = await setup(t);
  const repo = join(dir, 'repo'); await mkdir(repo);
  const git = (args, cwd = repo) => promisify(execFile)('git', args, { cwd });
  await git(['init', '-b', 'main']);
  await writeFile(join(repo, 'evidence.txt'), 'committed baseline');
  await git(['add', 'evidence.txt']);
  await git(['-c', 'user.name=Swarm Test', '-c', 'user.email=swarm@example.invalid', 'commit', '-m', 'baseline']);
  await writeFile(join(repo, 'evidence.txt'), 'uncommitted coordinator edit');
  runtime.cwd = repo;
  for (const workspace of ['share', 'branch']) {
    await runtime.manage('coordinator', { action: 'add', name: workspace, workspace, brief: 'Inspect isolated baseline.' });
    await idle(runtime, workspace);
    const member = runtime.members.get(workspace);
    assert.equal(await readFile(join(member.cwd, 'evidence.txt'), 'utf8'), 'committed baseline');
    await writeFile(join(member.cwd, 'evidence.txt'), 'valuable unfinished worker change');
    await runtime.manage('coordinator', { action: 'kill', name: workspace });
    assert.equal(await readFile(join(member.cwd, 'evidence.txt'), 'utf8'), 'valuable unfinished worker change');
    assert.equal(member.retained_workspace, member.cwd);
  }
});

test('monitor daemon resumes on new work after coordinator completion', options, async t => {
  const { runtime, turns } = await setup(t, { monitorIntervalMs: 15 });
  await runtime.manage('coordinator', { action: 'add', name: 'monitor', brief: 'Diagnose stalls only.' });
  await until(runtime, () => turns.some(turn => turn.text.includes('[monitor] tick')));
  await runtime.post('coordinator', { text: '[done] First job finished' });
  const before = turns.filter(turn => turn.text.includes('[monitor] tick')).length;
  await runtime.post('coordinator', { text: 'A new job needs attention' });
  await until(runtime, () => turns.filter(turn => turn.text.includes('[monitor] tick')).length > before);
});

test('swarm models action supports all flag and model action switches member model', options, async t => {
  let modelSwitchedTo = null;
  const { runtime } = await setup(t, {
    listModels: async (args) => args?.all ? [{ id: 'provider/full-1' }, { id: 'provider/full-2' }] : [{ id: 'provider/suggested-1' }],
    onCoordinatorModel: async (model) => { modelSwitchedTo = model; },
  });
  const suggested = await runtime.manage('coordinator', { action: 'models' });
  assert.deepEqual(suggested.models, [{ id: 'provider/suggested-1' }]);
  const allModels = await runtime.manage('coordinator', { action: 'models', all: true });
  assert.deepEqual(allModels.models, [{ id: 'provider/full-1' }, { id: 'provider/full-2' }]);

  await runtime.manage('coordinator', { action: 'add', name: 'worker', brief: 'Work on tasks.' });
  await idle(runtime, 'worker');
  assert.equal(runtime.members.get('worker').model, 'test/one');

  await runtime.manage('coordinator', { action: 'model', name: 'worker', model: 'provider/new-model' });
  assert.equal(runtime.members.get('worker').model, 'provider/new-model');

  await runtime.manage('coordinator', { action: 'model', name: 'coordinator', model: 'provider/coord-model' });
  assert.equal(modelSwitchedTo, 'provider/coord-model');
});

test('swarm_wait times out cleanly with timeout_ms parameter', options, async t => {
  const { runtime } = await setup(t);
  const start = Date.now();
  const result = await runtime.wait('coordinator', { since: runtime.head, timeout_ms: 50 });
  const elapsed = Date.now() - start;
  assert.equal(result.reason, 'timeout');
  assert.deepEqual(result.messages, []);
  assert.ok(elapsed >= 30, `Expected elapsed >= 30ms, got ${elapsed}`);
});

test('fork workspace creation copies persisted session reference and inherits context', options, async t => {
  const { runtime, dir } = await setup(t);
  const coordSession = join(dir, 'coordinator.jsonl');
  await writeFile(coordSession, '{"type":"session","id":"coord"}\n');
  runtime.coordinatorSessionFile = coordSession;
  runtime.members.get('coordinator').sessionFile = coordSession;

  await runtime.manage('coordinator', { action: 'add', name: 'child', fork: 'coordinator', brief: 'Forked from coordinator.' });
  await idle(runtime, 'child');
  const child = runtime.members.get('child');
  assert.equal(child.fork, 'coordinator');
  assert.equal(child.forkSessionFile, coordSession);

  const childSession = join(dir, 'child.jsonl');
  await writeFile(childSession, '{"type":"session","id":"child"}\n');
  child.sessionFile = childSession;

  await runtime.manage('coordinator', { action: 'add', name: 'grandchild', fork: 'child', brief: 'Forked from child.' });
  await idle(runtime, 'grandchild');
  const grandchild = runtime.members.get('grandchild');
  assert.equal(grandchild.fork, 'child');
  assert.equal(grandchild.forkSessionFile, childSession);

  await assert.rejects(runtime.manage('coordinator', { action: 'add', name: 'badfork', fork: 'nonexistent', brief: 'Bad fork.' }), /Unknown fork source/);
});

test('failed workspace setup cleans up member without leaving zombie stopped members', options, async t => {
  const { runtime, dir } = await setup(t);
  const nonGitDir = join(dir, 'nongit');
  await mkdir(nonGitDir);
  runtime.cwd = nonGitDir;

  await assert.rejects(runtime.manage('coordinator', { action: 'add', name: 'gitworker', workspace: 'share', brief: 'Should fail in non-git cwd.' }));
  assert.equal(runtime.members.has('gitworker'), false);
});
