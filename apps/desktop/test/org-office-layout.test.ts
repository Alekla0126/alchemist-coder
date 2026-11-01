import { describe, expect, it } from 'vitest';
import { toggleSidebar, useLayout, useViewport } from '../src/renderer/src/layout';

describe('the sidebar button on the office', () => {
  it('folds the departments and leaves the other views’ sidebar as it was', () => {
    useLayout.setState({ sideHidden: false, deptsHidden: false });
    useViewport.setState({ office: true, narrow: false });
    toggleSidebar();
    expect(useLayout.getState()).toMatchObject({ deptsHidden: true, sideHidden: false });
    toggleSidebar();
    expect(useLayout.getState().deptsHidden).toBe(false);
    // Elsewhere it's the sidebar again.
    useViewport.setState({ office: false });
    toggleSidebar();
    expect(useLayout.getState()).toMatchObject({ deptsHidden: false, sideHidden: true });
  });
});
