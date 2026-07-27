import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages はリポジトリ名のサブパス配信になるため、本番ビルドのみ
  // base を /s0ccer/ にする。dev サーバーはルート配信のままでよい。
  base: process.env.GITHUB_PAGES ? '/s0ccer/' : '/',
  resolve: {
    alias: {
      // shared はビルド成果物ではなくソースを直接参照する。
      // サーバーとクライアントで同一の物理コードを使うための構成。
      '@s0ccer/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    // スマホの実機から同一 LAN 経由で開いて確認できるようにする。
    host: true,
  },
});
