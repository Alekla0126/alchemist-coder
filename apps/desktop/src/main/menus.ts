import { BrowserWindow, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron';
import type { MenuItem } from '../shared/api';

const ID = /^[\w:.-]{1,80}$/;

/** Only well-formed items become menu entries (the renderer's input is never trusted). */
function build(items: unknown, choose: (id: string) => void, depth = 0): MenuItemConstructorOptions[] {
  if (!Array.isArray(items) || depth > 2) return [];
  return items.slice(0, 40).flatMap((raw): MenuItemConstructorOptions[] => {
    const item = raw as Partial<MenuItem & { type: string }>;
    if (item?.type === 'separator') return [{ type: 'separator' }];
    const { id, label } = item as { id?: unknown; label?: unknown };
    if (typeof id !== 'string' || !ID.test(id) || typeof label !== 'string' || !label || label.length > 200) return [];
    const it = item as Extract<MenuItem, { id: string }>;
    const submenu = it.submenu ? build(it.submenu, choose, depth + 1) : undefined;
    return [
      {
        label,
        enabled: it.enabled !== false,
        ...(typeof it.checked === 'boolean' ? { type: 'checkbox' as const, checked: it.checked } : {}),
        ...(typeof it.accelerator === 'string' && it.accelerator.length < 40 ? { accelerator: it.accelerator, registerAccelerator: false } : {}),
        ...(submenu?.length ? { submenu } : { click: () => choose(id) }),
      },
    ];
  });
}

/** Shows a native context menu for the window that asked; resolves to the chosen id or null. */
export function showMenu(sender: WebContents, items: unknown): Promise<string | null> {
  return new Promise((resolve) => {
    let chosen: string | null = null;
    const template = build(items, (id) => (chosen = id));
    const window = BrowserWindow.fromWebContents(sender);
    if (!template.length || !window) return resolve(null);
    // The click handler runs before the close callback, so `chosen` is set by then.
    Menu.buildFromTemplate(template).popup({ window, callback: () => resolve(chosen) });
  });
}

/** Right-click on text or a field: the usual edit menu, with spelling suggestions. */
export function editMenu(contents: WebContents) {
  contents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];
    for (const word of params.dictionarySuggestions.slice(0, 5)) template.push({ label: word, click: () => contents.replaceMisspelling(word) });
    if (params.misspelledWord) template.push({ label: 'Add to Dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' });
    if (params.isEditable) template.push({ role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy }, { role: 'paste', enabled: params.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' });
    else if (params.selectionText.trim()) template.push({ role: 'copy' }, { role: 'selectAll' });
    if (template.length) Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
  });
}

const LABELS = {
  en: {
    settings: 'Settings…', file: 'File', newConversation: 'New Conversation', newProject: 'New Project…', openFolder: 'Open Folder…', newTerminal: 'New Terminal', openProject: 'Open Project…', closeTab: 'Close Tab',
    view: 'View', agents: 'Agents', arena: 'Arena', code: 'Code', split: 'Split', terminal: 'Terminal', history: 'History', bots: 'Organization', marketing: 'Marketing', sidebar: 'Toggle Sidebar',
    palette: 'Command Palette…', search: 'Search Conversations', website: 'Alchemist Coder Website', issue: 'Report an Issue',
  },
  es: {
    settings: 'Ajustes…', file: 'Archivo', newConversation: 'Nueva conversación', newProject: 'Proyecto nuevo…', openFolder: 'Abrir carpeta…', newTerminal: 'Nueva terminal', openProject: 'Abrir proyecto…', closeTab: 'Cerrar pestaña',
    view: 'Ver', agents: 'Agentes', arena: 'Arena', code: 'Código', split: 'Dividido', terminal: 'Terminal', history: 'Historial', bots: 'Organización', marketing: 'Marketing', sidebar: 'Mostrar u ocultar barra lateral',
    palette: 'Paleta de comandos…', search: 'Buscar conversaciones', website: 'Sitio de Alchemist Coder', issue: 'Reportar un problema',
  },
} as const;

/** The menu bar. Commands the renderer handles are sent as `app:command` with an id. Call again when the language changes. */
export function appMenu(send: (command: string) => void, options: { debug: boolean; name: string; issuesUrl: string; siteUrl: string; openExternal: (url: string) => void; locale?: 'en' | 'es' }) {
  const cmd = (id: string) => () => send(id);
  const L = LABELS[options.locale ?? 'en'];
  const mac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: options.name,
            submenu: [{ role: 'about' }, { type: 'separator' }, { label: L.settings, accelerator: 'CmdOrCtrl+,', click: cmd('settings') }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: L.file,
      submenu: [
        { label: L.newConversation, accelerator: 'CmdOrCtrl+N', click: cmd('new-conversation') },
        { label: L.newProject, accelerator: 'CmdOrCtrl+Shift+N', click: cmd('new-project') },
        { label: L.newTerminal, accelerator: 'CmdOrCtrl+T', click: cmd('new-terminal') },
        { type: 'separator' },
        { label: L.openProject, accelerator: 'CmdOrCtrl+O', click: cmd('open-project') },
        { label: L.openFolder, click: cmd('open-folder') },
        { type: 'separator' },
        { label: L.closeTab, accelerator: 'CmdOrCtrl+W', click: cmd('close-tab') },
        ...(mac ? [] : [{ type: 'separator' as const }, { label: L.settings, accelerator: 'CmdOrCtrl+,', click: cmd('settings') }, { role: 'quit' as const }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: L.view,
      submenu: [
        { label: L.agents, accelerator: 'CmdOrCtrl+1', click: cmd('mode:agents') },
        { label: L.arena, accelerator: 'CmdOrCtrl+2', click: cmd('mode:arena') },
        { label: L.code, accelerator: 'CmdOrCtrl+3', click: cmd('mode:code') },
        { label: L.split, accelerator: 'CmdOrCtrl+4', click: cmd('mode:split') },
        { label: L.terminal, accelerator: 'CmdOrCtrl+5', click: cmd('mode:terminal') },
        { label: L.history, accelerator: 'CmdOrCtrl+6', click: cmd('mode:history') },
        { label: L.bots, accelerator: 'CmdOrCtrl+7', click: cmd('mode:bots') },
        { label: L.marketing, accelerator: 'CmdOrCtrl+8', click: cmd('mode:marketing') },
        { type: 'separator' },
        { label: L.sidebar, accelerator: 'CmdOrCtrl+B', click: cmd('toggle-sidebar') },
        { label: L.palette, accelerator: 'CmdOrCtrl+K', click: cmd('palette') },
        { label: L.search, accelerator: 'CmdOrCtrl+Shift+F', click: cmd('mode:history') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(options.debug ? [{ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: L.website, click: () => options.openExternal(options.siteUrl) },
        { label: L.issue, click: () => options.openExternal(options.issuesUrl) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
