import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { SwarmRuntime } from './runtime.mjs';
import { toolSpecs } from './tool-schemas.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const coordinatorGuide = readFileSync(join(root, 'skills/swarm/SKILL.md'), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
const help = `Swarm commands:
/swarm <task> — coordinate native pi workers for a task
/swarm board [--channel <name>] — open the live board inside pi
/swarm web — optional browser board (starts a loopback server only on request)
/swarm read [since] — recent board posts
/swarm post <message> — post as coordinator
/swarm title <title> — rename the swarm
/swarm add <name> <brief> — add a worker on your selected model
/swarm kill <name> — permanently retire a worker or group
/swarm model <name> <provider/model> — switch an idle worker
/swarm models — available configured pi models
/swarm channel <create|list|subscribe|unsubscribe|archive> [channel] [name]
/swarm stop — stop running workers, preserving the swarm for later revival
/swarm help — this help`;
const modelId = (model) => model ? `${model.provider}/${model.id}` : undefined;

export default function swarmExtension(pi) {
  let active;
  let opening;
  let generation = 0;
  let currentContext;
  let coordinatorWaiting = false;
  let notificationTask;
  let lastNotifiedSeq = 0;
  const pendingNotifications = new Map();

  function flushNotifications() {
    notificationTask = undefined;
    if (!active || coordinatorWaiting || !currentContext.isIdle()) return;
    const readThrough = active.runtime.members.get('coordinator').last_read_seq ?? 0;
    const messages = [...pendingNotifications.values()].filter(m => m.seq > readThrough && m.seq > lastNotifiedSeq).sort((a, b) => a.seq - b.seq);
    pendingNotifications.clear();
    if (!messages.length) return;
    lastNotifiedSeq = messages.at(-1).seq;
    pi.sendMessage({ customType: 'swarm-wakeup',
      content: `New swarm results:\n${messages.map(m => `#${m.seq} ${m.agent}: ${m.text}`).join('\n\n')}\nAct only on new actionable results. Do not acknowledge old notifications or wake workers just to acknowledge them. If this includes [swarm-results], give the user a concise outcome, verification, and any failures or unfinished work.`,
      display: true, details: { seqs: messages.map(m => m.seq) } }, { triggerTurn: true, deliverAs: 'followUp' });
  }
  function scheduleNotifications() {
    if (!notificationTask) notificationTask = setImmediate(flushNotifications);
  }

  function directory(ctx) {
    return join(getAgentDir(), 'swarm', ctx.sessionManager.getSessionId());
  }
  function show(text, details = {}) {
    pi.sendMessage({ customType: 'swarm-display', content: text, display: true, details });
  }
  async function shutdown() {
    generation++;
    clearImmediate(notificationTask); notificationTask = undefined;
    pendingNotifications.clear(); lastNotifiedSeq = 0;
    const pending = opening;
    if (pending) await pending.catch(() => {});
    const old = active;
    active = undefined;
    if (old) {
      await old.runtime.close();
      await old.board?.close();
    }
    currentContext?.ui.setStatus('swarm', undefined);
  }
  async function ensure(ctx) {
    currentContext = ctx;
    const id = ctx.sessionManager.getSessionId();
    if (active?.id === id) {
      if (ctx.model) await active.runtime.syncCoordinatorModel(modelId(ctx.model));
      return active;
    }
    if (opening) return opening;
    if (active) await shutdown();
    const epoch = generation;
    opening = (async () => {
      const runtime = new SwarmRuntime({
        dir: directory(ctx), cwd: ctx.cwd, coordinatorId: id,
        coordinatorSessionFile: ctx.sessionManager.getSessionFile(), model: modelId(ctx.model),
        createWorker: async (member, owner) => {
          const { createPiWorker } = await import('./pi-worker.mjs');
          return createPiWorker(member, owner, {
            modelRegistry: currentContext.modelRegistry,
            thinkingLevel: currentContext.thinkingLevel ?? pi.getThinkingLevel(),
            settings: pi.getSettings(),
          });
        },
        listModels: async () => currentContext.modelRegistry.getAvailable().map((m) => ({
          id: `${m.provider}/${m.id}`, provider: m.provider, name: m.name,
          quota_note: 'pi does not expose live provider credit balances; availability is based on configured authentication.',
        })),
        onCoordinatorModel: async (name) => {
          const slash = name.indexOf('/');
          if (slash < 1) throw new Error(`Expected provider/model-id, received ${name}`);
          const model = currentContext.modelRegistry.find(name.slice(0, slash), name.slice(slash + 1));
          if (!model || !await pi.setModel(model)) throw new Error(`Cannot select pi model: ${name}`);
        },
        onCoordinatorMessage: (message) => {
          if (epoch !== generation || message.seq <= lastNotifiedSeq) return;
          pendingNotifications.set(message.seq, message);
          scheduleNotifications();
        },
      });
      await runtime.init();
      if (ctx.model) await runtime.syncCoordinatorModel(modelId(ctx.model));
      if (epoch !== generation) {
        await runtime.close();
        throw new Error('Swarm session closed while starting.');
      }
      active = { id, runtime };
      runtime.on('change', () => {
        if (active?.runtime !== runtime) return;
        const members = runtime.snapshot().members.filter((m) => m.name !== 'coordinator' && !m.killed && m.status !== 'killed');
        const working = members.filter((m) => m.status === 'working' || m.state === 'working').length;
        currentContext.ui.setStatus('swarm', `Swarm: ${working}/${members.length} active`);
      });
      return active;
    })();
    try { return await opening; } finally { opening = undefined; }
  }
  const withLink = (data) => ({ ...data, open_board: '/swarm board' });

  for (const spec of toolSpecs) {
    pi.registerTool({ ...spec, async execute(_id, args, signal, _update, ctx) {
      const { runtime } = await ensure(ctx);
      try {
        if (spec.method === 'wait') coordinatorWaiting = true;
        const result = await runtime[spec.method]('coordinator', args, signal);
        return { content: [{ type: 'text', text: JSON.stringify(withLink(result), null, 2) }], details: result };
      } finally {
        if (spec.method === 'wait') coordinatorWaiting = false;
        scheduleNotifications();
      }
    } });
  }

  pi.registerCommand('swarm', {
    description: 'In-pi swarm dashboard, task, board, status, add, post, read, model, channel, kill, stop; web is optional',
    handler: async (input, ctx) => {
      const text = input.trim();
      if (text === 'help') { show(help); return; }
      if (text === 'stop') { await shutdown(); show('Swarm stopped. Board and sessions are preserved; an addressed post revives a stopped worker.'); return; }
      const [command = 'board', ...words] = text.split(/\s+/).filter(Boolean);
      const known = new Set(['status', 'board', 'web', 'read', 'post', 'title', 'add', 'kill', 'model', 'models', 'channel']);
      if (!known.has(command)) {
        await ensure(ctx);
        pi.sendUserMessage(`Coordinate this task with the native swarm tools.\n\n${text}`, { deliverAs: 'followUp' });
        return;
      }
      const state = await ensure(ctx);
      const { runtime } = state;
      let result;
      switch (command) {
        case 'board': {
          if (words.length && (words.length !== 2 || words[0] !== '--channel')) throw new Error('Usage: /swarm board [--channel <name>]');
          const { showNativeDashboard } = await import(`./native-ui.mjs?v=${Date.now()}`);
          await showNativeDashboard(runtime, ctx, { channel: words[1] });
          return;
        }
        case 'web': {
          if (!state.board) {
            const { startBoard } = await import('./board-server.mjs');
            state.board = await startBoard(runtime);
          }
          show(`Optional browser board: ${state.board.url}`);
          return;
        }
        case 'read': {
          if (words.length > 1 || (words[0] && !/^\d+$/.test(words[0]))) throw new Error('Usage: /swarm read [since]');
          result = await runtime.read('coordinator', words[0] ? { since: Number(words[0]) } : {}); break;
        }
        case 'post': result = await runtime.post('coordinator', { text: words.join(' ') }); break;
        case 'title': result = await runtime.manage('coordinator', { action: 'title', title: words.join(' ') }); break;
        case 'add': {
          if (words.length < 2) throw new Error('Usage: /swarm add <name> <brief>');
          result = await runtime.manage('coordinator', { action: 'add', name: words[0], brief: words.slice(1).join(' ') }); break;
        }
        case 'kill': result = await runtime.manage('coordinator', { action: 'kill', name: words[0] }); break;
        case 'model': result = await runtime.manage('coordinator', { action: 'model', name: words[0], model: words[1] }); break;
        case 'channel': result = await runtime.manage('coordinator', { action: 'channel', op: words[0] ?? 'list', channel: words[1], name: words[2] }); break;
        default: result = await runtime.manage('coordinator', { action: command });
      }
      show(`${JSON.stringify(result, null, 2)}\n\nOpen the dashboard inside pi: /swarm board`, result);
    },
  });

  pi.on('session_start', (_event, ctx) => {
    currentContext = ctx;
  });
  pi.on('session_switch', async (_event, ctx) => {
    await shutdown(); currentContext = ctx;
  });
  pi.on('session_shutdown', shutdown);
  pi.on('agent_start', async (_event, ctx) => {
    currentContext = ctx;
    if (active) await active.runtime.setCoordinatorState('working');
  });
  pi.on('agent_settled', async (_event, ctx) => {
    currentContext = ctx;
    if (active) await active.runtime.setCoordinatorState('waiting');
    scheduleNotifications();
  });
  pi.on('before_agent_start', (_event, ctx) => {
    currentContext = ctx;
    if (!active) return;
    return { message: { customType: 'swarm-coordinator', display: false,
      content: `${coordinatorGuide}\n\nSWARM_DIR=${active.runtime.dir}\nOpen the live dashboard inside pi: /swarm board` } };
  });
}
