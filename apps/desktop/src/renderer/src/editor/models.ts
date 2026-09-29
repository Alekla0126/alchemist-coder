import type { monaco } from './monaco';

export interface OpenModel {
  model: monaco.editor.ITextModel;
  saved: string;
}

// Models outlive the editor component so switching modes or projects keeps unsaved edits.
export const models = new Map<string, OpenModel>();

/** Reloads an open file after something else changed it on disk (unless it has unsaved edits). */
export async function refreshFromDisk(path: string): Promise<void> {
  const open = models.get(path);
  if (!open || open.model.getValue() !== open.saved) return;
  const content = await window.alchemist.readFile(path).catch(() => null);
  if (content?.text == null) return;
  open.saved = content.text;
  open.model.setValue(content.text);
}
