# Poietra

**友人と、AI と。動きを一緒につくる。**

Poietra は、同じ URL を開いたメンバーがリアルタイムで共同編集できる、ブラウザの動画編集環境です。
図形・文字・数式・画像を配置し、オブジェクトごとに動きを付け、動画として書き出せます。
共有チャットで `@codex` に編集を頼んだ後も、位置や色、動きのタイミングを人間が調整できます。

**[ブラウザで使う →](https://poietra-hackathon.yumaboda-official.workers.dev)**

![Poietra の編集画面。ベジェ曲線と AI が生成した星をキャンバスに配置し、右側の共有チャットで編集案を適用している。](docs/assets/studio.png)

2026-09-15 の OpenAI ハッカソンで開発したプロトタイプです。実装済みの機能と使い方を以下にまとめています。

## できること

- **同じ制作物を一緒に編集** — URL で参加し、配置・動き・素材・チャットを共有。再接続時にも編集を同期します。
- **オブジェクトごとにアニメーション** — 図形、テキスト、LaTeX 数式、ベジェ曲線、矢印、数直線、画像を扱えます。
- **チャットから AI に依頼** — `@codex` でオブジェクトの作成、配置や動きの変更、次の場面の追加、画像生成を頼めます。
- **細部を手で調整** — 複数選択、整列、グループ、レイヤー操作、ベジェの移動パス、開始時刻・長さ・イージングを編集できます。
- **ブラウザで動画を書き出し** — 全 Scene または現在の Scene を MP4 / WebM に出力できます。

## はじめて使う

1. [Poietra を開く](https://poietra-hackathon.yumaboda-official.workers.dev)。
2. 左上の **P → New project** で、空のプロジェクトと新しい部屋を作ります。
3. **Share → Copy link** で URL を送り、別の PC やブラウザから参加します。
4. オブジェクトを配置し、下部の Composition と Transition で動きを組みます。
5. **Preview** で全体を確認し、**Export** から動画を保存します。

例から始める場合は、P メニューの **Try the example**（ベジェ曲線と数式）か **Follow the gradient**（微分と連鎖律）を選んでください。例も新しい部屋で開き、自由に編集できます。

リンクを知っている人は編集できます。アカウント登録や閲覧専用の権限はありません。表示名は Share から変更できます。

### Scene・Composition・Transition

| 用語 | 役割 |
| --- | --- |
| **Scene** | 独立したキャンバスと、その中の場面・動きのまとまり。動画では Scene の並び順に再生します。 |
| **Composition** | オブジェクトの配置や見た目を決めた静止状態。継続時間の間、その状態を保ちます。 |
| **Transition** | 隣り合う Composition の間の変化。オブジェクトごとにアニメーションを設定します。 |

例えば「円が左にある Composition → 円を動かす Transition → 円が右にある Composition」で、移動を作れます。
同じオブジェクトでも、位置・色・大きさ・表示の有無は Composition ごとに設定できます。

- Composition の **＋** は、最後の状態を複製して次の場面を追加します。
- Transition では **Move / Write / Fade / Grow / Cut** と、開始時刻・長さ・イージングを設定できます。
- Move の **Edit Bézier path** から、曲線の移動パスを編集できます。
- Scene は追加・複製・名前変更・削除・並べ替えに対応しています。

### 編集と画像素材

キャンバスのツールからオブジェクトを追加し、右側の **Design** でプロパティを調整します。
空白のドラッグで範囲選択、Shift で追加選択、Group / Ungroup で連結できます。連結したメンバーをドラッグすると、表示中・未ロックのメンバーも一緒に動きます。
テキストと数式はダブルクリックで内容を編集できます。

画像は **Add image**、ドロップ、クリップボードからの貼り付けで追加します。PNG・JPEG・WebP に対応し、透明部分を保持します。
角のドラッグで縦横比を保って拡大縮小し、Shift を押すと比率を変えられます。画像にも回転・不透明度・枠線・角丸・Glow やアニメーションを設定できます。

| 操作 | ショートカット |
| --- | --- |
| 元に戻す / やり直す | Ctrl/⌘ + Z / Ctrl/⌘ + Shift + Z |
| コピー / 貼り付け / 切り取り | Ctrl/⌘ + C / V / X |
| 元の位置に貼り付け | Ctrl/⌘ + Shift + V |
| 現在の Composition から非表示にする | Delete / Backspace |
| 1 px 移動 / 10 px 移動 | 矢印キー / Shift + 矢印キー |

### 共有チャットと `@codex`

右側の **Chat** は部屋のメンバー全員に共有されます。通常のメッセージは人間同士の会話になり、`@codex` を付けると AI に依頼できます。

```text
@codex 選択した円を黄色にして
@codex 次の場面を追加して、円をベジェ曲線で右上へ動かして
@codex 数式を次の場面に追加して、Write で登場させて
@codex 透明背景の黄色い星のイラストを生成して右上に置いて
```

- **Enter** で送信し、返ってきた編集案を依頼者が **Apply edits** で適用します。
- **Ctrl/⌘ + Enter** で送ると、検証を通った編集案を自動で適用します。
- **Shift + Enter** で改行できます。
- 提案・返答・適用状況も共有されます。適用した編集は Undo で戻せます。

選択中のオブジェクトは依頼の文脈になります。同じ Scene 内なら、別の Composition や Transition を明示して編集を頼むこともできます。
適用前には対象の変更・削除やロックを再確認し、古くなった提案の適用を防ぎます。

生成画像は、編集案を返す前に生成・保存されます。Apply はキャンバスへの追加を行い、Undo は編集を取り消します。生成済みの画像保存や API 利用は取り消されません。
画像は配置や動きを編集できるオブジェクトとして扱い、画素そのものの編集には対応していません。

### 保存・再接続・動画書き出し

編集内容はサーバーとブラウザ内に保存され、再接続時に同期されます。再生位置と選択は各自で操作できます。
Undo は自分の操作を対象とし、共同制作者が変更した新規オブジェクトなどは保持する場合があります。未同期の変更は検知できないため、接続が切れた場合は再接続してから取り消してください。

**P → Save project** で、画像を含む `.poietra.json` を保存できます。
**Open project** は新しい部屋へ読み込むため、元の共同編集プロジェクトを上書きしません。チャット履歴はプロジェクトファイルに含みません。

**Export** では範囲・形式・解像度・フレームレートを選びます。

| 項目 | 選択肢 |
| --- | --- |
| 範囲 | Entire project / Current scene |
| 形式 | MP4（H.264）/ WebM（VP9、非対応時は VP8） |
| 解像度 | 原寸 / 720p / 1080p |
| フレームレート | 24 / 30 / 60 fps |

利用できるコーデックはブラウザと端末に依存します。書き出しは開始時の編集状態を使い、処理中の共同編集に影響されません。Cancel で中断、完了後の **Download again** で再ダウンロードできます。

## ローカルで開発する

必要なものは **Node.js 24 以上**と **pnpm 10** です。WASM を同梱しているため、通常の UI 開発に Rust は不要です。

```bash
git clone https://github.com/Poietra/poietra-hackathon.git
cd poietra-hackathon
pnpm install
pnpm dev
```

[localhost:5173](http://localhost:5173) を開きます。Node.js サーバーが UI・API・共同編集を提供し、データは既定で `.data/` に保存します。

### AI を有効にする

```bash
cp .env.example .env
```

`.env` に `OPENAI_API_KEY` を設定してサーバーを起動します。キーはサーバー側でのみ使います。キーがなくても、通常の編集・人間同士のチャット・動画書き出しは使えます。

| 環境変数 | リポジトリの初期設定 | 用途 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 未設定 | 編集提案と画像生成に使うキー |
| `OPENAI_MODEL` | `gpt-6-astra` | 構造化された編集案の生成 |
| `OPENAI_IMAGE_MODEL` | `gpt-image-1` | 画像素材の生成 |
| `OPENAI_IMAGE_QUALITY` | `medium` | 画像品質。`low` / `medium` / `high` |
| `OPENAI_REASONING_EFFORT` | `medium` | 文章モデルの推論量。`none` / `minimal` / `low` / `medium` / `high`。`default` で送らない |
| `OPENAI_SERVICE_TIER` | `fast` | 処理の優先度。`fast` / `ultrafast` / `priority` / `flex`。`default` で送らない。モデルや契約が未対応の場合は自動で外して再送します |
| `PORT` | `5173` | Node.js サーバーのポート |
| `POIETRA_DATA_DIR` | `.data` | Node.js サーバーの保存先 |

### ビルドと Rust コア

```bash
pnpm build:web  # 型検査と UI ビルド。同梱 WASM を使用
pnpm start     # ビルド済み UI を Node.js サーバーで配信
```

Rust コアを変更する場合は、Rust ツールチェーンを用意して次を実行します。

```bash
rustup target add wasm32-unknown-unknown
pnpm build:wasm
pnpm test:core
```

`pnpm build` は WASM の再ビルド・型検査・UI ビルドをまとめて実行します。

## Cloudflare で動かす

共有環境は Cloudflare Workers に配置しています。UI・WASM・フォントを Static Assets、共同編集と画像保存を部屋ごとの SQLite Durable Object で扱います。

### ローカルの Worker

```bash
cp .dev.vars.example .dev.vars
# AI を使う場合は .dev.vars に OPENAI_API_KEY を設定
pnpm build:web
pnpm dev:worker
```

[localhost:8787](http://localhost:8787) を開きます。モデル・品質の初期設定は [wrangler.jsonc](wrangler.jsonc) にあります。

### デプロイ

`wrangler.jsonc` の `account_id` は現在の Yumaboda アカウントを指定しています。自分の環境へ配置する場合は、自分のアカウント ID と必要に応じて Worker 名へ変更してください。

```bash
pnpm exec wrangler login
pnpm run deploy
# AI を使う場合のみ、対話入力でキーを登録
pnpm exec wrangler secret put OPENAI_API_KEY
```

`pnpm run deploy` は UI をビルドして Worker を配置します。Rust コアを変更した場合は先に `pnpm build:wasm` を実行してください。

## 構成

UI と独立した編集データ・時間評価・描画を持ち、人間の操作と AI の編集案を同じデータへ反映します。

| 場所 | 役割 |
| --- | --- |
| [shared/](shared/) | プロジェクトモデル、Yjs の同期データ、AI・チャットのスキーマ |
| [core/](core/) | Rust / WASM による補間・ベジェ計算 |
| [src/editor/](src/editor/) | 編集操作、Undo、共同編集、プロジェクトと素材の管理 |
| [src/ui/](src/ui/) | React の編集 UI、タイムライン、プロパティ、チャット |
| [src/engine/](src/engine/) | 時刻からの状態評価、MathJax 数式、SVG / Canvas 描画、WebGL2 Glow、WebCodecs 書き出し |
| [worker/](worker/) | Cloudflare の API、WebSocket 同期、SQLite への保存 |
| [server/](server/) | Node.js の開発サーバー、共通の OpenAI 呼び出しと画像処理 |
| [tests/](tests/) | 単体テスト、ブラウザ操作、共同編集の復元、動画出力の検証 |

## 検証

```bash
pnpm typecheck
pnpm exec vitest run --maxWorkers=2
pnpm test:core  # Rust が必要
```

ブラウザテストには Playwright の Chromium を用意します。`test:e2e` の動画検証には **FFmpeg / ffprobe**、専用の `test:export` には **Corepack** も必要です。

```bash
pnpm exec playwright install chromium
pnpm test:e2e            # 編集・チャット・画像・Scene 再生・動画出力
pnpm test:ai             # AI の提案・検証・適用・共同編集
pnpm test:export         # 専用ページでのエンコード・中断・資源解放
pnpm test:collaboration  # workerd の再起動・休止を含む同期と保存
node tests/image-worker.integration.mjs  # Worker の画像保存と復元
```

`test:e2e` と `test:ai` は Node.js サーバーを自動で起動します。既に起動した Worker に対しては、別ターミナルで次を実行します。

```bash
POIETRA_TEST_URL=http://127.0.0.1:8787 pnpm test:e2e
```

AI の自動テストは API 応答をスタブに置き換えるため、実 API の疎通確認とは別です。
2026-09-15 の公開環境では、実 API による編集提案と画像生成、別ブラウザへの同期、Apply と Undo まで確認しています。
描画性能の専用テストは [tests/e2e/](tests/e2e/) にあります。開発方針と判断理由は [AGENTS.md](AGENTS.md) を参照してください。

## 現在の制限

- デスクトップの Chrome / Edge を主な検証対象としています。短い動画向けのプロトタイプで、長時間・大量素材での動作は保証していません。
- 音声トラック、動画素材の読み込み、画像の画素編集、ユーザー持ち込みシェーダーには対応していません。
- 画像は一度に 8 枚まで。元画像は 20 MiB・4,000 万画素までで、追加時に長辺 2,048 px・1 MiB 以下へ整えます。部屋の画像保存は計 64 MiB、読み込むプロジェクトファイルは 32 MiB までです。Undo などの参照を保つため、保存済み画像は自動削除しません。
- AI は現在の Scene 内を編集します。1 提案での Composition 追加は末尾へ 4 個まで、画像生成は 2 枚までです。Scene 新設や既存 Composition 間への挿入は未対応です。API 処理には期限がありますが、画像保存の待機は期限の対象外です。
- Glow は WebGL2 を使い、利用できない場合は SVG / Canvas2D に戻ります。初回の描画待ちや端末ごとの性能差は継続改善中です。

不具合や未完了の作業は [Issues](https://github.com/Poietra/poietra-hackathon/issues) で管理しています。
