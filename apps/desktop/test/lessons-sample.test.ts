import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { OrgLesson } from '../src/shared/api';
import { BotManager } from '../src/main/bots';
import { writeBridge } from '../src/main/bots-bridge';

// 30 lessons shaped like a real organization's (the same kinds of rules, no internal names).
const REAL: OrgLesson[] = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/org-lessons-sample.json'), 'utf8'));
/** The three about safety a bot must never miss (the review of AC-012 found them missing). */
const SAFETY = ['verificador de políticas de la tienda', 'archivos de autorización', 'la etiqueta de la versión publicada en la tienda'];

const dir = mkdtempSync(join(tmpdir(), 'lessons-sample-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };

/** The prompt a bot with this role gets for this task, with these lessons saved. */
async function promptOf(role: string, task: string, lessons: OrgLesson[] = REAL) {
  const prompts: string[] = [];
  const runner = { start: (req: { prompt: string }) => (prompts.push(req.prompt), { runId: `run-${prompts.length}` }), send: () => {}, stop: () => {}, observe: () => () => {} };
  const bots = new BotManager({ configs: join(dir, `c-${Math.random()}.json`), teams: join(dir, `t-${Math.random()}.json`) }, runner as never, { command: process.execPath, script: writeBridge(dir) }, (cwd) => String(cwd), () => {});
  const lead = bots.ensureOrg(agent, { coordinator: { name: 'Coordinator', role: 'Plan' } }).find((c) => c.kind === 'coordinator')!;
  bots.saveOrgSettings({ lessons });
  const team = bots.startTeam({ goal: task, cwd: '/p', configId: lead.id });
  await bots.callTool({ teamId: team.id, botId: 'b1' }, 'create_bot', { name: 'Bot', task, role });
  return { coordinator: prompts[0]!, bot: prompts[1]!, bots, me: { teamId: team.id, botId: 'b2' } };
}

const ROLES = {
  android: ['Implementa la tarea con cambios pequeños y enfocados, al estilo del proyecto. Corre el build o las pruebas relevantes antes de responder y lista los archivos que cambiaste.', 'Arregla el build de Android de la app: ./gradlew assembleDebug falla en el emulador.'],
  marketing: ['Escribe posts y piezas de promoción para redes de las apps, con el tono de cada una.', 'Prepara tres posts de TikTok de la app de fútbol para esta semana.'],
  tester: ['Escribe y corre pruebas; no cambia el código de producción.', 'Escribe pruebas para la pantalla de ajustes del panel.'],
} as const;

describe('the lessons a bot is told, with an organization’s worth of them', () => {
  it('measures the Android programmer’s prompt', async () => {
    const { bot } = await promptOf(...ROLES.android);
    console.log(`sample lessons: ${REAL.length}, ${REAL.reduce((n, l) => n + l.text.length, 0)} chars; Android programmer's prompt: ${bot.length} chars ≈ ${Math.round(bot.length / 4)} tok; lessons told: ${REAL.filter((l) => bot.includes(l.text)).length}`);
  });

  it.each(Object.entries(ROLES))('tells the %s bot the three lessons about safety', async (_, [role, task]) => {
    const { bot } = await promptOf(role, task);
    for (const s of SAFETY) expect(bot).toContain(s);
  });

  it('tells every bot a pinned lesson, even with no word in common with its task', async () => {
    const pinned: OrgLesson = { id: 'pin', text: 'Escribe los commits en inglés y en minúsculas.', by: 'Owner', from: '', at: 0, pinned: true };
    const { bot } = await promptOf('Diseña iconos.', 'Dibuja el icono de la app de fondos.', [...REAL, pinned].slice(-30));
    expect(bot).toContain(pinned.text);
    // Unpinned, the same lesson isn't told for that task.
    const { bot: plain } = await promptOf('Diseña iconos.', 'Dibuja el icono de la app de fondos.', [...REAL.slice(1), { ...pinned, pinned: false }]);
    expect(plain).not.toContain(pinned.text);
  });

  it('says how many it left out and hands all of them over with org_lessons, the coordinator getting them all', async () => {
    const { bot, coordinator, bots, me } = await promptOf(...ROLES.tester);
    const told = REAL.filter((l) => bot.includes(l.text)).length;
    expect(bot).toContain(`(${30 - told} more lessons: call org_lessons)`);
    for (const l of REAL) expect(coordinator).toContain(l.text);
    expect(coordinator).toContain('bot_reply');
    expect(coordinator).toContain('org_lessons');
    const all = await bots.callTool(me, 'org_lessons', {});
    for (const l of REAL) expect(all).toContain(l.text);
    expect(all.length).toBeLessThanOrEqual(12_002);
  });

  it('keeps a pinned lesson when a new one would push the oldest out', async () => {
    const { bots, me } = await promptOf(...ROLES.tester, REAL.map((l, i) => (i === 29 ? { ...l, pinned: true } : l)));
    await bots.callTool(me, 'record_lesson', { lesson: 'Una lección nueva cualquiera.' });
    const kept = bots.orgSettings().lessons;
    expect(kept).toHaveLength(30);
    expect(kept.some((l) => l.id === REAL[29]!.id && l.pinned)).toBe(true);
    expect(kept.some((l) => l.id === REAL[28]!.id)).toBe(false);
  });
});
