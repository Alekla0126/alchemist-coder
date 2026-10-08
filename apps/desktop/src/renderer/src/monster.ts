/**
 * The app's own agent pictures: a friendly little monster drawn from a seed (an agent's name, or one
 * you picked). The same seed always gives the same monster; its colour, shape and eyes tell agents
 * apart even at 16 px. Pure SVG, so it's crisp at any size and needs no files.
 */

/** A seed's numbers: the same seed, the same sequence (mulberry32 over an FNV-1a hash). */
function randomFrom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Body hues, spread around the wheel so neighbours on a chart rarely look alike. */
const HUES = [2, 18, 32, 46, 88, 135, 160, 178, 196, 214, 238, 262, 286, 312, 335];

/** A colour as #rrggbb (understood by every SVG renderer, unlike hsl()). */
function hsl(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export interface MonsterParts {
  hue: number;
  body: number;
  eyes: number;
  mouth: number;
  top: number;
  cheeks: boolean;
  marks: number;
  look: number;
}

/** What a seed draws (also how the picker tells its options apart). */
export function monsterParts(seed: string): MonsterParts {
  const r = randomFrom(seed || 'agent');
  const pick = (n: number) => Math.floor(r() * n);
  return { hue: HUES[pick(HUES.length)]!, body: pick(5), eyes: pick(6), mouth: pick(6), top: pick(7), cheeks: r() < 0.6, marks: pick(4), look: pick(5) };
}

const INK = '#231b33';

export function monsterSvg(seed: string): string {
  const p = monsterParts(seed);
  const body = hsl(p.hue, 68, 63);
  const shade = hsl(p.hue, 52, 40);
  const light = hsl(p.hue, 75, 82);
  const bg = hsl((p.hue + 165) % 360, 50, 86);
  const horn = '#fff1d4';
  const out: string[] = [];
  const add = (s: string) => out.push(s);
  const stroke = `stroke="${shade}" stroke-width="3" stroke-linejoin="round"`;

  // Behind the body: horns, ears, antennae, a sprout.
  switch (p.top) {
    case 0: // two horns
      add(`<path d="M30 34 C24 22 24 14 28 8 C34 16 40 24 42 30 Z" fill="${horn}" ${stroke}/>`);
      add(`<path d="M70 34 C76 22 76 14 72 8 C66 16 60 24 58 30 Z" fill="${horn}" ${stroke}/>`);
      break;
    case 1: // round ears
      add(`<circle cx="22" cy="34" r="11" fill="${body}" ${stroke}/><circle cx="22" cy="34" r="5" fill="${light}"/>`);
      add(`<circle cx="78" cy="34" r="11" fill="${body}" ${stroke}/><circle cx="78" cy="34" r="5" fill="${light}"/>`);
      break;
    case 2: // antennae
      add(`<path d="M40 30 Q34 16 28 12" fill="none" stroke="${shade}" stroke-width="3" stroke-linecap="round"/><circle cx="27" cy="11" r="5" fill="${light}" ${stroke}/>`);
      add(`<path d="M60 30 Q66 16 72 12" fill="none" stroke="${shade}" stroke-width="3" stroke-linecap="round"/><circle cx="73" cy="11" r="5" fill="${light}" ${stroke}/>`);
      break;
    case 3: // one horn
      add(`<path d="M44 26 L50 4 L56 26 Z" fill="${horn}" ${stroke}/>`);
      break;
    case 4: // pointy ears
      add(`<path d="M20 44 L18 14 L42 30 Z" fill="${body}" ${stroke}/><path d="M80 44 L82 14 L58 30 Z" fill="${body}" ${stroke}/>`);
      break;
    case 5: // a sprout
      add(`<path d="M50 26 Q50 16 50 12" stroke="#3f8f4a" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M50 14 C44 4 32 6 30 10 C36 16 46 16 50 14 Z" fill="#7dd87f" stroke="#3f8f4a" stroke-width="2.5" stroke-linejoin="round"/><path d="M50 16 C56 6 68 8 70 12 C64 18 54 18 50 16 Z" fill="#7dd87f" stroke="#3f8f4a" stroke-width="2.5" stroke-linejoin="round"/>`);
      break;
    default: // nothing on top
  }

  // The body: a bust that runs off the bottom.
  const bodies = [
    `<ellipse cx="50" cy="70" rx="36" ry="44"/>`,
    `<rect x="18" y="24" width="64" height="96" rx="32"/>`,
    `<rect x="12" y="34" width="76" height="86" rx="26"/>`,
    `<path d="M50 22 C74 22 84 46 86 72 L88 112 L12 112 L14 72 C16 46 26 22 50 22 Z"/>`,
    // A fuzzy top.
    `<path d="M16 60 L18 44 L26 48 L28 32 L37 38 L42 24 L50 32 L58 24 L63 38 L72 32 L74 48 L82 44 L84 60 L88 112 L12 112 Z"/>`,
  ];
  const shape = bodies[p.body]!;
  add(shape.replace(/\/>$/, ` fill="${body}"/>`));
  // Inside the body: markings (a belly, spots or stripes), a soft shadow low on one side and a shine.
  const inside: string[] = [];
  if (p.marks === 1) inside.push(`<ellipse cx="50" cy="104" rx="24" ry="20" fill="${light}"/>`);
  if (p.marks === 2) inside.push(`<circle cx="24" cy="78" r="4.5" fill="${shade}" opacity=".35"/><circle cx="76" cy="84" r="6" fill="${shade}" opacity=".35"/><circle cx="70" cy="70" r="3" fill="${shade}" opacity=".35"/>`);
  if (p.marks === 3) inside.push(`<path d="M30 92 Q50 98 70 92 M33 101 Q50 107 67 101" fill="none" stroke="${shade}" stroke-width="3" stroke-linecap="round" opacity=".35"/>`);
  inside.push(`<ellipse cx="86" cy="96" rx="22" ry="44" fill="${shade}" opacity=".18"/>`);
  inside.push(`<ellipse cx="30" cy="40" rx="12" ry="7" transform="rotate(-35 30 40)" fill="#fff" opacity=".28"/>`);
  add(`<clipPath id="b">${shape}</clipPath><g clip-path="url(#b)">${inside.join('')}</g>`);
  // The outline last, over the markings.
  add(shape.replace(/\/>$/, ` fill="none" ${stroke}/>`));

  // Eyes: two, one or three, looking a little to one side.
  const dx = [-2, -1, 0, 1, 2][p.look]!;
  const eye = (x: number, y: number, r: number) =>
    `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" stroke="${INK}" stroke-width="1.5"/><circle cx="${x + dx * (r / 9)}" cy="${y + 1}" r="${r * 0.52}" fill="${INK}"/><circle cx="${x + dx * (r / 9) + r * 0.2}" cy="${y - r * 0.18}" r="${r * 0.2}" fill="#fff"/>`;
  const sleepy = (x: number, y: number, r: number) => `<path d="M${x - r - 1} ${y} A${r + 1} ${r + 1} 0 0 1 ${x + r + 1} ${y} Z" fill="${body}" stroke="${shade}" stroke-width="2"/>`;
  switch (p.eyes) {
    case 0:
    case 1:
      add(eye(37, 54, 10) + eye(63, 54, 10));
      break;
    case 2:
      add(eye(50, 52, 15));
      break;
    case 3:
      add(eye(32, 56, 7.5) + eye(50, 48, 8.5) + eye(68, 56, 7.5));
      break;
    case 4: // sleepy
      add(eye(37, 55, 10) + eye(63, 55, 10) + sleepy(37, 55, 10) + sleepy(63, 55, 10));
      break;
    default: // big and small
      add(eye(36, 54, 11) + eye(64, 56, 7.5));
  }

  if (p.cheeks) add(`<ellipse cx="25" cy="69" rx="6.5" ry="3.8" fill="#ff7aa2" opacity=".55"/><ellipse cx="75" cy="69" rx="6.5" ry="3.8" fill="#ff7aa2" opacity=".55"/>`);

  // Mouth.
  const ink = `stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"`;
  switch (p.mouth) {
    case 0: // smile
      add(`<path d="M40 72 Q50 81 60 72" fill="none" ${ink}/>`);
      break;
    case 1: // open, with a tongue
      add(`<path d="M38 70 Q50 70 62 70 Q60 84 50 84 Q40 84 38 70 Z" fill="${INK}" ${ink}/><path d="M43 79 Q50 74 57 79 Q54 83 50 83 Q46 83 43 79 Z" fill="#ff8fab"/>`);
      break;
    case 2: // a fang
      add(`<path d="M39 72 Q50 80 61 72" fill="none" ${ink}/><path d="M53 76 L56 83 L59 75 Z" fill="#fff" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>`);
      break;
    case 3: // two teeth
      add(`<path d="M39 70 Q50 70 61 70 Q59 82 50 82 Q41 82 39 70 Z" fill="${INK}" ${ink}/><rect x="44" y="70" width="5" height="5" rx="1" fill="#fff"/><rect x="51" y="70" width="5" height="5" rx="1" fill="#fff"/>`);
      break;
    case 4: // cat mouth
      add(`<path d="M40 73 Q45 78 50 73 Q55 78 60 73" fill="none" ${ink}/>`);
      break;
    default: // surprised
      add(`<ellipse cx="50" cy="76" rx="5" ry="6" fill="${INK}"/>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${bg}"/>${out.join('')}</svg>`;
}

const uris = new Map<string, string>();

/** The monster as an image source, kept once drawn. */
export function monsterUri(seed: string): string {
  let uri = uris.get(seed);
  if (!uri) {
    uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(monsterSvg(seed))}`;
    if (uris.size > 500) uris.clear();
    uris.set(seed, uri);
  }
  return uri;
}

/** A new seed for the picker's "another one". */
export const newMonsterSeed = () => Math.random().toString(36).slice(2, 10);
