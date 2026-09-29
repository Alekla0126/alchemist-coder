import { app, dialog, shell, type BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { flattenAgents, toHtml, toJson, toMarkdown, type ExportInput } from '@alchemist-coder/archive';
import type { IndexReader } from '@alchemist-coder/indexer';
import type { ExportFormat } from '../shared/api';

const PAGE = 1000;
const FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  md: { name: 'Markdown', extensions: ['md'] },
  html: { name: 'HTML', extensions: ['html'] },
  json: { name: 'JSON', extensions: ['json'] },
};

/** Everything the exporters need: the session, its project and every agent's full transcript. */
export function exportInput(reader: IndexReader, sessionId: string): ExportInput {
  const session = reader.getSession(sessionId);
  const tree = reader.getAgentTree(sessionId);
  if (!session || !tree) throw new Error('Conversation not found');
  const project = reader.listProjects().find((p) => p.id === session.projectId) ?? null;
  const agents = flattenAgents(tree).map((node) => {
    const entries = [];
    let offset: number | null = 0;
    while (offset != null) {
      const page = reader.getTranscript(sessionId, node.id, offset, PAGE);
      entries.push(...page.entries);
      offset = page.nextOffset;
    }
    return { node, entries };
  });
  return { session, project: project && { name: project.name, cwd: project.cwd }, agents, exportedAt: Date.now() };
}

export async function exportSession(window: BrowserWindow | null, reader: IndexReader, sessionId: string, format: ExportFormat): Promise<string | null> {
  if (!FILTERS[format]) throw new Error('Unknown format');
  const input = exportInput(reader, sessionId);
  const name = input.session.title.replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || sessionId;
  const options = { defaultPath: join(app.getPath('downloads'), `${name}.${format}`), filters: [FILTERS[format]] };
  const choice = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (choice.canceled || !choice.filePath) return null;
  const text = format === 'md' ? toMarkdown(input) : format === 'html' ? toHtml(input) : toJson(input);
  await writeFile(choice.filePath, text, 'utf8');
  shell.showItemInFolder(choice.filePath);
  return choice.filePath;
}
