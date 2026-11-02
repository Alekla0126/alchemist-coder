import { createInterface } from 'node:readline';
const send = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (!id) return;
  if (process.env.FAKE_DISCONNECT === '1') return process.exit(1);
  if (process.env.FAKE_HANG === '1') return;
  if (method === 'initialize') return send(id, {});
  if (method === 'model/list') return send(id, params.cursor ? {
    data: [{ id: 'other', model: 'future-small', displayName: 'Future Small', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }], defaultReasoningEffort: 'low' }], nextCursor: null,
  } : {
    data: [{ id: 'catalog-id', model: 'future-large', displayName: 'Future Large', supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'Deep' }], defaultReasoningEffort: 'ultra' }], nextCursor: 'page2',
  });
  if (method === 'account/read') return send(id, { account: { type: 'chatgpt', email: 'test@example.invalid', planType: 'pro', secret: 'never-forward-this' } });
  if (method === 'account/rateLimits/read') {
    if (process.env.FAKE_QUOTA_HANG === '1') return;
    if (process.env.FAKE_NO_QUOTA === '1') return send(id, { rateLimits: null });
    if (process.env.FAKE_QUOTA_ERROR === '1') return process.stdout.write(`${JSON.stringify({ id, error: { code: -32601, message: 'Not supported' } })}\n`);
    return send(id, { rateLimitsByLimitId: { custom: { limitName: 'Custom', primary: { usedPercent: 0, windowDurationMins: 17, resetsAt: 2000000000 }, secondary: null } } });
  }
  // Discovery must never touch sessions or inference, even when it doesn't recognize a reply.
  process.exit(2);
});
