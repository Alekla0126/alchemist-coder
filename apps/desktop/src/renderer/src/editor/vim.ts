import { create } from 'zustand';
import type { monaco } from './monaco';

const KEY = 'alchemist.editorKeys';

/** How the code editor's keys work: the usual ones, or Vim's (off unless you turn it on). */
export const useEditorKeys = create<{ vim: boolean; setVim(on: boolean): void }>((set) => ({
  vim: (() => {
    try {
      return localStorage.getItem(KEY) === 'vim';
    } catch {
      return false;
    }
  })(),
  setVim(on) {
    try {
      localStorage.setItem(KEY, on ? 'vim' : 'default');
    } catch {
      // no storage: on for this launch only
    }
    set({ vim: on });
  },
}));

type VimModule = typeof import('monaco-vim');
let vimModule: Promise<VimModule> | null = null;
let exCommands: ((save: () => void) => void) | null = null;
/** The editor whose :w saves (the Ex commands are global to Vim). */
let saveCurrent: () => void = () => {};

/**
 * Vim keys on a Monaco editor (loaded the first time they're turned on), with the mode shown in
 * `status`. :w saves, :q and :wq close nothing (tabs close with their ×). Returns what turns it off.
 */
export async function attachVim(editor: monaco.editor.IStandaloneCodeEditor, status: HTMLElement, save: () => void): Promise<() => void> {
  vimModule ??= import('monaco-vim');
  const { initVimMode, VimMode } = await vimModule;
  saveCurrent = save;
  if (!exCommands) {
    exCommands = () => {};
    const Vim = (VimMode as unknown as { Vim: { defineEx(name: string, prefix: string, fn: () => void): void } }).Vim;
    Vim.defineEx('write', 'w', () => saveCurrent());
    Vim.defineEx('wq', 'wq', () => saveCurrent());
    Vim.defineEx('xit', 'x', () => saveCurrent());
  }
  const mode = initVimMode(editor, status);
  return () => mode.dispose();
}
