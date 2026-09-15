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

開発サーバーは `http://localhost:5173`。Composition の配置・表示期間、オブジェクト別の Transition、ベジェ移動パス、連結・整列、共同編集、数式と動画書き出しを実装しています。AI はサーバー側のキーを設定すると使えます。

AI はサーバーの `OPENAI_API_KEY` を使います。設定例は [.env.example](.env.example)。実際のキーは `.env` に設定し、Git には含めません。

```bash
pnpm typecheck
pnpm test
pnpm test:core
pnpm test:e2e
```

## 共有環境（Cloudflare）

[Poietra を開く](https://poietra-hackathon.yumaboda-official.workers.dev)

Workers が画面と API を配信し、部屋ごとの Durable Object が WebSocket 同期と SQLite 保存を担当します。描画・Rust WASM の時間評価・WebCodecs 書き出しはブラウザで行います。

```bash
pnpm build:web
pnpm dev:worker
# 別ターミナル: 本番と同じ Workers 実行環境で共同編集を検証
POIETRA_TEST_URL=http://127.0.0.1:8787 pnpm test:e2e
```

配置先は Yumaboda の Cloudflare アカウントです。`wrangler.jsonc` の `account_id` に固定しています。別アカウントに配置するときはこの値を変更してください。

```bash
pnpm exec wrangler login
pnpm deploy
# AI のキーをサーバー側の Secret に設定（対話入力）
pnpm exec wrangler secret put OPENAI_API_KEY
```

ローカルの Workers で AI を試す場合は `.dev.vars.example` を `.dev.vars` にコピーしてキーを設定します。キーをクライアントや Git に含めないでください。

Share でコピーした URL を別のブラウザで開くと、同じ部屋に参加します。リンクを知っている人が編集できます。編集データはサーバーと各ブラウザに保存され、再接続時に同期されます。再生位置・選択は各自で操作でき、取り消しは自分の変更が対象です。

## デモの流れ

1. Share の URL を別の PC でも開き、円の位置や色を変更して同期を確認する。
2. Composition 2 を選び、同じ円の別の配置を調整する。
3. Transition を選び、Move と Equation の Write を別々に調整する。円を選び `Edit Bézier path` で移動経路を曲げる。
4. Preview で動きを確認する。AI 接続済みの場合は Assistant に変更を頼み、編集案を Apply する。
5. Export で MP4 または WebM を書き出す。Chrome / Edge を使用する。

検証済み: Rust 3 件、描画・書き出し・同期データの単体テスト 36 件、共同編集のブラウザテスト 4 件、書き出しのブラウザテスト 5 件。AI の実 API 呼び出しはキーの設定後に検証します。

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
