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

/**
 * 再接続の待ち時間（秒）。
 *
 * 無料ホスティングはアイドルでインスタンスを止めることがあり、復帰に
 * 1分近くかかる。1回失敗しただけでオフラインへ落とすと、そういう
 * サーバーには永久に繋がらない。
 */
const RETRY_DELAYS = [1, 2, 4, 8, 12, 15, 15, 15];

let net: NetClient | null = null;
let game: Game;
let offline = false;
/** 連続で失敗した回数。成功したら 0 に戻す。 */
let failures = 0;
/** 次に接続を試してよい時刻（performance.now 基準）。 */
let nextAttemptAt = 0;
/** 一度でも参加できたか。冷起動待ちと「そもそも繋がらない」を区別する。 */
let everJoined = false;

function startLocal(): void {
  offline = true;
  game = new LocalGame(input, screenOf);
  game.onGoal = showGoal;
}

function startOnline(url: string): void {
  offline = false;
  net = new NetClient(url, partyCode());
  game = new OnlineGame(net, input, screenOf);
  game.onGoal = showGoal;
}

/** 現在のパーティコード。URL に無ければ空文字（サーバーが新規発行する）。 */
function partyCode(): string {
  return new URLSearchParams(location.search).get('party') ?? '';
}

/**
 * サーバーから受け取ったパーティコードを URL に書き戻す。
 *
 * 再接続したときに同じパーティへ戻れるようにするため。ついでに、
 * 共有ボタンを押さなくてもアドレスバーがそのまま招待リンクになる。
 */
function rememberParty(code: string): void {
  if (!code || partyCode() === code) return;
  const url = new URL(location.href);
  url.searchParams.set('party', code);
  history.replaceState(null, '', url);
}

/**
 * 接続を維持する。毎フレーム呼ばれ、切れていれば間隔を空けて繋ぎ直す。
 *
 * 一度も参加できないまま試行回数を使い切った場合だけオフラインへ落とす。
 * 途中で切れた場合は諦めずに繋ぎ直す（サーバーの再起動を跨ぎたいため）。
 */
function maintainConnection(url: string, now: number): void {
  if (net) {
    if (net.welcome) {
      everJoined = true;
      failures = 0;
    }
    if (net.status !== 'closed' && net.status !== 'error') return;
    net.close();
    net = null;
  }

  if (!everJoined && failures >= RETRY_DELAYS.length) {
    if (!offline) startLocal();
    return;
  }

  if (now < nextAttemptAt) return;
  nextAttemptAt = now + RETRY_DELAYS[Math.min(failures, RETRY_DELAYS.length - 1)] * 1000;
  failures++;
  startOnline(url);
}

/** 接続をやり直している最中かどうかの表示。 */
function retryNote(): string | null {
  if (offline || failures <= 1 || everJoined) return null;
  return `サーバー起動中… (${failures}/${RETRY_DELAYS.length})`;
}

function showGoal(team: number): void {
  flashEl.textContent = 'GOAL';
  flashEl.style.color = team === 0 ? '#4da3ff' : '#ff6b4d';
  flashEl.classList.add('show');
  window.setTimeout(() => flashEl.classList.remove('show'), 900);
}

const serverUrl = resolveServerUrl();
if (serverUrl) {
  failures = 1;
  nextAttemptAt = performance.now() + RETRY_DELAYS[0] * 1000;
  startOnline(serverUrl);
} else {
  startLocal();
}

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

  if (serverUrl) maintainConnection(serverUrl, now);

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
  resetBtn.style.display = offline ? '' : 'none';

  const lobby = game.lobby;
  if (lobby) rememberParty(lobby.partyCode);

  const note = retryNote();
  statusEl.textContent = note
    ? note
    : lobby
      ? `${game.statusText()} ・ パーティ ${lobby.partyCode}（${lobby.partySize}人）`
      : game.statusText();

  debugEl.textContent = [`fps    ${accumulatedFps.toFixed(0)}`, ...game.debugLines()].join('\n');

  hintEl.textContent = input.touchMode
    ? '左半分: 移動（浮動スティック）\n右半分: 長押しでチャージ → 指の向きへキック\n倒し量が強さ。チャージ中は足が遅くなる'
    : 'WASD / 矢印: 移動\nマウス長押し: チャージ → カーソル方向へキック\nG: キーパー交代 ／ R: リセット';

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
