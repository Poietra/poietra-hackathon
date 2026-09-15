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

Composition の ＋ は、最後の Composition の配置・内容・非表示状態を引き継ぎます。同じオブジェクトの各場面を独立して編集できます。テキスト・数式は追加すると内容欄に移り、既存のものはダブルクリックで再編集できます。文字の隙間もドラッグでき、Transition 下部の目盛り・再生ヘッドから時間を操作できます。

空白をドラッグすると範囲選択、Shift を押しながらドラッグ・クリックすると追加選択できます。Group／Ungroup で連結し、メンバーをドラッグすると表示中・未ロックのメンバーが一緒に動きます。Transition では複数対象の Move・開始・長さ・Easing をまとめて設定し、各メンバーの移動パスを保持します。

Composition のメニューから状態を複製・削除できます。同時に最後の状態を削除した場合も、全員が同じ1つの状態を保持します。取り消しで他の人の編集は戻りません。オブジェクトは `Ctrl/Cmd+C`・`Ctrl/Cmd+V` で別の Composition やプロジェクトへコピーでき、`Ctrl/Cmd+Shift+V` で元の位置に貼り付けます。切り取りは `Ctrl/Cmd+X`、`Delete` / `Backspace` は選択中の Composition から非表示にします。`Ctrl/Cmd+Z` で取り消し、`Ctrl/Cmd+Shift+Z` でやり直します。文字入力・日本語の変換中は入力操作を優先します。新しく追加したアニメーションについて、同期済みの共同編集者の変更を検知した場合は、その追加をUndoしてもトラック全体を保持し、画面に通知します。同時に変更した既存トラックは通常どおり取り消します。矢印キーは1 px、Shiftと組み合わせると10 px移動します。数式の LaTeX 入力では `\` に続けて文字を打つと候補を表示し、↑↓ で選んで Tab か Enter で確定、Esc で閉じます。`\frac{}{}` のような雛形は最初の `{}` にカーソルを置きます。

上部の Scene メニューでは名前変更・複製・削除ができます。複製した Scene のオブジェクトとアニメーションは独立して編集できます。Scene の同時削除でも1つを保持し、Undo は共同制作者の変更を残します。

全体プレビューからは **この場面を編集** または `Esc` で再生位置の Composition／Transition を開きます。プレビュー中は、表示と異なる場面へのプロパティ編集・削除を防ぎます。上部の接続状態から、同期の進み具合とブラウザ内の保存状況を確認し、必要な場合に再接続できます。

Export は原寸・720p・1080pに対応し、開始時の Scene・設定・ファイル名を保持します。閉じる／Cancelで処理を中断し、完了後の **Download again** は同じ動画を再保存します。

Assistant は選択中のオブジェクト・Composition・Transition を対象に編集案を作ります。移動パスや図形のベジェ制御点も変更でき、Apply前に対象の位置や構造が変わった場合は提案を作り直します。

## デモの流れ

1. Share の URL を別の PC でも開き、円の位置や色を変更して同期を確認する。
2. Composition 2 を選び、同じ円の別の配置を調整する。
3. Transition を選び、Move と Equation の Write を別々に調整する。円を選び `Edit Bézier path` で移動経路を曲げる。
4. Preview で動きを確認する。AI 接続済みの場合は Assistant に変更を頼み、編集案を Apply する。
5. Export で MP4 または WebM を書き出す。Chrome / Edge を使用する。

検証では、別ブラウザ間の共同編集・オフライン編集の合流・取り消し、実 workerd の強制休止と再起動後の復元、キャンバス・タイムライン・ロック・レイヤー順・ファイル読み込みを確認します。AI は API を代替したテストで提案の競合、キャンセル、再試行を検証しています。共有環境の実 OpenAI API でも、選択した円の色やベジェ移動パスを変更する提案から Apply・別ブラウザへの同期・共同編集者の別プロパティ変更を保持した Undo まで確認済みです。

`pnpm test:e2e` はローカルの専用ページで描画の待ち合わせ・中断・SVGへの復帰と書き出しダイアログの遅延応答も確認します。`POIETRA_TEST_URL` を指定した場合は、公開アプリで実行できる編集操作のテストを対象にします。

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
- **数式の Write**: MathJax の字形パス・長さ・変形を一度準備し、Canvas の `Path2D` で描きます。完成した字形と描画途中の字形は同じパスを使い、進行度から輪郭と塗りを毎フレーム計算します。TeX が同じなら、色・文字サイズ・線幅・出力サイズの変更でも準備を再利用します。対応する形状は `g`・`path`・角丸のない `rect`。未対応の形状は数式単位で既存の SVG 画像に戻します。
- **再利用と解放**: 位置・回転・不透明度だけの変化では画像を再利用します。`LayerCache` が painter ごとの画像と数式パス、作業 Canvas 1枚を所有し、削除・退避した項目のパスと画像を解放します。作業 Canvas は SVG 経路への切り替えと `dispose()` で解放します。保持画像の RGBA 容量と数式ソースの UTF-16 容量の合計は 32 MiB まで。Path2D の内部メモリは計測できないため、数式1件を 2,048 字形・ソース 1 MiB までに制限します。この予算には作業 Canvas と GPU のメモリを含みません。Object URL は画像読み込み処理、GPU 資源は Glow renderer が所有します。
- **継続動作**: 出力 Canvas は 2D、WebGL2 は内部 Canvas で使います。WebGL2 非対応・context lost・GPU の描画失敗・大きすぎる画像では、既存 SVG と Canvas 2D に切り替えます。`backend` は現在の経路を返します。画像読み込みの失敗は呼び出し側へ返し、中断は `AbortError` になります。
- **プレビューと動画**: 編集画面と MP4 / WebM の各フレームを同じ painter で描きます。プレビューは描画中の待機フレームを最新1枚にまとめ、描画済みの状態に選択判定を合わせます。動画は全フレームを描き、開始時点の Scene、出力サイズ、fps、進捗と中断の契約を維持します。

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

### Write の回帰テストと計測

```bash
pnpm exec vite build --config tests/e2e/effects-write-build.config.ts
pnpm exec playwright test --config tests/e2e/effects-write.config.ts
```

字形ごとの Together / Sequential、順方向・逆方向・近接時刻へのシーク、同じ ID の編集、出力サイズ変更、中断・解放、SVG への退避を確認します。キャッシュを使う画像を新しい painter と比較し、数式の輪郭を元の SVG 描画とも照合します。結果は `test-results/issue-5/regression/` に保存します。

性能測定は他のブラウザ処理を止め、`RUN_WRITE_BENCHMARK=1` と `WRITE_RESULTS_DIR=../../test-results/issue-5/after` を設定して同じテストを実行します。`BENCHMARK_REVISION` に対象のコミットを指定すると JSON に記録します。画像の読み込み数と GPU 転送数はブラウザ API の呼び出しを数えた値で、ブラウザ内部のデコード回数ではありません。

### 描画時間

2026-09-15、Windows / Chrome 152.0.7977.84（headless）、Intel UHD Graphics（ANGLE / Direct3D 11）、本番ビルドの `webgl2` 経路で変更前後を同じ手順で測定しました。変更前は `3adfa78`、変更後は Issue #5 の数式パス再利用を適用したものです。1280×720、図形・数式16個、8フレームのウォームアップ後に60フレームを計測しています。

| 内容 | 平均（前 → 後） | 中央値（前 → 後） | 95パーセンタイル（前 → 後） |
| --- | ---: | ---: | ---: |
| 移動・回転・数式4個の Write | 37.27 → 19.27 ms | 35.10 → 19.30 ms | 59.50 → 25.00 ms |
| 移動・回転（画像を再利用） | 0.52 → 0.46 ms | 0.50 → 0.40 ms | 1.20 → 0.70 ms |

Write の平均は目標の 33.3 ms を下回りました。60フレーム中の SVG 画像要求は 232 → 0 回、GPU 転送は 232 → 232 回です。変化する字形を Glow に渡す転送は残し、SVG 画像を作り直す処理を省いた結果です。

`makeCalculusProject()` は25オブジェクト・13.3秒。冒頭の静止状態で8回ウォームアップし、30fpsの全399フレームを時刻順に計測しました。遷移で初めて現れる字形の準備時間も含みます。

| 範囲 | 平均（前 → 後） | 中央値（前 → 後） | 95パーセンタイル（前 → 後） |
| --- | ---: | ---: | ---: |
| 全体 | 11.74 → 6.82 ms | 0.40 → 0.90 ms | 56.40 → 32.00 ms |
| 最も重い区間 `reveal-loss`（2.6–4.4秒、54フレーム） | 41.15 → 26.83 ms | 41.30 → 26.40 ms | 65.00 → 48.40 ms |
| `trace-gradient`（7.2–9.3秒、63フレーム） | 36.20 → 16.49 ms | 36.80 → 16.40 ms | 73.80 → 28.50 ms |

Calculus 全体の SVG 画像要求は 386 → 219 回、GPU 転送は 1 → 1 回。図形・テキストを含む SVG 画像の処理が残り、最も重い区間の95パーセンタイルはまだ 33.3 ms を超えています。

値は `await painter.render(...)` の所要時間で、フレーム評価・事前の `prepareScene`・表示更新の待機・GPU 完了待機は含みません。実際の再生 fps や全端末での30fpsを保証する値ではありません。以前の Write 計測は 48.56 ms でしたが、実行条件による変動があるため、上表には今回同じ手順で取り直した値を用いています。
