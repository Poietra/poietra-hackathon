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
pnpm test:export
pnpm test:collaboration
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
pnpm run deploy
# AI のキーをサーバー側の Secret に設定（対話入力）
pnpm exec wrangler secret put OPENAI_API_KEY
```

ローカルの Workers で AI を試す場合は `.dev.vars.example` を `.dev.vars` にコピーしてキーを設定します。キーをクライアントや Git に含めないでください。

Share でコピーした URL を別のブラウザで開くと、同じ部屋に参加します。リンクを知っている人が編集できます。編集データはサーバーと各ブラウザに保存され、再接続時に同期されます。再生位置・選択は各自で操作でき、取り消しは自分の変更が対象です。ローカル Node 開発版のファイル保存は 200 ms まとめて実行し、共有環境では SQLite の保存完了後に配信します。

左上の **P** から、新規プロジェクトの作成・例の複製・`.poietra.json` の保存と読み込みができます。読み込みは新しい共有リンクを作るため、元の共同編集プロジェクトを上書きしません。読み込みファイルは 1 MB 以下です。**Follow the gradient** は、順伝播・損失・連鎖律を描く 13.3 秒の例です。25 個のオブジェクトと個々の動きをそのまま編集できます。

Composition のメニューから状態を複製・削除できます。同時に最後の状態を削除した場合も、全員が同じ1つの状態を保持します。取り消しで他の人の編集は戻りません。オブジェクトは `Ctrl/Cmd+C`・`Ctrl/Cmd+V` で別の Composition やプロジェクトへコピーでき、`Ctrl/Cmd+Shift+V` で元の位置に貼り付けます。矢印キーは1 px、Shiftと組み合わせると10 px移動します。

Assistant は選択中のオブジェクト・Composition・Transition を対象に編集案を作ります。移動パスや図形のベジェ制御点も変更でき、Apply前に対象の位置や構造が変わった場合は提案を作り直します。

## デモの流れ

1. Share の URL を別の PC でも開き、円の位置や色を変更して同期を確認する。
2. Composition 2 を選び、同じ円の別の配置を調整する。
3. Transition を選び、Move と Equation の Write を別々に調整する。円を選び `Edit Bézier path` で移動経路を曲げる。
4. Preview で動きを確認する。AI 接続済みの場合は Assistant に変更を頼み、編集案を Apply する。
5. Export で MP4 または WebM を書き出す。Chrome / Edge を使用する。

検証では、別ブラウザ間の共同編集・オフライン編集の合流・取り消し、実 workerd の強制休止と再起動後の復元、キャンバス・タイムライン・ロック・レイヤー順・ファイル読み込みを確認します。AI は API を代替したテストで提案の競合、キャンセル、再試行を検証しています。共有環境の実 OpenAI API でも、選択した円の色だけを変更する提案・別ブラウザへの適用・共同編集者の位置変更を保持した Undo を確認済みです。

`pnpm test:e2e` はローカルの専用ページで描画の待ち合わせ・中断・SVGへの復帰も確認します。`POIETRA_TEST_URL` を指定した場合は、公開アプリで実行できる編集操作のテストを対象にします。

## 実装の分担

- UI・操作・編集データ・共同編集・AI 接続・統合：Hosi121 / Codex
- 数式・図形の描画、Write、動画書き出し：furukawa1020

描画・書き出しの呼び出し口は [render-contract.ts](src/engine/render-contract.ts)、共通のモデルは [model.ts](shared/model.ts) に定義しています。

## 図形・数式と動画書き出し

`renderer.ts` は `Frame` を SVG に変換し、`painter.ts` は完成フレームを Canvas に描きます。`export.ts` は開始時点の Scene をコピーし、各時刻の評価結果を同じ painter で描画してエンコードします。数式・フォント・SVG 画像の読み込みは `rendering/`、コーデック判定と書き出しの中断処理は `exporting/` に分けています。

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

## 共通 Canvas 描画と WebGL2 Glow

`createFramePainter(canvas)`（[painter.ts](src/engine/painter.ts)）は、評価済みの `Frame` を Canvas に描きます。`prepareScene(scene)` を済ませ、同じ painter の `render(frame, { signal })` を直列に呼んでください。出力は Canvas の現在の寸法に合わせ、Scene の縦横比を保ちます。`dispose()` は描画中でも呼べ、繰り返し呼んでも安全です。契約は [painter-contract.ts](src/engine/painter-contract.ts) に従います。

- **描画**: 対象オブジェクトだけを透明な画像にし、GLSL の横・縦 Gaussian ぼかしと元画像の合成で Glow を描きます。強さと余白は SVG と同じ定義を参照します。Write・回転・不透明度・表示順を反映し、完成したフレームだけを出力 Canvas にコピーします。
- **再利用と解放**: 位置・回転・不透明度だけの変化では画像を再利用します。画像キャッシュは painter ごとに 32 MiB まで。画像と Object URL は読み込み処理、キャッシュは `LayerCache`、GPU 資源は Glow renderer が所有し、それぞれ解放します。
- **継続動作**: 出力 Canvas は 2D、WebGL2 は内部 Canvas で使います。WebGL2 非対応・context lost・GPU の描画失敗・大きすぎる画像では、既存 SVG と Canvas 2D に切り替えます。`backend` は現在の経路を返します。画像読み込みの失敗は呼び出し側へ返し、中断は `AbortError` になります。
- **動画**: MP4 / WebM の各フレームを同じ painter で描きます。開始時点の Scene、出力サイズ、fps、進捗と中断の契約を維持します。Stage への Canvas 組み込みは UI 担当の範囲です。

### 確認方法

`pnpm exec vite --port 5176` を起動し、[専用ページ](http://localhost:5176/tests/e2e/fixtures/effects.html) で再生位置と Glow を切り替えます。保存ボタンは動画をエンコード・デコードし、Canvas と同じ時刻のフレームを並べて表示します。

```bash
pnpm typecheck
pnpm test
pnpm exec vite build --config tests/e2e/effects-build.config.ts
pnpm exec playwright test --config tests/e2e/effects.config.ts
pnpm exec playwright test --config tests/e2e/export.config.ts
```

本番ビルドの専用ページを検証する場合は `EFFECTS_PREVIEW=1` を設定します。比較画像・保存動画・JSON レポートは `test-results/effects/` に出力します。WebGL2 の実行、対象だけの Glow、日本語と数式の Write、変形、context lost、中断と資源解放、MP4 / WebM の復号フレームを確認します。

### 描画時間

2026-09-15、Windows / Chrome 152.0.7977.84（headless）、Intel UHD Graphics（ANGLE / Direct3D 11）、実際の `webgl2` 経路で測定しました。1280×720、図形・数式16個、8フレームのウォームアップ後に60フレームを計測しています。

| 内容 | 平均 | 中央値 | 95パーセンタイル |
| --- | ---: | ---: | ---: |
| 移動・回転・数式4個の Write | 48.56 ms | 50.40 ms | 61.70 ms |
| 移動・回転（画像を再利用） | 0.58 ms | 0.50 ms | 0.90 ms |

値は `await painter.render(...)` の所要時間です。Write を含む結果は約20.6fps相当で、30fpsの目標は未達です。Write では字形が毎フレーム変わるため、SVG 画像の読み込みと GPU への転送が必要になります。移動・回転だけの場合は画像を再利用でき、この差が小さくなります。画面の実際のリフレッシュレートを測った値ではありません。
