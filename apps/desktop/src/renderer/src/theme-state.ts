import { create } from 'zustand';
import type { VsTheme } from './theme';

/** The theme in use, for components that shouldn't depend on the whole app store (Markdown). */
export const useCurrentTheme = create<{ theme: VsTheme | null }>(() => ({ theme: null }));
