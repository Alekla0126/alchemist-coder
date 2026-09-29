import { create } from 'zustand';
import type { MenuItem } from '@shared/api';

/** An in-app dialog: Electron has no window.prompt, and confirm() can't mark a destructive choice. */
export interface DialogState {
  title: string;
  message?: string;
  /** Present = a text field with this initial value. */
  input?: string;
  placeholder?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  resolve: (value: string | boolean | null) => void;
}

export interface ToastState {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

interface UiState {
  dialog: DialogState | null;
  toast: ToastState | null;
}

export const useUi = create<UiState>(() => ({ dialog: null, toast: null }));

let toastId = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** A short message at the bottom of the window, optionally with an action like Undo. */
export function toast(text: string, action?: ToastState['action'], ms = 6000) {
  clearTimeout(toastTimer);
  const id = ++toastId;
  useUi.setState({ toast: { id, text, action } });
  toastTimer = setTimeout(() => useUi.getState().toast?.id === id && useUi.setState({ toast: null }), ms);
}

function openDialog(d: Omit<DialogState, 'resolve'>): Promise<string | boolean | null> {
  return new Promise((resolve) => {
    useUi.getState().dialog?.resolve(null);
    useUi.setState({
      dialog: {
        ...d,
        resolve: (value) => {
          useUi.setState({ dialog: null });
          resolve(value);
        },
      },
    });
  });
}

/** Asks for a line of text; null when cancelled. */
export async function promptText(opts: { title: string; message?: string; value?: string; placeholder?: string; confirmLabel: string; cancelLabel: string }): Promise<string | null> {
  const v = await openDialog({ ...opts, input: opts.value ?? '' });
  return typeof v === 'string' ? v : null;
}

/** Asks to confirm; `danger` paints the confirm button red. */
export async function confirmAction(opts: { title: string; message?: string; confirmLabel: string; cancelLabel: string; danger?: boolean }): Promise<boolean> {
  return (await openDialog(opts)) === true;
}

/** Shows a native context menu at the pointer and returns the chosen id. */
/**
 * Runs `fn` every `ms` while the window is visible; a hidden or minimized window costs nothing,
 * and `fn` runs once when it's shown again. Returns the cleanup for useEffect.
 */
export function whileVisible(fn: () => void, ms: number): () => void {
  const timer = setInterval(() => {
    if (!document.hidden) fn();
  }, ms);
  const onShow = () => {
    if (!document.hidden) fn();
  };
  document.addEventListener('visibilitychange', onShow);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onShow);
  };
}

export function openMenu(items: MenuItem[]): Promise<string | null> {
  return window.alchemist.showMenu(items);
}

/** onContextMenu handler that shows `items()` and runs `onPick` with the chosen id. */
export function contextMenu(items: () => MenuItem[], onPick: (id: string) => void) {
  return (e: { preventDefault(): void; stopPropagation(): void; currentTarget: EventTarget | null }) => {
    // Over selected text, the system menu (Copy, Look Up…) is what you want.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim() && e.currentTarget instanceof Node && sel.containsNode(e.currentTarget, true)) return;
    e.preventDefault();
    e.stopPropagation();
    void openMenu(items()).then((id) => id && onPick(id));
  };
}
