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

開発サーバーは `http://localhost:5173`。現在はデータモデル、WASM の動きの計算、同期サーバー、AI 接続の土台までで、画面・描画・書き出しを実装中です。

AI はサーバーの `OPENAI_API_KEY` を使います。設定例は [.env.example](.env.example)。実際のキーは `.env` に設定し、Git には含めません。

```bash
pnpm typecheck
pnpm test:core
```

## 実装の分担

- UI・操作・編集データ・共同編集・AI 接続・統合：Hosi121 / Codex
- 数式・図形の描画、Write、動画書き出し：furukawa1020

描画・書き出しの呼び出し口は [render-contract.ts](src/engine/render-contract.ts)、共通のモデルは [model.ts](shared/model.ts) に定義しています。
