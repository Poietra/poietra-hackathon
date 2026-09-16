import { Component, type ReactNode } from 'react';
import { pageCopy } from '../locale';

export class Boundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    const copy = pageCopy[typeof document !== 'undefined' && document.documentElement.lang === 'ja' ? 'ja' : 'en'];
    return this.state.error ? <div className="entry-message"><img src="/poietra.svg" alt="Poietra"/><h1>{copy.loadError}</h1><p>{copy.retryHint}</p><button onClick={() => location.reload()}>{copy.retry}</button></div> : this.props.children;
  }
}
