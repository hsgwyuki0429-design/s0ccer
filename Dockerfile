# s0ccer ゲームサーバー
#
# shared/ のソースを直接読むので、サーバー単体ではなくリポジトリ全体を入れる。
# Node の型ストリッピングで .ts をそのまま実行するため、ビルド手順は要らない。

FROM node:22-alpine AS deps
WORKDIR /app

# 依存だけ先に入れてレイヤーキャッシュを効かせる。
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/
# サーバーの実行に要らない devDependencies（vite / typescript / playwright）は省く。
RUN npm ci --omit=dev --workspace @s0ccer/server --include-workspace-root

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

# root で動かす必要はない。
USER node

EXPOSE 8787
ENV PORT=8787

# 実行前に health を叩けるようにしておくと、プラットフォーム側の
# ヘルスチェック設定がそのまま使える。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/src/index.ts"]
