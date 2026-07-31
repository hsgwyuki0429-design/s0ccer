# デプロイ

友達とオンラインで遊ぶには、**ゲームサーバーをどこかに常駐させる**必要がある。
クライアント（GitHub Pages）は静的ファイルなので、サーバーの機能は持てない。

```
[スマホ / PC] ──https──> GitHub Pages（クライアント）
      └────────wss──────> どこかのホスティング（ゲームサーバー）
```

## 全体の流れ

1. サーバーをどこかにデプロイして、`wss://...` の URL を得る
2. GitHub リポジトリの **Variables** に `SERVER_URL` としてその URL を設定する
3. Pages を再デプロイすると、以降は自動でそのサーバーに繋がる

**2 を設定しなければ、Pages はこれまでどおりオフライン（単独プレイ）で動く。**
サーバーを止めてもページが壊れることはない。

## 1. サーバーをデプロイする

リポジトリ直下の `Dockerfile` がそのまま使える。Node の型ストリッピングで
`.ts` を直接実行しているのでビルド手順はなく、本番の依存は `ws` ひとつだけ。

### 選択肢

| | 長所 | 短所 |
|---|---|---|
| **Fly.io** | 東京リージョンがある。WebSocket をそのまま流せる | CLI が要る。無料枠は要確認 |
| **Render** | ブラウザだけで完結する | 日本リージョンなし。無料プランは停止からの復帰に数十秒 |
| その他 | Docker が動けばどこでも | — |

**国内で遊ぶなら Fly.io の東京（nrt）を推す。** レイテンシがそのまま操作感に効くので、
リージョンの差は無視できない。

### Fly.io の場合

```bash
# 初回だけ
fly auth login
fly launch --no-deploy   # アプリ名を決める。fly.toml が上書きされたら app 名だけ直す

fly deploy
```

`fly.toml` は用意済み。要点は次のとおり。

- `primary_region = "nrt"` — 東京
- `auto_stop_machines = false` — ゲームサーバーなので勝手に止めない。止まると再接続まで数秒かかる
- `/health` をヘルスチェックに使う

デプロイ後の URL は `https://<アプリ名>.fly.dev`。**WebSocket の URL は
`wss://<アプリ名>.fly.dev`**（`https` を `wss` に読み替えるだけ）。

### Render の場合

1. Render のダッシュボードで **New → Blueprint**
2. このリポジトリを選ぶ。`render.yaml` が読まれる
3. デプロイ後の URL は `https://<サービス名>.onrender.com` → `wss://...` として使う

> 無料プランはアクセスが無いとインスタンスが停止する。遊ぶ直前に
> `https://<サービス名>.onrender.com/health` を一度開いて起こしておくとよい。

### 動作確認

```bash
curl https://<デプロイ先>/health
# {"ok":true,"rooms":0,"players":0,"parties":0}
```

## 2. Pages を繋ぐ

GitHub リポジトリの
**Settings → Secrets and variables → Actions → Variables タブ → New repository variable**

| Name | Value |
|---|---|
| `SERVER_URL` | `wss://<デプロイ先>` |

`Secrets` ではなく **`Variables`** に入れること。ビルド時にクライアントへ埋め込まれる
値なので秘密ではないし、Secrets はビルド出力に出せない。

## 3. 再デプロイ

Variables はビルド時に読まれるので、設定しただけでは反映されない。
**Actions → Deploy client to GitHub Pages → Run workflow** で回すか、何かを push する。

完了したら https://hsgwyuki0429-design.github.io/s0ccer/ を開き、画面上部の表示が
`オフライン（単独）` から `オンライン N人` に変われば成功。

## つまずきやすいところ

**`ws://` を設定してしまった**
Pages は HTTPS なので `ws://` は混在コンテンツとしてブラウザに遮断される。
クライアント側で `wss://` へ自動的に読み替えるようにしてあるが、そもそも
`wss://` で設定するのが正しい。

**繋がらないのにページは動く**
仕様。サーバーに繋がらなかった場合はオフラインへ落ちる。原因は画面左上の
デバッグ表示ではなくブラウザのコンソールに出る。

**遊ぶたびに部屋が分かれてしまう**
パーティを組まないと先着順で空き部屋に入る。友達とは画面右上の
**「招待リンク」**を共有すること。同じ部屋・同じチームに入る。

## サーバーを止めたいとき

`SERVER_URL` の Variable を消して Pages を再デプロイすれば、オフライン専用に戻る。
サーバー側のインスタンスも忘れずに停止する（Fly なら `fly apps destroy <名前>`）。

## セキュリティについて

現状、**接続元の制限も認証もしていない。** URL を知っていれば誰でも入れる。

サーバー権威なので位置や得点の改ざんはできないが、部屋を埋められる可能性はある。
友達内で遊ぶ範囲では見合わないコストなので入れていない。公開して困るようなら、
`packages/server/src/index.ts` の `wss.on('connection')` で Origin を見て弾くのが
いちばん手軽。
