import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { SwarmRuntime } from '../src/runtime.mjs';
import { SwarmDashboard, showNativeDashboard } from '../src/native-ui.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-native-ui-'));
  const runtime = new SwarmRuntime({ dir, model: 'test/model' }); await runtime.init();
  let result, renders = 0;
  const tui = { terminal: { rows: 28 }, requestRender() { renders++; } };
  const ui = new SwarmDashboard(runtime, tui, { fg: (_token, value) => value }, {}, value => { result = value; });
  t.after(async () => { ui.dispose(); await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  return { ui, runtime, tui, dir, result: () => result, renders: () => renders };
}

test('native board updates from live posts and searches without a browser or polling', async t => {
  const { ui, runtime, renders } = await fixture(t);
  ui.handleInput('2');
  await runtime.post('coordinator', { text: 'Parser evidence: malformed input is rejected' });
  await runtime.post('coordinator', { text: 'Unrelated UI progress' });
  assert.match(ui.render(100).join('\n'), /malformed input/);
  ui.handleInput('/'); ui.handleInput('Parser'); ui.handleInput('\r');
  const filtered = ui.render(100).join('\n');
  assert.match(filtered, /malformed input/);
  assert.doesNotMatch(filtered, /Unrelated UI progress/);
  assert.ok(renders() > 0);
});

test('terminal output stays inside resized viewports with wide and hostile worker content', async t => {
  const { ui, runtime, tui } = await fixture(t);
  await runtime.post('coordinator', { text: '界'.repeat(90) + '\nsecond line\x1b]52;c;Y2xpcGJvYXJk\x07' });
  ui.handleInput('2');
  for (const [width, rows] of [[100, 28], [32, 16], [16, 8], [8, 5]]) {
    tui.terminal.rows = rows; ui.invalidate();
    const lines = ui.render(width);
    assert.ok(lines.length <= rows);
    for (const line of lines) { assert.ok(visibleWidth(line) <= width); assert.doesNotMatch(line, /\x1b\]52|\x07|\n/); }
  }
});

test('member selection opens the selected persisted pi session within the same screen', async t => {
  const { ui, runtime, dir } = await fixture(t);
  const file = join(dir, 'worker-session.jsonl');
  await writeFile(file, JSON.stringify({ type: 'message', timestamp: 'now', message: { role: 'assistant', content: [{ type: 'text', text: 'Verifier found a real edge case' }] } }) + '\n');
  runtime.members.set('verifier', { name: 'verifier', role: 'worker', state: 'stopped', model: 'test/model', channels: ['main'], sessionFile: file });
  runtime.emit('change');
  ui.handleInput('3'); ui.handleInput('j'); ui.handleInput('\r');
  assert.match(ui.render(100).join('\n'), /Verifier found a real edge case/);
  ui.handleInput('\x1b');
  assert.match(ui.render(100).join('\n'), /verifier  stopped/);
});

test('communication replay follows actual board recipients and live mode restores the head', async t => {
  const { ui, runtime } = await fixture(t);
  await runtime.post('coordinator', { text: 'begin' });
  runtime.members.set('parser', { name: 'parser', role: 'worker', state: 'killed', channels: ['main'] });
  await runtime.post('coordinator', { text: '@parser review #1' });
  ui.handleInput('4');
  assert.match(ui.render(100).join('\n'), /coordinator -> parser/);
  ui.handleInput('-');
  assert.doesNotMatch(ui.render(100).join('\n'), /coordinator -> parser/);
  ui.handleInput('l');
  assert.match(ui.render(100).join('\n'), /coordinator -> parser/);
});

test('closing the screen detaches updates and RPC callers get a useful native-mode error', async t => {
  const { ui, runtime } = await fixture(t);
  const before = runtime.listenerCount('change');
  ui.dispose();
  assert.equal(runtime.listenerCount('change'), before - 1);
  await assert.rejects(showNativeDashboard(runtime, { mode: 'rpc' }), /interactive pi.*swarm status/);
});
