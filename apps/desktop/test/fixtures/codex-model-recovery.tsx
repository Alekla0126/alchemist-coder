import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/styles.css';

const sent: unknown[] = [];
const menus: unknown[] = [];
let menuChoice: string | null = null, reject = false;
window.alchemist = new Proxy({
  botTeams: async () => [], botConfigs: async () => [], automations: async () => [], slashCommands: async () => [],
  voiceStatus: async () => ({ engines: [], auto: null, platform: 'fixture' }),
  showMenu: async (items: unknown) => { menus.push(items); const chosen = menuChoice; menuChoice = null; return chosen; },
}, { get: (obj, key) => key in obj ? obj[key as keyof typeof obj] : String(key).startsWith('on') ? () => () => {} : async () => null }) as any;
localStorage.setItem('alchemist.composer', JSON.stringify({ harnessId: 'codex', providerId: 'openai', model: 'legacy-model', permissionMode: 'plan', effort: { codex: 'ultra' } }));
localStorage.removeItem('alchemist.sessionModels');
const { useStore } = await import('../../src/renderer/src/store');
const { Composer } = await import('../../src/renderer/src/components/Composer');
const { CodexStatus } = await import('../../src/renderer/src/components/CodexStatus');
const { drafts, queues } = await import('../../src/renderer/src/composer-state');
const session: any = { id: 'same-saved-session', source: 'codex', projectId: 1, models: ['legacy-model'], title: 'Saved conversation', contextTokens: 0, contextWindow: null, status: 'idle', runningAgents: 0 };
const catalog: any = { harnesses: [{ id: 'codex', label: 'Codex', installed: true }], providers: [
  { id: 'openai', label: 'ChatGPT', available: true, harnesses: ['codex'], models: [{ id: 'catalog-model', label: 'Available catalog model', defaultReasoningEffort: 'low', reasoningEfforts: [{ id: 'low', label: 'Low' }] }], codexRuntime: { connected: true, account: { type: 'chatgpt', plan: 'fixture' }, checkedAt: 1, cliVersion: '0.166.0', cliPath: '/fixture/standalone/0.166.0/bin/codex', skippedCliPaths: ['/fixture/Homebrew/bin/codex'], limits: null } },
  { id: 'paid-api', label: 'Paid API (never selected automatically)', available: true, harnesses: ['codex'], models: [{ id: 'alternative', label: 'Other provider model' }] },
] };
drafts.set('s:same-saved-session', 'Draft retained after model error');
queues.set('s:same-saved-session', ['Pending message retained', 'Another pending message']);
useStore.setState({ locale: 'es', catalog, catalogFresh: true, projects: [{ id: 1, cwd: '/fixture/project', name: 'Local mock' }] as any, botTeams: [], runs: {}, runByTarget: {}, info: { version: '1.3.8', edition: 'pro', personal: true } as any,
  loadCatalog: async () => useStore.setState({ catalog: structuredClone(catalog), catalogFresh: true }),
  startRun: async (_target: string, request: unknown) => { if (reject) throw new Error('model_not_found — mock rejection'); sent.push(request); },
  sendToRun: async (_id: string, text: string) => { if (reject) throw new Error('model_not_found — mock rejection'); sent.push(text); },
} as any);
(window as any).qa = { sent, menus, drafts, queues, choose: (id: string) => { menuChoice = id; }, reject: (v: boolean) => { reject = v; }, offline: () => { catalog.providers[0].available = false; catalog.providers[0].models = []; useStore.setState({ catalog: structuredClone(catalog) }); } };
createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 1000, margin: '40px auto', padding: 20 }}>
  <h1>QA local con mocks — sin inferencias ni cuentas reales</h1>
  <p>Se conserva la conversación <code>same-saved-session</code>.</p>
  <CodexStatus agent={{ harnessId: 'codex', providerId: 'openai', model: 'legacy-model' }} />
  <Composer projectId={1} session={session} />
</main>);
