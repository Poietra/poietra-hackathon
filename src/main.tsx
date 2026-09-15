import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/noto-sans-jp/400.css';
import { App } from './App';
import { EditorStore, currentRoom } from './editor/store';
import { loadKernel } from './engine/kernel';
import * as renderer from './engine/renderer';
import * as exporter from './engine/export';
import './styles.css';

class Boundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <div className="loading-screen"><h1>編集画面を開けませんでした</h1><p>再読み込みして接続を確認してください。</p><button className="primary-button" onClick={() => location.reload()}>再読み込み</button></div> : this.props.children; }
}

const root = createRoot(document.getElementById('root')!);
root.render(<div className="loading-screen"><img src="/poietra.svg" alt="Poietra"/><span>Opening your studio</span></div>);
loadKernel().then(kernel => { const store = new EditorStore(currentRoom()); root.render(<StrictMode><Boundary><App store={store} kernel={kernel} renderer={renderer} exporter={exporter}/></Boundary></StrictMode>); }).catch(error => root.render(<div className="loading-screen"><h1>Poietra</h1><p>{error instanceof Error ? error.message : '読み込みに失敗しました。'}</p><button onClick={() => location.reload()}>再読み込み</button></div>));
