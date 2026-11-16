import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const VIEW_LIMIT = 64 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const ASSETS = { '': ['index.html', 'text/html; charset=utf-8'], 'index.html': ['index.html', 'text/html; charset=utf-8'], 'app.js': ['app.js', 'text/javascript; charset=utf-8'], 'hive.js': ['hive.js', 'text/javascript; charset=utf-8'], 'styles.css': ['styles.css', 'text/css; charset=utf-8'], 'hive.css': ['hive.css', 'text/css; charset=utf-8'], 'narrator_bootstrap.js': ['narrator_bootstrap.js', 'text/plain; charset=utf-8'] };
const observer = (m) => !['worker', 'coordinator'].includes(m.role || 'worker') || /^(narrator|monitor)(-\d+)?$/i.test(m.name);
const hash = (value) => createHash('sha256').update(value).digest('hex');

// Check both lexical and resolved containment: neither traversal nor symlink escapes
// may turn a published screenshot or narrator action into arbitrary file access.
function safeFile(dir, target) {
  if (typeof target !== 'string' || !target || /[%\0]/.test(target)) return null;
  if (target.replaceAll('\\', '/').split('/').some((part) => part === '..' || part === '.')) return null;
  try {
    const root = realpathSync(dir);
    const path = realpathSync(resolve(root, target));
    if (!statSync(path).isFile()) return null;

    const rel = relative(root, path);
    const inRoot = rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    if (inRoot) return path;

    const brainMatch = dir.match(/^(.*?[\\/]brain)(?:[\\/].*)?$/i);
    if (brainMatch) {
      const brainRoot = realpathSync(brainMatch[1]);
      const brainRel = relative(brainRoot, path);
      const inBrain = brainRel && brainRel !== '..' && !brainRel.startsWith(`..${sep}`) && !isAbsolute(brainRel);
      if (inBrain) return path;
    }

    return null;
  } catch { return null; }
}

function smallFile(dir, name, max = VIEW_LIMIT) {
  const path = safeFile(dir, name);
  if (!path) return { exists: false, text: '', mtime: 0, error: '' };
  try {
    const stat = statSync(path);
    if (stat.size > max) return { exists: true, text: '', mtime: stat.mtimeMs, error: 'too_large' };
    const bytes = readFileSync(path);
    if (bytes.length > max) return { exists: true, text: '', mtime: stat.mtimeMs, error: 'too_large' };
    return { exists: true, text: bytes.toString('utf8'), mtime: stat.mtimeMs, error: '' };
  } catch { return { exists: false, text: '', mtime: 0, error: '' }; }
}
function objectJson(text) {
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
}

/** Normalize the native runtime snapshot without changing its durable state. */
export function normalizeSnapshot(snapshot, { view = {}, plan = null, frames = [], raw = {} } = {}) {
  const sourceMembers = Array.isArray(snapshot.members) ? snapshot.members : [];
  const names = new Map(sourceMembers.map((m) => [m.name.toLowerCase(), m.name]));
  const channels = (snapshot.channels || []).map((c) => typeof c === 'string' ? { name: c } : c).filter(c => c.name !== 'main');
  const head = Number(snapshot.head) || 0;
  const messages = (snapshot.messages || []).map((message) => {
    const mentions = new Set();
    let all = false;
    for (const match of String(message.text || '').matchAll(/(?:^|[^\w@])@([\w-]+)(?![\w-])/g)) {
      const name = match[1].toLowerCase();
      if (name === 'all') all = true;
      else {
        if (names.has(name)) mentions.add(names.get(name));
        for (const member of sourceMembers) {
          if ((member.group?.toLowerCase() === name || member.name.toLowerCase().replace(/-\d+$/, '') === name) && message.targets?.includes(member.name)) mentions.add(member.name);
        }
      }
    }
    const addressedChannels = [...String(message.text || '').matchAll(/(?:^|[^\w@])@#([\w-]+)/g)].map((m) => m[1]);
    const via = sourceMembers.filter((m) => !observer(m) && m.name !== message.agent && addressedChannels.some((c) => (m.channels || []).includes(c) || (m.channels || []).includes('*'))).map((m) => m.name);
    return { ...message, channel: message.channel || 'main', mentions: [...mentions], all, channel_mentions: addressedChannels, via_channel: via };
  });
  const members = sourceMembers.map((m) => {
    const posts = messages.filter((message) => message.agent === m.name);
    const last = posts.at(-1);
    const killed = !!m.killed || ['killed', 'cancelled'].includes(m.status || m.state);
    const status = killed ? 'killed' : (m.status || m.state) === 'stopped' ? 'stopped' : ['working', 'running', 'active', 'starting'].includes(m.status || m.state) ? 'working' : 'waiting';
    const ownChannels = m.channels || ['main'];
    const unread = messages.filter((message) => message.seq > (m.last_read_seq || 0) && message.agent !== m.name && (m.role === 'coordinator' || observer(m) || message.targets?.includes(m.name) || (message.visible_to ? message.visible_to.includes(m.name) : ownChannels.includes('*') || ownChannels.includes(message.channel)))).length;
    return { ...m, conversation_id: m.conversation_id || m.name, role: m.role || 'worker', status, killed, channels: ownChannels, unread, posts: posts.length, lastPostSeq: last?.seq || 0, lastPostTime: last?.time || '', steps: m.steps || 0, activity: m.activity || '', activityKind: m.activityKind || '', last_read_seq: m.last_read_seq || 0, narrator: m.role === 'narrator' || /^narrator(-\d+)?$/.test(m.name), roleWorker: observer(m), failure: m.failure || (m.error || ['failed', 'error'].includes(m.status || m.state) ? { kind: /quota|429|RESOURCE_EXHAUSTED/i.test(m.error || '') ? 'quota' : 'error', text: String(m.error || `${m.name} failed`) } : null), transcriptMtime: m.transcriptMtime || 0 };
  });
  const edgeMap = new Map();
  for (const message of messages) {
    if (observer(members.find((m) => m.name === message.agent) || { name: message.agent })) continue;
    const direct = new Set([...message.mentions, ...message.via_channel]);
    for (const member of members) {
      if (member.name === message.agent || member.roleWorker) continue;
      if (!direct.has(member.name) && !message.all) continue;
      const key = `${message.agent}\0${member.name}`;
      const edge = edgeMap.get(key) || { from: message.agent, to: member.name, count: 0, direct: 0, viaAll: 0 };
      edge.count++; edge[direct.has(member.name) ? 'direct' : 'viaAll']++;
      edgeMap.set(key, edge);
    }
  }
  const narrator = members.filter((m) => m.narrator).sort((a, b) => Number(a.killed) - Number(b.killed) || b.name.localeCompare(a.name, undefined, { numeric: true }))[0];
  const narratorState = !narrator ? 'absent' : narrator.killed ? 'killed' : narrator.failure ? 'paused' : narrator.status;
  const coordinator = members.find((m) => m.role === 'coordinator');
  const systemAttention = members.filter((m) => m.failure || m.state === 'failed' || m.status === 'failed').map((m) => ({ id: `error-${m.name}`, kind: m.failure?.kind || 'error', member: m.name, conversation_id: m.conversation_id, text: m.failure?.text || `${m.name} failed`, detail: m.failure?.detail || '', since: m.failure?.since || 0 }));
  // Session paths stay private; navigation resolves a current roster ID server-side.
  const publicMembers = members.map(({ session_file, sessionFile, ...m }) => m);
  return { ...snapshot, members: publicMembers, channels, messages, head, swarm: snapshot.id || 'native', conversationId: coordinator?.conversation_id || snapshot.id || '', member: coordinator?.name || null, edges: [...edgeMap.values()], narrator: narrator ? { name: narrator.name, conversation_id: narrator.conversation_id, state: narratorState, reason: narrator.failure?.kind || '', detail: narrator.failure?.text || '', last_read_seq: narrator.last_read_seq, transcriptMtime: narrator.transcriptMtime } : null, narratorState, view: { exists: false, json: null, html: null, htmlKey: '', jsonMtime: 0, htmlMtime: 0, jsonError: '', htmlError: '', ...view }, plan, frames, builtinOverview: true, graphTab: true, rawTab: true, allowedFiles: {}, urlHosts: [], systemAttention, raw: { members: JSON.stringify({ title: snapshot.title, members: Object.fromEntries(publicMembers.map((m) => [m.name, m])) }, null, 2), board: messages.map((m) => JSON.stringify(m)).join('\n'), view: '', ...raw } };
}

function transcriptText(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Transcript unavailable or too large');
  return readFileSync(path, 'utf8').split(/\r?\n/).flatMap((line) => {
    let entry; try { entry = JSON.parse(line); } catch { return []; }
    if (entry.type !== 'message' || !entry.message) return [];
    const message = entry.message;
    const content = typeof message.content === 'string' ? message.content : (message.content || []).map((part) => part.type === 'text' ? part.text : part.type === 'thinking' ? `[thinking]\n${part.thinking}` : part.type === 'toolCall' ? `[tool ${part.name}]\n${JSON.stringify(part.arguments, null, 2)}` : part.type === 'image' ? '[image]' : '').join('\n');
    return [`${message.role}${message.toolName ? ` (${message.toolName})` : ''}${entry.timestamp ? ` · ${entry.timestamp}` : ''}\n${content}\n`];
  }).join('\n');
}

export async function startBoard(runtime, { port = 0 } = {}) {
  const token = randomBytes(32).toString('hex');
  const prefix = `/${token}/`;
  let lastView = null;
  function snapshot() {
    const native = runtime.snapshot();
    const dir = runtime.dir || native.dir;
    const json = smallFile(dir, 'view.json');
    const html = smallFile(dir, 'view.html');
    const parsed = objectJson(json.text);
    if (!json.exists) lastView = null;
    else if (parsed) lastView = { json: parsed, mtime: json.mtime };
    const view = { exists: json.exists || html.exists, dir, source: 'swarm', json: lastView?.json || null, jsonMtime: lastView?.mtime || 0, jsonError: json.error || (json.exists && !parsed ? 'invalid' : ''), html: html.error ? null : html.text || null, htmlKey: html.exists ? hash(html.text) : '', htmlMtime: html.mtime, htmlError: html.error || (html.exists && !html.text.trim() ? 'empty' : '') };
    const plan = objectJson(smallFile(dir, 'plan.json').text);
    const listed = Array.isArray(view.json?.reel?.frames) && view.json.reel.frames.length ? view.json.reel.frames : [...(native.frames || []), ...(native.messages || []).flatMap((message) => {
      const member = native.members.find((m) => m.name === message.agent);
      if (!member || member.role === 'coordinator' || observer(member)) return [];
      return [...String(message.text || '').matchAll(/^\s*(?:[-*]\s*)?screenshot:\s*`?(.+?\.(?:png|jpe?g|webp))`?\s*(?:\|\s*(.+?))?\s*$/gim)].map((m) => ({ path: m[1], seq: message.seq, caption: m[2] || '' }));
    })];
    const frames = listed.filter((f) => f && IMAGE_TYPES[extname(String(f.path)).toLowerCase()] && safeFile(dir, f.path)).slice(-40).map((f) => ({ path: f.path, seq: Number(f.seq) || 0, caption: String(f.caption || '').slice(0, 90) }));
    const result = normalizeSnapshot(native, { view, plan, frames, raw: { view: json.text } });
    for (const list of ['attention', 'workstreams', 'milestones', 'risks']) {
      for (const item of (Array.isArray(view.json?.[list]) ? view.json[list] : [])) {
        for (const action of (Array.isArray(item?.actions) ? item.actions : [])) {
          if (action?.type === 'file' && safeFile(dir, action.target)) result.allowedFiles[action.target] = `api/file?path=${encodeURIComponent(action.target)}`;
        }
      }
    }
    result.etag = hash(JSON.stringify(result));
    return result;
  }
  const server = createServer((req, res) => {
    const send = (status, type, body) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'none'" }); res.end(body); };
    const missing = () => send(404, 'text/plain', 'Not found');
    try {
      // Require the exact local authority as well as the capability to resist DNS rebinding.
      if (req.headers.host !== `127.0.0.1:${server.address().port}`) return missing();
      if (req.method !== 'GET') return send(405, 'text/plain', 'Method not allowed');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith(prefix)) return missing();
      const route = url.pathname.slice(prefix.length);
      if (Object.hasOwn(ASSETS, route)) {
        const [name, type] = ASSETS[route];
        return send(200, type, readFileSync(resolve(WEB, name)));
      }
      if (route === 'api/swarm') {
        const value = snapshot();
        return send(200, 'application/json; charset=utf-8', JSON.stringify(url.searchParams.get('etag') === value.etag ? { conversationId: value.conversationId, swarm: value.swarm, member: value.member, unchanged: true, etag: value.etag } : value));
      }
      if (route === 'api/frame' || route === 'api/file') {
        const value = snapshot();
        const target = url.searchParams.get('path');
        const listed = route === 'api/frame' ? value.frames.some((f) => f.path === target) : Object.hasOwn(value.allowedFiles, target);
        if (!listed) return missing();
        const path = safeFile(runtime.dir || value.dir, target);
        if (!path || statSync(path).size > 8 * 1024 * 1024) return missing();
        const bytes = readFileSync(path);
        if (bytes.length > 8 * 1024 * 1024) return missing();
        return send(200, route === 'api/frame' ? IMAGE_TYPES[extname(path).toLowerCase()] : 'text/plain; charset=utf-8', bytes);
      }
      if (route === 'transcript') {
        const native = runtime.snapshot();
        const member = native.members.find((m) => m.name === url.searchParams.get('member') || m.conversation_id === url.searchParams.get('member'));
        if (!member) return missing();
        const path = member.session_file || member.sessionFile || (member.role === 'coordinator' ? runtime.coordinatorSessionFile : null);
        if (!path) return send(404, 'text/plain; charset=utf-8', 'No persisted pi session is available for this member yet.');
        return send(200, 'text/plain; charset=utf-8', transcriptText(path));
      }
      return missing();
    } catch { return send(500, 'text/plain; charset=utf-8', 'Unable to read swarm data'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  return { url: `http://127.0.0.1:${server.address().port}${prefix}`, close: () => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
