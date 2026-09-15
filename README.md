# Poietra

友人と、AI と。編集できる構造を保ちながら、一緒に動画を作るブラウザ編集環境。

2026-09-15 のハッカソン向けに実装中です。画面の基準と決定事項は [AGENTS.md](AGENTS.md) を参照してください。

## 開発

Node.js 24 以上、pnpm 10、Rust（`wasm32-unknown-unknown` ターゲット）を使います。

```bash
pnpm install
pnpm build:wasm
pnpm dev
```

開発サーバーは `http://localhost:5173`。画面は実装中です。描画・書き出しは下記の専用検証ページで確認できます。

AI はサーバーの `OPENAI_API_KEY` を使います。設定例は [.env.example](.env.example)。実際のキーは `.env` に設定し、Git には含めません。

```bash
pnpm typecheck
pnpm test:core
```

## 実装の分担

- UI・操作・編集データ・共同編集・AI 接続・統合：Hosi121 / Codex
- 数式・図形の描画、Write、動画書き出し：furukawa1020

描画・書き出しの呼び出し口は [render-contract.ts](src/engine/render-contract.ts)、共通のモデルは [model.ts](shared/model.ts) に定義しています。

## 図形・数式と動画書き出し

`renderer.ts` は共通の `Frame` を SVG に変換し、`export.ts` は開始時点の Scene をコピーして同じ評価・描画を各フレームに使います。数式変換・フォントは `rendering/`、ブラウザのコーデック判定・SVG の画像化・中断処理は `exporting/` に分離しています。編集モデルや UI に依存関係を追加していません。

- 円、矩形、テキスト、数式、ベジェ曲線、矢印、数直線。回転・不透明度・塗り・線・角丸・glow に対応。
- 数式は MathJax の SVG パス。Write は字形ごとの同時／順次描画。日本語と欧文テキストは同梱フォントの必要な部分を SVG に埋め込みます。
- MP4/H.264 と WebM/VP9（未対応時 VP8）を実際の WebCodecs API で判定。24/30/60 fps、指定サイズ、進捗、中断に対応。音声は含みません。

### 検証

Node.js 24、pnpm 10 と Chrome を使います。Rust が使えなくても同梱 WASM で確認できます。`pnpm` が PATH にない環境では以下の先頭を `corepack pnpm` に置き換えてください。

```bash
pnpm typecheck
pnpm test
pnpm exec vite build --config tests/e2e/export-build.config.ts
pnpm exec playwright test --config tests/e2e/export.config.ts
```

ブラウザテストは専用の Vite 検証ページを起動し、日本語を加えた初期デモを保存・デコードして、1280×720、30 fps、約3.4秒、102フレーム、表示内容、編集中のスナップショット、中断、非対応環境を確認します。動画・比較画像・JSON レポートは `test-results/export/` に保存します。本番ビルドを検証する場合は `EXPORT_PREVIEW=1` を環境変数に設定して同じブラウザテストを実行します。`CHROME_PATH` で実行する Chrome を指定できます。未指定時は Windows のインストール済み Chrome、他環境では Playwright の Chromium を使います。

### 制限

- `prepareScene(scene)` の完了後に `frameToSvg` と `objectBounds` を呼びます。数式は TeX の base / ams に対応し、未対応・不正な入力は安全なテキスト表示に戻ります。
- 通常テキストのサイズはブラウザでは読み込んだフォントで計測し、Node.js では近似値を返します。同梱フォントにない文字・絵文字は環境依存の表示です。
- MP4 の寸法は偶数。サイズ比率を変えると余白を入れて Scene の比率を保ちます。WebM は最終フレームを丸ごと保持するため、端数のある Scene は最大1フレーム未満長くなり、実際の長さを返します。
- エンコード・ファイル確定中の中断は、実行中の呼び出しが終わってから解放します。メモリ上で動画をまとめるため、まず短いハッカソン用動画を対象とします。
