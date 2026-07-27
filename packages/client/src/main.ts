import { C } from '@s0ccer/shared';
import type { Game } from './game.ts';
import { InputController } from './input.ts';
import { LocalGame } from './local.ts';
import { NetClient } from './net.ts';
import { OnlineGame } from './online.ts';
import { Renderer } from './render.ts';

/**
 * エントリポイント。ゲームモードを選び、固定タイムステップのループを回す。
 *
 * サーバーが設定されていればオンライン、なければオフライン（単独）で動く。
 * オンラインに繋がらなかった場合もオフラインへ落ちる。GitHub Pages に
 * 置いた静的ビルドが「何も遊べないページ」にならないようにするため。
 */

const canvas = document.getElementById('game') as HTMLCanvasElement;
const scoreHome = document.getElementById('score-home') as HTMLElement;
const scoreAway = document.getElementById('score-away') as HTMLElement;
const powerFill = document.getElementById('power-fill') as HTMLElement;
const debugEl = document.getElementById('debug') as HTMLElement;
const hintEl = document.getElementById('hint') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const flashEl = document.getElementById('flash') as HTMLElement;

const renderer = new Renderer(canvas);
const input = new InputController(canvas);
const screenOf = (x: number, y: number) => renderer.toScreen(x, y);

/**
 * 接続先の決め方。
 *   1. ?server=wss://... を最優先（Pages に置いた静的ビルドから繋ぐ用）
 *   2. ビルド時の VITE_SERVER_URL
 *   3. 開発サーバーなら同じホストの :8787
 *   4. どれもなければオフライン
 */
function resolveServerUrl(): string | null {
  const params = new URLSearchParams(location.search);
  if (params.get('offline') !== null) return null;

  const explicit = params.get('server');
  if (explicit) return explicit;

  const configured = import.meta.env.VITE_SERVER_URL;
  if (configured) return configured;

  if (import.meta.env.DEV) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.hostname}:8787`;
  }
  return null;
}

let net: NetClient | null = null;
let game: Game;

function startLocal(): void {
  game = new LocalGame(input, screenOf);
  game.onGoal = showGoal;
}

function startOnline(url: string): void {
  net = new NetClient(url);
  game = new OnlineGame(net, input, screenOf);
  game.onGoal = showGoal;
}

function showGoal(team: number): void {
  flashEl.textContent = 'GOAL';
  flashEl.style.color = team === 0 ? '#4da3ff' : '#ff6b4d';
  flashEl.classList.add('show');
  window.setTimeout(() => flashEl.classList.remove('show'), 900);
}

const serverUrl = resolveServerUrl();
if (serverUrl) startOnline(serverUrl);
else startLocal();

resetBtn.addEventListener('click', () => game.reset());

let accumulatedFps = 60;
let lastTime = performance.now();

function frame(now: number): void {
  const frameDt = Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;
  accumulatedFps += (1 / Math.max(frameDt, 1e-4) - accumulatedFps) * 0.1;

  renderer.resize();

  // 一度も繋がらないまま切れたらオフラインへ落とす。
  if (net && (net.status === 'closed' || net.status === 'error') && net.welcome === null) {
    net.close();
    net = null;
    startLocal();
  }

  if (input.consumeKey('KeyR')) game.reset();

  game.update(frameDt);

  const world = game.world;
  const me = world.players.find((p) => p.id === game.localId);
  const focus = me ?? { x: world.ball.x, y: world.ball.y };
  renderer.updateCamera(
    { x: (focus.x + world.ball.x) / 2, y: (focus.y + world.ball.y) / 2 },
    frameDt,
  );
  renderer.draw(world, game.localId, game.aimDir, input.stickView(), input.aimView(), input.touchMode);

  scoreHome.textContent = String(world.score[0]);
  scoreAway.textContent = String(world.score[1]);

  const charge = me ? Math.min(1, me.charge / C.CHARGE_TIME_MAX) : 0;
  powerFill.style.width = `${charge * 100}%`;
  powerFill.classList.toggle('max', charge >= 1);

  statusEl.textContent = game.statusText();
  resetBtn.style.display = net ? 'none' : '';

  debugEl.textContent = [`fps    ${accumulatedFps.toFixed(0)}`, ...game.debugLines()].join('\n');

  hintEl.textContent = input.touchMode
    ? '左半分: 移動（浮動スティック）\n右半分: 長押しでチャージ → 指の向きへキック'
    : 'WASD / 矢印: 移動\nマウス長押し: チャージ → カーソル方向へキック\nR: リセット';

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
