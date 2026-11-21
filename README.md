# Agent P セットアップ

構成: `index.html`（画面）→ `worker.js`（Cloudflare Worker：キー・モデル設定・ツール・API）→ Groq / OpenRouter / Tavily など

## 1. Workerをデプロイ

```bash
npm i -g wrangler
wrangler login
npx wrangler kv namespace create KV        # 表示された id を wrangler.toml に貼る
npx wrangler secret put GROQ_KEY
npx wrangler secret put OPENROUTER_KEY
npx wrangler secret put TAVILY_KEY
npx wrangler deploy
```

ダッシュボードで作る場合は、Workerのコードを `worker.js` で置き換え、
Settings → Bindings で **KV（変数名 KV）** と **Workers AI（変数名 AI）** を追加、
Settings → Variables and Secrets で上記キーを **Secret** として登録します。

## 2. worker.js の先頭を編集

- `ALLOWED_ORIGINS` … 公開するHTMLのURL（例: `https://example.com`）。公開時は `'null'` を削除
- `WIKI_UA` … 連絡先入りのUser-Agent（**ASCIIのみ**。日本語を入れるとWikipedia取得でエラー）
- `LIMITS` … 1日のTavily回数、ツール回数上限などを調整

## 3. index.html を編集

- `API_BASE` をWorkerのURL（`https://agent-p-proxy.○○.workers.dev`）に変更

## 4. 公開API（Agent P API）

`AGENTP_API_KEYS` に自分で決めた長いランダム文字列を登録すると有効になります。

```bash
# モデル一覧
curl https://agent-p-proxy.○○.workers.dev/v1/models \
  -H "Authorization: Bearer YOUR_AGENTP_KEY"

# チャット（OpenAI互換。nova は検索などのツールを自動で使う）
curl https://agent-p-proxy.○○.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_AGENTP_KEY" -H "Content-Type: application/json" \
  -d '{"model":"nova","messages":[{"role":"user","content":"今日の東京の天気と、12*34を教えて"}]}'

# ストリーミング: "stream": true  / ツールを使わせない: "agent": false
```

レスポンスの `agent_p.sources` に出典、`agent_p.tools` に使ったツールが入ります。
OpenAI SDKは `base_url` を `https://agent-p-proxy.○○.workers.dev/v1` にすれば使えます。

## 5. 無料枠の注意

- KV無料枠は書き込み1,000回/日。1回の会話で数回消費するので、個人利用向けの設計です
- Tavilyは `LIMITS.tavilyPerDay`（既定30回/日）と `tavilyPerMonth`（既定950回/月）で自動停止します
- 画像認識は `VISION_MODEL` のモデルIDが現在も有効か、Groqのモデル一覧で確認してください
