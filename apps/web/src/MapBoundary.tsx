import { Component, type ReactNode } from 'react';

/** If a map's code cannot be downloaded — offline, or a deploy mid-flight — the page carries on without it. */
export class MapBoundary extends Component<{ message: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <div className="wx-map wx-map-loading">{this.props.message}</div> : this.props.children;
  }
}
