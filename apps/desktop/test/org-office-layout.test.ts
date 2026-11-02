import { describe, expect, it } from 'vitest';
import { toggleDepts, toggleSidebar, useLayout, useViewport } from '../src/renderer/src/layout';

describe('the sidebar button and the office’s departments', () => {
  it('folds the sidebar everywhere (the office too), and the departments only with their own button', () => {
    useLayout.setState({ sideHidden: false, deptsHidden: false });
    useViewport.setState({ narrow: false });
    toggleSidebar();
    expect(useLayout.getState()).toMatchObject({ sideHidden: true, deptsHidden: false });
    toggleSidebar();
    expect(useLayout.getState().sideHidden).toBe(false);
    toggleDepts();
    expect(useLayout.getState()).toMatchObject({ sideHidden: false, deptsHidden: true });
    toggleDepts();
    expect(useLayout.getState().deptsHidden).toBe(false);
  });

  it('opens and closes the floating sidebar on a narrow window, leaving the column as it was', () => {
    useLayout.setState({ sideHidden: false });
    useViewport.setState({ narrow: true, drawer: false });
    toggleSidebar();
    expect(useViewport.getState().drawer).toBe(true);
    expect(useLayout.getState().sideHidden).toBe(false);
    toggleSidebar();
    expect(useViewport.getState().drawer).toBe(false);
  });
});
