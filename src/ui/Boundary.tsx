import { Component, type ReactNode } from 'react';

export class Boundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    return this.state.error ? <div className="entry-message"><img src="/poietra.svg" alt="Poietra"/><h1>画面を開けませんでした</h1><p>再読み込みして接続を確認してください。</p><button onClick={() => location.reload()}>再読み込み</button></div> : this.props.children;
  }
}
