# Poietra

**友人と、AI と。動きを一緒につくる。**

Poietra は、同じ URL を開いたメンバーがリアルタイムで共同編集できる、ブラウザの動画編集環境です。
図形・文字・数式・画像・動画素材を配置し、独立した音声トラックと組み合わせて動画を書き出せます。
共有チャットで `@codex` に編集を頼んだ後も、位置や色、動きのタイミングを人間が調整できます。

**[ブラウザで使う →](https://poietra.com)**

![Poietra の編集画面。ベジェ曲線と AI が生成した星をキャンバスに配置し、右側の共有チャットで編集案を適用している。](docs/assets/studio.png)

2026-09-15 の OpenAI ハッカソンで開発したプロトタイプです。実装済みの機能と使い方を以下にまとめています。

## できること

- **同じ制作物を一緒に編集** — URL で参加し、配置・動き・素材・チャットを共有。再接続時にも編集を同期します。
- **オブジェクトごとにアニメーション** — 図形、テキスト、LaTeX 数式、ベジェ曲線、矢印、数直線、画像を扱えます。
- **属性ごとに時間を調整** — 位置を 2 秒で移動し、透明度だけ最初の 0.3 秒で変えるなど、開始・長さ・イージングを分けられます。
- **任意ログインと自分の一覧** — Google / GitHub の認証設定後に利用できます。ログイン中に開いたプロジェクトを自分の一覧に残し、共有リンクからはゲストも参加できます。
- **チャットから AI に依頼** — `@codex` でオブジェクトの作成、配置や動きの変更、次の場面の追加、画像生成を頼めます。
- **細部を手で調整** — 複数選択、整列、グループ、レイヤー操作、ベジェの移動パス、開始時刻・長さ・イージングを編集できます。
- **音声・動画素材を取り込み** — 動画をキャンバスに配置し、音声は波形付きの専用トラックでトリミング・音量調整できます。
- **ブラウザで動画を書き出し** — 全 Scene または現在の Scene を MP4 / WebM に出力できます。

## はじめて使う

1. [Poietra のトップページ](https://poietra.com)を開く。
2. **New project（新しいプロジェクト）** から、空のキャンバスと新しい部屋を作ります。編集画面でも一番左上の **Poietra ロゴ → New project** から作れます。
3. **Share → Copy link** で URL を送り、別の PC やブラウザから参加します。
4. オブジェクトを配置し、下部の Composition と Transition で動きを組みます。
5. **Preview** で全体を確認し、**Export** から動画を保存します。

例から始める場合はトップページの **Edit the example（サンプルを編集）**、または編集画面の Poietra ロゴから **Try the example**（ベジェ曲線と数式）か **Follow the gradient**（微分と連鎖律）を選んでください。例も新しい部屋で開き、自由に編集できます。

トップページの **Open previous project（前のプロジェクトを開く）** は、このブラウザで最後に開いた部屋を再開します。[スタジオへの直接入口](https://poietra.com/studio)も利用できます。従来の `/?room=...` という共有 URL は、そのまま編集画面を開きます。トップページを見ただけでは部屋を作成せず、共同編集に接続しません。

トップページは[英語](https://poietra.com/?lang=en)と[日本語](https://poietra.com/?lang=ja)に対応しています。ブラウザの優先言語から表示を選び、対応言語がない場合は英語になります。優先順位は URL の `lang` 指定 → 以前に保存した選択 → ブラウザの優先言語 → 英語です。編集画面と共有プロジェクトの内容は、この切り替えの対象には含みません。

リンクを知っている人は、ログインせずに編集できます。Poietra ロゴのメニューから任意でログインすると、開いたプロジェクトが本人用の **My projects** に残ります。一覧から外しても共有リンクは残ります。Google と GitHub は現在は別アカウントで、相互の紐づけや閲覧専用権限はありません。共同編集の表示名は Share から変更できます。

ログインボタンは、運用者が各サービスの OAuth 認証を設定すると表示されます。未設定でも、ゲストの制作・共同編集・書き出しは利用できます。

以前の `workers.dev` の共有リンクも利用できます。既存の部屋を `poietra.com` で開く場合は、URL の `?room=...` を残してホスト名だけ変更してください。ブラウザ内の履歴・未同期の編集はドメインごとに保存されるため、旧ドメインで同期が完了してから移動します。

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
- **Property timing** で属性を選んで値を変更すると、その属性だけの開始・長さ・イージングを設定できます。例えば Transition を `2,000 ms` にして Position を `2,000 ms`、Opacity を `300 ms` に設定します。透明度の変化自体は前後の Composition の Opacity で指定します。設定済みの属性は Timeline の子行にも表示され、バーをドラッグして調整できます。**共通の時間に戻す** で全体の設定へ戻ります。
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

### 音声・動画素材

**Add media** またはタイムラインの **音声を追加 / 動画を追加** から素材を読み込みます。キャンバスへのドロップにも対応しています。
MP4・WebM の動画と、MP3・WAV・OGG・FLAC・M4A・WebM の音声を扱えます。コンテナ内のコーデックはブラウザの対応範囲によります。

- **動画**はキャンバス上のオブジェクトとして配置・サイズ・見た目を編集できます。
- **音声**は Composition をまたぐ独立トラックに配置します。動画に含まれる音声も別トラックとして追加されます。
- 下部の **Audio & video** に波形・サムネイル・再生位置を表示します。クリップをドラッグすると移動、両端をドラッグするとトリミングできます。
- クリップを選ぶと、開始位置・素材のトリム開始・長さを数値でも編集できます。音声は音量・ミュート・削除にも対応し、動画と音声のタイミングを独立して調整できます。
- プレビューと書き出しに音声を反映します。素材が最後の Composition より長い場合は Scene の再生時間も延びます。

素材は部屋に保存され、共同制作者も同じ URL から利用できます。プロジェクトファイルには素材本体を含めて保存します。
読み込み・波形作成・アップロードの進捗を表示し、中止や失敗もその場で確認できます。キャンバスとアニメーショントラックでは、選択候補・ロック・ドラッグ中の値・操作完了を表示します。

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

**Poietra ロゴ → Save project** で、素材を含む `.poietra.json` を保存できます。
**Open project** は新しい部屋へ読み込むため、元の共同編集プロジェクトを上書きしません。チャット履歴はプロジェクトファイルに含みません。

**Export** では範囲・形式・解像度・フレームレートを選びます。

| 項目 | 選択肢 |
| --- | --- |
| 範囲 | Entire project / Current scene |
| 形式 | MP4（H.264）/ WebM（VP9、非対応時は VP8） |
| 解像度 | 原寸 / 720p / 1080p |
| フレームレート | 24 / 30 / 60 fps |

利用できるコーデックはブラウザと端末に依存します。音声付き MP4 には AAC エンコーダーが必要です。非対応の場合はエラーを表示するので、WebM（Opus 音声）を選んでください。書き出しは開始時の編集状態を使い、処理中の共同編集に影響されません。Cancel で中断、完了後の **Download again** で再ダウンロードできます。

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

### Google / GitHub の任意ログインを設定する

両方に対応していますが、片方だけの設定でも動作します。各サービスで OAuth アプリを登録し、Client ID と Client secret をサーバー側だけに保存します。Google は Web application、GitHub は OAuth App を使います。

| サービス | 本番で登録するコールバック URL | 設定する変数 |
| --- | --- | --- |
| Google | `https://poietra.com/api/auth/callback/google` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| GitHub | `https://poietra.com/api/auth/callback/github` | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |

手順は [Google の Web サーバー向け OAuth ガイド](https://developers.google.com/identity/protocols/oauth2/web-server)と [GitHub の OAuth App 登録ガイド](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)を参照してください。必要な情報は本人の識別とプロフィールだけで、リポジトリへの権限やメールアドレスは求めません。

ローカル Node は `.env`、ローカル Worker は `.dev.vars` に保存します。`AUTH_ORIGIN` とブラウザの URL、登録したコールバックのホスト・ポートを一致させてください。例はそれぞれ `http://localhost:5173` / `http://localhost:8787` です。本番用と開発用の OAuth アプリを分けると設定が混ざりません。

Cloudflare 本番では、以下を対話入力で登録します。秘密の値をリポジトリやチャットに貼らないでください。

```bash
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
```

本番の `AUTH_ORIGIN` は `https://poietra.com` です。旧 `workers.dev` ドメインではゲスト編集を継続できます。ログイン用セッションと本人用の一覧は共有ドキュメントの外に保存し、セッションは 7 日で期限切れになります。Google と GitHub は、メールアドレスなどによる自動統合をしません。

認証・一覧 API と Node HTTP のテストは `pnpm exec vitest run tests/auth.test.ts tests/auth-node.test.ts`、実 Worker の保存・再起動・セッション失効は `node tests/accounts-worker.integration.mjs` で確認します。これらは外部プロバイダーの応答をテスト用に置き換えており、設定した実アカウントでのログイン確認は別です。

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

共有環境は Cloudflare Workers に配置しています。UI・WASM・フォントを Static Assets、共同編集と素材保存を部屋ごとの SQLite Durable Object で扱います。
公開ドメインは **https://poietra.com** です。`wrangler.jsonc` の Custom Domain 設定で既存 Worker に接続し、新旧 URL で同じ部屋と素材を共有します。

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

### 共同編集と描画を長く使える構成へ（2026-09-16）

別々の対象を編集しても値が戻るという報告から、Transition の長さ変更が、変更不要な各オブジェクトの時間まで書き直す競合を再現しました。変更していない値の書き込みを省き、相手の変更を競合へ巻き込まないようにしています。同じプロパティを二人が同時変更する場合の意図の調停は、別の課題として残ります。また、同じ Bézier の別ハンドルを同時編集すると path 全体の置換で一方が戻る問題を [Issue #39](https://github.com/Poietra/poietra-hackathon/issues/39) で追跡しています。

また、カーソル・選択の更新では描画済みのフレームと SVG を再利用します。図形・素材・時刻・描画準備の更新は再描画します。カーソル更新だけで Canvas の描画が増えないことと、実際の編集が反映されることをブラウザテストで確認します。編集操作が参照するプロジェクトも、完了済みの更新なら同じ snapshot を再利用し、ドラッグ 1 更新での全体読み直しを 3 回から 1 回へ減らしています。更新処理の途中では最新データを直接読み、古い値を使い回しません。

次の改善は以下の順で進める方針です。**以下の分離は今後の実装対象**です。

| 優先 | 分離する責務 | 完了を判断する検証 |
| --- | --- | --- |
| 1 | **編集データと購読**。Yjs の変更から必要な Scene / オブジェクトだけ更新し、在室者・カーソル・接続状態は別の購読にする。 | 別 Scene の編集やカーソル移動で、現在の Scene の再構築・再描画が増えない。削除・Undo・オフライン再接続でも両者の変更を保持する。 |
| 2 | **再生時計と編集 UI**。時刻の更新を専用スケジューラーが評価器と描画器へ渡し、サイドバーや Inspector の更新周期から独立させる。 | 再生中の不要な UI 更新を減らし、シーク・中断・Scene 切替後に古いフレームを出さない。 |
| 3 | **素材のデコードと描画**。動画の PNG 化・SVG 経由の再デコードを減らし、デコード済みフレームを直接描画する。Canvas 用の当たり判定も SVG 全体の差し替えから分離する。順再生とランダムシークを分け、使用量に上限のあるキャッシュと解放責任を持たせる。 | 音声同期・トリミング・Write / Glow・書き出しを維持し、反復再生や素材交換でメモリ使用量が増え続けない。 |

購読側は、変更がない間は同じ immutable snapshot を返す [React の外部ストア契約](https://react.dev/reference/react/useSyncExternalStore) に従います。描画へ直接渡す動画フレームは、所有者と利用終了のタイミングを明確にし、[使用済みフレームの資源を解放](https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame/close)します。

初期調査では、720p 動画の 1 フレームあたり PNG 化が平均約 15 ms、その後の SVG レイヤー再生成が約 27 ms でした。Headless Chromium / SwiftShader、20 フレームの部品計測であり、実機の再生 fps や本番環境の応答時間ではありません。通常図形では既存のレイヤーキャッシュが機能しており、数値補間よりも SVG の DOM 差し替えが重いケースを確認しました。

継続計測では同じ端末・同じ素材を使い、2 / 4 人、100 / 500 オブジェクト、音声付き 720p 動画で、入力から表示までの遅延・相手への反映時間・フレーム時間の p95・送信量・反復再生後のメモリを記録します。CRDT や描画方式の全面変更、Worker / OffscreenCanvas への移動は、この計測と正しさの回帰テストを基に判断します。

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
node tests/media-storage.integration.mjs  # Node/Worker の素材保存・容量制限・再起動
pnpm exec playwright test --config tests/e2e/media-export.config.ts  # 動画フレーム・音声付き出力・同期再生
```

描画の部品計測は通常のテストと分けて実行します。`pnpm dev` を起動し、他のテスト・ビルドを止めてから次を実行してください。生成した短い動画は終了時に削除します。

```bash
node scripts/benchmark-rendering.mjs --url http://127.0.0.1:5173 --output test-results/benchmarks/rendering.json
# 動画用の FFmpeg がない場合: --skip-video
pnpm exec playwright test painter-preview.spec.ts  # カーソル更新時の再描画、遅延・失敗・切替
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
- 画像の画素編集とユーザー持ち込みシェーダーには対応していません。
- 画像は一度に 8 枚まで。元画像は 20 MiB・4,000 万画素までで、追加時に長辺 2,048 px・1 MiB 以下へ整えます。部屋の画像保存は計 64 MiB、読み込むプロジェクトファイルは 128 MiB までです。Undo などの参照を保つため、保存済み画像は自動削除しません。
- 音声・動画素材は 1 ファイル 32 MiB・10 分以内、部屋あたり計 128 MiB までです。動画と音声のタイミングは独立しており、一方を動かしても他方は移動しません。
- AI は現在の Scene 内を編集します。1 提案での Composition 追加は末尾へ 4 個まで、画像生成は 2 枚までです。Scene 新設や既存 Composition 間への挿入は未対応です。API 処理には期限がありますが、画像保存の待機は期限の対象外です。
- Glow は WebGL2 を使い、利用できない場合は SVG / Canvas2D に戻ります。初回の描画待ちや端末ごとの性能差は継続改善中です。

不具合や未完了の作業は [Issues](https://github.com/Poietra/poietra-hackathon/issues) で管理しています。
