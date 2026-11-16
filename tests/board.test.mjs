import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startBoard, normalizeSnapshot } from '../src/board-server.mjs';

function fixture(dir) {
  return { dir, snapshot: () => ({ id: 'swarm-1', title: 'Native recovery', dir, head: 3,
    members: [{ name: 'coordinator', role: 'coordinator', conversation_id: 'coord-id', status: 'working', channels: ['*'] }, { name: 'Builder', role: 'worker', conversation_id: 'worker-id', status: 'waiting', last_read_seq: 1, channels: ['main', 'ui'] }, { name: 'narrator', role: 'narrator', conversation_id: 'narrator-id', status: 'waiting', channels: ['*'] }],
    channels: [{ name: 'main' }, { name: 'ui' }], messages: [{ seq: 1, agent: 'coordinator', text: '@builder begin', time: '2026-01-01T00:00:00Z' }, { seq: 2, agent: 'Builder', text: '@all progress', channel: 'ui', time: '2026-01-01T00:00:01Z' }, { seq: 3, agent: 'coordinator', text: '@#ui review', channel: 'ui', time: '2026-01-01T00:00:02Z' }] }) };
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-board-'));
  const runtime = fixture(dir);
  const board = await startBoard(runtime);
  t.after(async () => { await board.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, runtime, board, get: (path = '') => fetch(new URL(path, board.url)) };
}

test('normalizes native state, channel mentions, graph edges and raw data', () => {
  const value = normalizeSnapshot(fixture('/unused').snapshot());
  assert.equal(value.swarm, 'swarm-1');
  assert.equal(value.member, 'coordinator');
  assert.equal(value.members[1].status, 'waiting');
  assert.equal(value.members[1].unread, 1);
  assert.deepEqual(value.messages[0].mentions, ['Builder']);
  assert.deepEqual(value.messages[2].via_channel, ['Builder']);
  assert.equal(value.messages[1].all, true);
  assert.deepEqual(value.edges.find((e) => e.from === 'coordinator' && e.to === 'Builder'), { from: 'coordinator', to: 'Builder', count: 2, direct: 2, viaAll: 0 });
  assert.ok(!value.edges.some((e) => e.to === 'narrator'));
  assert.equal(value.narratorState, 'waiting');
  assert.equal(value.builtinOverview && value.graphTab && value.rawTab, true);
  assert.equal(JSON.parse(value.raw.members).title, 'Native recovery');
  assert.equal(value.raw.board.split('\n').length, 3);
});

test('serves recovered UI and stable conditional snapshots through capability only', async (t) => {
  const { board, get } = await setup(t);
  const origin = new URL(board.url).origin;
  for (const path of ['/', '/api/swarm', '/app.js', '/api/frame?path=board.jsonl', '/wrong/api/swarm']) assert.equal((await fetch(origin + path)).status, 404);
  const page = await get();
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-tab="overview"/);
  assert.match(html, /data-tab="graph"/);
  assert.match(html, /src="app.js"/);
  assert.doesNotMatch(html, /preload.js/);
  assert.equal((await get('app.js')).status, 200);
  const snapshot = await (await get('api/swarm')).json();
  const unchanged = await (await get(`api/swarm?etag=${snapshot.etag}`)).json();
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.messages, undefined);
  assert.equal((await fetch(new URL('api/swarm', board.url), { method: 'POST' })).status, 405);
});

test('rejects DNS rebinding authorities even with capability', async (t) => {
  const { board } = await setup(t);
  const status = await new Promise((resolve, reject) => {
    const req = request(board.url, { headers: { host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 404);
});

test('reads plan and narrator view, retaining last valid JSON while rewriting', async (t) => {
  const { dir, get } = await setup(t);
  await writeFile(join(dir, 'view.json'), JSON.stringify({ version: 1, headline: 'Building', as_of_seq: 3 }));
  await writeFile(join(dir, 'view.html'), '<main>Native narrator</main>');
  await writeFile(join(dir, 'plan.json'), JSON.stringify({ goal: 'Recover the swarm' }));
  let value = await (await get('api/swarm')).json();
  assert.equal(value.view.json.headline, 'Building');
  assert.match(value.view.html, /Native narrator/);
  assert.equal(value.plan.goal, 'Recover the swarm');
  const etag = value.etag;
  await writeFile(join(dir, 'view.json'), '{');
  value = await (await get('api/swarm')).json();
  assert.equal(value.view.json.headline, 'Building');
  assert.equal(value.view.jsonError, 'invalid');
  assert.notEqual(value.etag, etag);
  await writeFile(join(dir, 'view.html'), 'x'.repeat(65537));
  value = await (await get('api/swarm')).json();
  assert.equal(value.view.html, null);
  assert.equal(value.view.htmlError, 'too_large');
  await rm(join(dir, 'view.json'));
  value = await (await get('api/swarm')).json();
  assert.equal(value.view.json, null);
});

test('only serves listed screenshots and rejects traversal and external files', async (t) => {
  const { dir, get } = await setup(t);
  await mkdir(join(dir, 'shots'));
  await writeFile(join(dir, 'shots', 'one.png'), Buffer.from([137, 80, 78, 71]));
  await writeFile(join(dir, 'hidden.png'), 'private');
  const outside = await mkdtemp(join(tmpdir(), 'pi-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'outside.png'), 'outside');
  const frames = [{ path: 'shots/one.png', seq: 2, caption: 'First render' }, { path: join(outside, 'outside.png') }, { path: '../escape.png' }];
  await writeFile(join(dir, 'view.json'), JSON.stringify({ reel: { frames } }));
  const value = await (await get('api/swarm')).json();
  assert.deepEqual(value.frames, [frames[0]]);
  const image = await get(`api/frame?path=${encodeURIComponent('shots/one.png')}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  for (const path of ['hidden.png', '../escape.png', join(outside, 'outside.png'), 'shots/../hidden.png', '%2e%2e/hidden.png']) assert.equal((await get(`api/frame?path=${encodeURIComponent(path)}`)).status, 404);
  assert.equal((await get('api/file?path=shots/one.png')).status, 404);
});

test('blocks listed screenshot symlinks escaping runtime directory', async (t) => {
  const { dir, get } = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), 'pi-link-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'outside.png'), 'secret');
  try { await symlink(outside, join(dir, 'escape'), 'junction'); } catch (error) { if (error.code === 'EPERM') return t.skip('symlink privilege unavailable'); throw error; }
  await writeFile(join(dir, 'view.json'), JSON.stringify({ reel: { frames: [{ path: 'escape/outside.png' }] } }));
  const value = await (await get('api/swarm')).json();
  assert.equal(value.frames.length, 0);
  assert.equal((await get('api/frame?path=escape%2Foutside.png')).status, 404);
});

test('serves only exact narrator file actions as inert plain text', async (t) => {
  const { dir, get } = await setup(t);
  await writeFile(join(dir, 'note.html'), '<script>alert(1)</script>');
  await writeFile(join(dir, 'private.txt'), 'private');
  await writeFile(join(dir, 'view.json'), JSON.stringify({ attention: [{ actions: [{ type: 'file', target: 'note.html' }, { type: 'file', target: '../secret' }] }] }));
  const value = await (await get('api/swarm')).json();
  assert.deepEqual(Object.keys(value.allowedFiles), ['note.html']);
  const response = await get(value.allowedFiles['note.html']);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  assert.equal(await response.text(), '<script>alert(1)</script>');
  assert.equal((await get('api/file?path=private.txt')).status, 404);
});

test('navigates roster IDs to actual pi transcript text without accepting file paths', async (t) => {
  const { dir, runtime, get } = await setup(t);
  const session = join(dir, 'worker.jsonl');
  await writeFile(session, [JSON.stringify({ type: 'session', id: 'native' }), JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Persisted native reply <script>' }, { type: 'toolCall', name: 'read', arguments: { path: 'src/index.ts' } }] } })].join('\n'));
  const original = runtime.snapshot;
  runtime.snapshot = () => { const value = original(); value.members[1].session_file = session; return value; };
  const response = await get('transcript?member=worker-id');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  assert.match(await response.text(), /Persisted native reply <script>[\s\S]*\[tool read\]/);
  assert.equal((await get(`transcript?member=${encodeURIComponent(session)}`)).status, 404);
  const value = await (await get('api/swarm')).json();
  assert.equal(value.members[1].session_file, undefined);
  assert.doesNotMatch(value.raw.members, /worker\.jsonl/);
});

test('stopped workers remain revivable, quota failures stay visible, and historical mentions stay unread', () => {
  const value = normalizeSnapshot({ id: 'native', head: 2, channels: [{ name: 'main' }, { name: 'area' }],
    members: [{ name: 'coordinator', role: 'coordinator' }, { name: 'reader', role: 'worker', state: 'stopped', channels: ['main'], error: '429 quota exhausted' }],
    messages: [{ seq: 1, agent: 'coordinator', channel: 'area', text: 'older visible post', visible_to: ['reader'] }, { seq: 2, agent: 'coordinator', channel: 'area', text: '@reader inspect', targets: ['reader'], visible_to: [] }] });
  const reader = value.members.find(m => m.name === 'reader');
  assert.equal(reader.killed, false);
  assert.equal(reader.status, 'stopped');
  assert.equal(reader.unread, 2);
  assert.equal(value.systemAttention[0].kind, 'quota');
  assert.deepEqual(value.channels.map(c => c.name), ['area']);
});
