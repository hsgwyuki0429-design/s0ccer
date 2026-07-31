import { C, kickSpeed, winner, type MatchPhase, type World } from '@s0ccer/shared';
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
 * オンラインに繋がらなかった場合もオフラインへ落ちる。静的ホスティングに
 * 置いたビルドが「何も遊べないページ」にならないようにするため。
 */

const canvas = document.getElementById('game') as HTMLCanvasElement;
const scoreHome = document.getElementById('score-home') as HTMLElement;
const scoreAway = document.getElementById('score-away') as HTMLElement;
const powerFill = document.getElementById('power-fill') as HTMLElement;
const debugEl = document.getElementById('debug') as HTMLElement;
const hintEl = document.getElementById('hint') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const clockEl = document.getElementById('clock') as HTMLElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const gkBtn = document.getElementById('gk') as HTMLButtonElement;
const inviteBtn = document.getElementById('invite') as HTMLButtonElement;
const flashEl = document.getElementById('flash') as HTMLElement;
const bannerEl = document.getElementById('banner') as HTMLElement;
const bannerTitle = bannerEl.querySelector('.title') as HTMLElement;
const bannerSub = bannerEl.querySelector('.sub') as HTMLElement;

const renderer = new Renderer(canvas);
const input = new InputController(canvas);
const screenOf = (x: number, y: number) => renderer.toScreen(x, y);

/**
 * 接続先の決め方。
 *   1. ?server=wss://... を最優先（静的ビルドから繋ぐ用）
 *   2. ビルド時の VITE_SERVER_URL
 *   3. 開発サーバーなら同じホストの :8787
 *   4. どれもなければオフライン
 */
function resolveServerUrl(): string | null {
  const params = new URLSearchParams(location.search);
  if (params.get('offline') !== null) return null;

  const explicit = params.get('server');
  if (explicit) return secureIfNeeded(explicit);

  const configured = import.meta.env.VITE_SERVER_URL;
  if (configured) return secureIfNeeded(configured);

  if (import.meta.env.DEV) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.hostname}:8787`;
  }
  return null;
}

/**
 * HTTPS のページからは ws:// に繋げない（混在コンテンツとしてブラウザに
 * 遮断される）。同じホストで TLS 終端しているのが普通なので、黙って落ちる
 * より wss:// へ上げたほうが繋がる可能性が高い。
 */
function secureIfNeeded(url: string): string {
  if (location.protocol !== 'https:' || !url.startsWith('ws://')) return url;
  return `wss://${url.slice('ws://'.length)}`;
}

let net: NetClient | null = null;
let game: Game;

function startLocal(): void {
  game = new LocalGame(input, screenOf);
  game.onGoal = showGoal;
}

function startOnline(url: string): void {
  const party = new URLSearchParams(location.search).get('party') ?? '';
  net = new NetClient(url, party);
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
gkBtn.addEventListener('click', () => game.requestGoalkeeper());

inviteBtn.addEventListener('click', async () => {
  const code = game.lobby?.partyCode;
  if (!code) return;
  const url = new URL(location.href);
  url.searchParams.set('party', code);
  const link = url.toString();

  // 共有シートが使えるならそちら、無理ならクリップボードへ。
  try {
    if (navigator.share) await navigator.share({ url: link });
    else await navigator.clipboard.writeText(link);
    inviteBtn.textContent = 'コピーしました';
  } catch {
    inviteBtn.textContent = code;
  }
  window.setTimeout(() => {
    inviteBtn.textContent = '招待リンク';
  }, 1600);
});

/** 秒を mm:ss にする。 */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 試合の状況を1行で表す。 */
function clockText(world: World): string {
  if (world.config.mode === 'firstTo') {
    return `${world.config.targetScore}点先取 ・ ${formatClock(world.clock)}`;
  }
  return `${world.half === 1 ? '前半' : '後半'} ${formatClock(world.clock)}`;
}

/** カウントダウンやハーフタイムなど、プレー外の表示。 */
function updateBanner(world: World, localTeam: 0 | 1 | null): void {
  const phase: MatchPhase = world.phase;

  if (phase === 'playing') {
    bannerEl.classList.remove('show');
    return;
  }

  let title = '';
  let sub = '';

  if (phase === 'countdown') {
    title = String(Math.max(1, Math.ceil(world.phaseTimer)));
    sub = 'まもなく開始';
  } else if (phase === 'halftime') {
    title = 'ハーフタイム';
    sub = `コートチェンジ ・ ${Math.ceil(world.phaseTimer)}`;
  } else {
    const w = winner(world);
    title = w === null ? 'DRAW' : w === localTeam ? 'WIN' : 'LOSE';
    if (localTeam === null) title = w === null ? 'DRAW' : `TEAM ${w === 0 ? 'BLUE' : 'RED'}`;
    sub = `${world.score[0]} − ${world.score[1]} ・ まもなく次の試合`;
  }

  bannerTitle.textContent = title;
  bannerSub.textContent = sub;
  bannerEl.classList.add('show');
}

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
  if (input.consumeKey('KeyG')) game.requestGoalkeeper();

  game.update(frameDt);

  const world = game.world;
  const me = world.players.find((p) => p.id === game.localId);
  const focus = me ?? { x: world.ball.x, y: world.ball.y };
  renderer.updateCamera(
    { x: (focus.x + world.ball.x) / 2, y: (focus.y + world.ball.y) / 2 },
    frameDt,
  );
  renderer.draw(
    world,
    game.localId,
    game.aimDir,
    game.power,
    input.stickView(),
    input.aimView(),
    input.touchMode,
  );

  scoreHome.textContent = String(world.score[0]);
  scoreAway.textContent = String(world.score[1]);
  clockEl.textContent = clockText(world);
  updateBanner(world, me?.team ?? null);

  // ゲージは「チャージ量」ではなく「実際に飛ぶ球の強さ」を出す。
  // 傾け度で弱めた場合もそのまま見えるようにするため。
  const speed = me ? kickSpeed(me.charge, game.power) : C.KICK_SPEED_MIN;
  const ratio = (speed - C.KICK_SPEED_MIN) / (C.KICK_SPEED_MAX - C.KICK_SPEED_MIN);
  powerFill.style.width = `${ratio * 100}%`;
  powerFill.classList.toggle('max', ratio >= 0.999);

  gkBtn.classList.toggle('active', me?.isGk === true);
  gkBtn.textContent = me?.isGk ? 'キーパー中' : 'キーパーになる';
  inviteBtn.style.display = game.lobby ? '' : 'none';
  resetBtn.style.display = net ? 'none' : '';

  const lobby = game.lobby;
  statusEl.textContent = lobby
    ? `${game.statusText()} ・ パーティ ${lobby.partyCode}（${lobby.partySize}人）`
    : game.statusText();

  debugEl.textContent = [`fps    ${accumulatedFps.toFixed(0)}`, ...game.debugLines()].join('\n');

  hintEl.textContent = input.touchMode
    ? '左半分: 移動（浮動スティック）\n右半分: 長押しでチャージ → 指の向きへキック\n倒し量が強さ。チャージ中は足が遅くなる'
    : 'WASD / 矢印: 移動\nマウス長押し: チャージ → カーソル方向へキック\nG: キーパー交代 ／ R: リセット';

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
