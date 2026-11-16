// Bee Mascot and Avatar Pixel Art generator for Terminal Half-Blocks (▀ / ▄)
// Exact match for Antigravity Swarm Board visual identity

function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map(x => Math.round(x * 255));
}

const HUES = [12, 150, 262, 330, 196, 228, 96, 28, 290, 175, 350, 60];
const hash = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
export const hueOf = n => n === 'coordinator' ? 45 : HUES[hash(String(n)) % HUES.length];
const shiftHue = (h, target, amt) => h + (((target - h + 540) % 360) - 180) * amt;

export function memberColorRgb(name) {
  if (name === 'coordinator') return [247, 206, 91];
  return hsl2rgb(hueOf(name), 78, 60);
}

export function memberColorAnsi(name, text) {
  const [r, g, b] = memberColorRgb(name);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function ramp(name) {
  const h = hueOf(name);
  return {
    spec: hsl2rgb(shiftHue(h, 55, 0.28), 96, 90),
    hi: hsl2rgb(shiftHue(h, 55, 0.18), 90, 74),
    mid: memberColorRgb(name),
    sh: hsl2rgb(shiftHue(h, 265, 0.22), 58, 44),
    ol: hsl2rgb(shiftHue(h, 265, 0.35), 42, 19),
    skh: hsl2rgb(shiftHue(h, 265, 0.15), 20, 30),
    sk: [38, 38, 42],     // dark stripe
    skd: [20, 20, 24]    // shadow stripe
  };
}

/**
 * Generate 4 terminal lines of ANSI half-blocks for the big header mascot bee (10x8 pixels).
 */
export function generateBigBee(name = 'coordinator', state = 'waiting') {
  const W = 10, H = 8;
  const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => null));
  const R = ramp(name);
  const queen = name === 'coordinator';
  const isWaiting = state === 'waiting' || state === 'parked' || state === 'stopped';

  const P = (x, y, col) => {
    if (x >= 0 && y >= 0 && x < W && y < H) grid[y][x] = col;
  };

  // Row 0 & 1: (Text line 0)
  // Sleeping 'z' on top-left if waiting
  if (isWaiting) {
    const zCol = [140, 144, 166];
    P(0, 0, zCol); P(1, 0, zCol);
    P(1, 1, zCol); P(0, 1, zCol);
  }
  // Crown on head
  if (queen) {
    const g1 = [247, 206, 91], g2 = [255, 233, 166], ruby = [228, 86, 106];
    P(3, 0, g2); P(5, 0, g2); P(7, 0, g2);
    P(3, 1, g1); P(4, 1, ruby); P(5, 1, g1); P(6, 1, ruby); P(7, 1, g1);
  } else {
    P(4, 0, R.ol); P(6, 0, R.ol);
    P(4, 1, R.ol); P(6, 1, R.ol);
  }
  // Wing top
  const w1 = [230, 240, 255], w2 = [140, 160, 192];
  P(7, 0, w2); P(8, 0, w1);
  P(7, 1, w1); P(8, 1, w1); P(9, 1, w2);

  // Row 2 & 3: (Text line 1) - Upper body
  P(2, 2, R.ol); P(3, 2, R.mid); P(4, 2, R.mid); P(5, 2, R.sk); P(6, 2, R.mid); P(7, 2, R.sk); P(8, 2, w1); P(9, 2, w2);
  // Face / Eye
  if (isWaiting) {
    P(2, 3, R.ol); P(3, 3, R.ol); // asleep eye
  } else {
    P(2, 3, [255, 255, 255]); P(3, 3, [30, 30, 35]); // open eye
  }
  P(4, 3, R.hi); P(5, 3, R.sk); P(6, 3, R.mid); P(7, 3, R.sk); P(8, 3, R.mid);

  // Row 4 & 5: (Text line 2) - Mid body + stinger
  P(2, 4, R.ol); P(3, 4, R.mid); P(4, 4, R.hi); P(5, 4, R.sk); P(6, 4, R.mid); P(7, 4, R.sk); P(8, 4, R.mid);
  P(1, 5, R.ol); P(2, 5, R.mid); P(3, 5, R.mid); P(4, 5, R.mid); P(5, 5, R.sk); P(6, 5, R.mid); P(7, 5, R.sk); P(8, 5, R.ol); P(9, 5, R.ol); // stinger

  // Row 6 & 7: (Text line 3) - Underbelly
  P(2, 6, R.ol); P(3, 6, R.sh); P(4, 6, R.sh); P(5, 6, R.skd); P(6, 6, R.sh); P(7, 6, R.ol);
  P(3, 7, R.ol); P(4, 7, R.ol); P(5, 7, R.ol); P(6, 7, R.ol);

  return gridToHalfblocks(grid, W, H);
}

/**
 * Generate 2 terminal lines of ANSI half-blocks for a member card avatar (4x4 pixels).
 */
export function generateMiniBee(name = 'worker', state = 'waiting') {
  const W = 4, H = 4;
  const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => null));
  const R = ramp(name);
  const queen = name === 'coordinator';
  const isWaiting = state === 'waiting' || state === 'parked' || state === 'stopped';

  // Row 0 & 1 (Text line 0): Crown/Antenna, Eye, Wing
  if (queen) {
    grid[0][1] = [255, 233, 166]; grid[0][2] = [247, 206, 91];
  } else {
    grid[0][1] = R.ol;
  }
  grid[0][3] = [220, 235, 255]; // wing tip

  // Eye
  if (isWaiting) {
    grid[1][0] = R.ol; grid[1][1] = R.ol;
  } else {
    grid[1][0] = [255, 255, 255]; grid[1][1] = [30, 30, 35];
  }
  grid[1][2] = R.mid;
  grid[1][3] = [200, 220, 250]; // wing

  // Row 2 & 3 (Text line 1): Body + Stinger
  grid[2][0] = R.ol; grid[2][1] = R.sk; grid[2][2] = R.mid; grid[2][3] = R.ol; // stinger
  grid[3][1] = R.ol; grid[3][2] = R.sh;

  return gridToHalfblocks(grid, W, H);
}

function gridToHalfblocks(grid, W, H) {
  const lines = [];
  for (let y = 0; y < H; y += 2) {
    let line = '';
    for (let x = 0; x < W; x++) {
      const top = grid[y]?.[x];
      const bot = grid[y + 1]?.[x];
      if (!top && !bot) {
        line += '\x1b[0m ';
      } else if (top && !bot) {
        line += `\x1b[38;2;${top[0]};${top[1]};${top[2]}m\x1b[49m▀`;
      } else if (!top && bot) {
        line += `\x1b[38;2;${bot[0]};${bot[1]};${bot[2]}m\x1b[49m▄`;
      } else {
        line += `\x1b[38;2;${top[0]};${top[1]};${top[2]}m\x1b[48;2;${bot[0]};${bot[1]};${bot[2]}m▀`;
      }
    }
    line += '\x1b[0m';
    lines.push(line);
  }
  return lines;
}
