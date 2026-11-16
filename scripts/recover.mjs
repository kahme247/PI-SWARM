#!/usr/bin/env node
// Read-only recovery: no AGY execution, sign-in, or conversation access.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';

const [binary, builtin, destination = 'recovery'] = process.argv.slice(2);
if (!binary || !builtin) {
  console.error('Usage: node scripts/recover.mjs <agy.exe> <antigravity-cli/builtin> [output]');
  process.exit(2);
}
const out = resolve(destination);
await mkdir(out, { recursive: true });
const bytes = await readFile(binary);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const source = bytes.toString('latin1');
const decoder = new TextDecoder();

function extractObjectAt(start) {
  let depth = 0, quoted = false, escaped = false;
  for (let end = start; end < Math.min(bytes.length, start + 65536); end++) {
    const c = bytes[end];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === 92) escaped = true;
      else if (c === 34) quoted = false;
    } else if (c === 34) quoted = true;
    else if (c === 123) depth++;
    else if (c === 125 && --depth === 0) {
      const raw = decoder.decode(bytes.subarray(start, end + 1));
      try {
        return { raw, obj: JSON.parse(raw), end };
      } catch {
        return { raw, obj: null, end };
      }
    }
  }
  return null;
}

const schemas = [];

for (const match of source.matchAll(/\{\s*"type":\s*"object"/g)) {
  const res = extractObjectAt(match.index);
  if (!res) continue;
  if (res.obj) {
    const schema = res.obj;
    const keys = Object.keys(schema.properties || {});
    if (keys.length === 1 && keys[0] === 'text' && schema.required?.includes('text')) {
      schemas.push({ tool: 'post_message', offset: match.index, schema });
    } else if (keys.includes('mentions_only') && keys.includes('since')) {
      schemas.push({ tool: 'swarm_wait', offset: match.index, schema });
    } else if (keys.includes('seqs') && keys.includes('since')) {
      schemas.push({ tool: 'read_board', offset: match.index, schema });
    }
  } else if (res.raw.includes('"action"') && res.raw.includes('"%s"')) {
    // Dynamic swarm template in Go runtime; extract property fragments to assemble schema
    const propNames = [
      'n', 'model', 'all', 'brief', 'tasks', 'workspace', 'fork', 'title',
      'channels', 'op', 'channel', 'topic', 'backend', 'brief_seq', 'swarm'
    ];
    const swarmProps = {
      action: {
        type: 'string',
        enum: ['status', 'models', 'add', 'model', 'kill', 'title', 'channel', 'join'],
        description: 'What to do: status, models, add, model, kill, title, channel or join.'
      },
      name: {
        type: 'string',
        description: 'Roster name of the worker, for add, model and kill (or base name when n > 1 or tasks is set). Short, lowercase, no spaces.'
      }
    };
    for (const name of propNames) {
      const regex = new RegExp(`"${name}":\\s*\\{\\s*"type"`, 'g');
      for (const propMatch of source.matchAll(regex)) {
        if (propMatch.index > 71000000 && propMatch.index < 72100000) {
          const propStart = source.indexOf('{', propMatch.index);
          const propObj = extractObjectAt(propStart);
          if (propObj?.obj && !swarmProps[name]) {
            swarmProps[name] = propObj.obj;
          }
        }
      }
    }
    const swarmSchema = {
      type: 'object',
      properties: swarmProps,
      required: ['action']
    };
    schemas.push({
      tool: 'swarm',
      offset: match.index,
      template: res.raw,
      schema: swarmSchema
    });
  }
}

schemas.sort((a, b) => a.offset - b.offset);

const files = [];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) {
      const data = await readFile(path);
      const name = relative(resolve(builtin), path).replaceAll('\\', '/');
      const target = join(out, 'assets', name);
      await mkdir(resolve(target, '..'), { recursive: true });
      await writeFile(target, data);
      files.push({ path: name, bytes: data.length, sha256: sha256(data) });
    }
  }
}
for (const part of ['skills/native_swarm', 'skills/swarm_monitor', 'skills/swarm_narrator', 'skills/swarm_pane', 'plugins/swarm']) {
  await collect(resolve(builtin, part));
}
const report = {
  format: 1,
  binary: { name: 'agy.exe', bytes: bytes.length, sha256: sha256(bytes) },
  schemas,
  files,
  limits: 'Bundled source assets and embedded JSON schemas recovered exactly. Native Go implementation was not reconstructed as source. Cloud backend, credit/quota services and cross-machine transport are AGY services, not bundled portable code.',
};
await writeFile(join(out, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Recovered ${files.length} bundled files and ${schemas.length} native schemas into ${out}`);
