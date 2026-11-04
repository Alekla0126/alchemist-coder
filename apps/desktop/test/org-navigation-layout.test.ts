import { beforeEach, expect, it, vi } from 'vitest';

vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ sideHidden: true }), setItem: () => {} });
const { useLayout, useViewport, toggleSidebar } = await import('../src/renderer/src/layout');
const loadedLayout = useLayout.getState();
beforeEach(() => {
  useViewport.setState({ narrow: false, drawer: false });
  useLayout.setState({ sideHidden: true, orgSideHidden: false });
});
it('does not inherit a saved hidden conversation sidebar in Organization', () => {
  expect(loadedLayout).toMatchObject({ sideHidden: true, orgSideHidden: false });
  toggleSidebar(true);
  expect(useLayout.getState()).toMatchObject({ sideHidden: true, orgSideHidden: true });
  toggleSidebar();
  expect(useLayout.getState()).toMatchObject({ sideHidden: false, orgSideHidden: true });
});
it('uses a drawer at narrow widths without changing desktop preferences', () => {
  useViewport.setState({ narrow: true });
  toggleSidebar(true);
  expect(useViewport.getState().drawer).toBe(true);
  toggleSidebar(true);
  expect(useViewport.getState().drawer).toBe(false);
  expect(useLayout.getState()).toMatchObject({ sideHidden: true, orgSideHidden: false });
});
