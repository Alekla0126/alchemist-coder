import { Component, type ReactNode } from 'react';

/** Keeps one broken panel (e.g. the editor) from taking down the whole window. */
export class PanelBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(`[${this.props.label}]`, error.stack ?? error.message);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel-empty">
        <b>{this.props.label}</b>
        <span>{this.state.error.message}</span>
        <button className="link" onClick={() => this.setState({ error: null })}>
          ↻
        </button>
      </div>
    );
  }
}
