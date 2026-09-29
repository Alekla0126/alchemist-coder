import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { translate } from '../src/renderer/src/i18n';
import { QuestionForm } from '../src/renderer/src/components/QuestionForm';

// The store talks to the app's preload bridge; the card only needs its answer action and texts.
vi.mock('../src/renderer/src/store', () => ({
  useStore: (pick: (s: unknown) => unknown) => pick({ answerQuestion: async () => {} }),
  useT: () => (key: never, vars?: Record<string, string | number>) => translate('en', key, vars),
}));

describe('QuestionForm', () => {
  it("draws the agent's question: options with their notes, several picks, an Other box, send and skip", () => {
    const html = renderToStaticMarkup(
      <QuestionForm
        runId="r1"
        request={{
          requestId: 'form-1',
          message: 'Please answer the following questions.',
          fields: [
            { key: 'question_0', title: 'Color', description: 'Which color?', kind: 'single', options: [{ value: 'Red', title: 'Red', description: 'Warm' }, { value: 'Blue', title: 'Blue', description: '' }] },
            { key: 'question_0_custom', title: 'Other', description: '', kind: 'text', options: [], forKey: 'question_0' },
            { key: 'question_1', title: 'Extras', description: 'Add anything?', kind: 'multi', options: [{ value: 'a', title: 'Tests', description: '' }] },
          ],
        }}
      />,
    );
    // The adapter's generic title says nothing: the card counts the questions instead.
    expect(html).not.toContain('Please answer the following questions.');
    expect(html).toContain('2 questions');
    // Number keys pick the first question's options.
    expect(html.match(/class="perm-key q-key"/g)).toHaveLength(2);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
    expect(html).toContain('<small>Warm</small>');
    // The Other box sits under its question instead of showing as a question of its own.
    expect(html).not.toContain('>Other<');
    expect(html.match(/class="q-text"/g)).toHaveLength(1);
    // Nothing picked yet: sending waits, skipping doesn't.
    expect(html).toMatch(/<button class="perm-btn allow_once" disabled=""/);
    expect(html).toMatch(/<button class="perm-btn"[^>]*>Skip</);
  });
});
