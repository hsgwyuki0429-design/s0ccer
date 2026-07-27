import {
  C,
  createPlayer,
  createWorld,
  resetPositions,
  step,
  type PlayerInput,
} from '@s0ccer/shared';
import { InputController } from './input.ts';
import { Renderer } from './render.ts';

/**
 * Phase 1: ローカル1人プロトタイプ。
 *
 * 目的はネットワークではなく **手触りの確定**。ここで操作感が決まらないまま
 * オンライン化しても意味がないので、まず物理と入力だけを詰める。
 *
 * シミュレーションは Phase 2 以降と同じ固定タイムステップ（60Hz）で回す。
 * 描画のフレームレートとは切り離してあるので、120Hz 画面でも挙動は変わらない。
 */

const LOCAL_ID = 'me';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const scoreHome = document.getElementById('score-home') as HTMLElement;
const scoreAway = document.getElementById('score-away') as HTMLElement;
const powerFill = document.getElementById('power-fill') as HTMLElement;
const debugEl = document.getElementById('debug') as HTMLElement;
const hintEl = document.getElementById('hint') as HTMLElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const flashEl = document.getElementById('flash') as HTMLElement;

const world = createWorld();
world.players.push(createPlayer(LOCAL_ID, 0));
resetPositions(world);

const renderer = new Renderer(canvas);
const input = new InputController(canvas);

let lastInput: PlayerInput | null = null;
let accumulator = 0;
let lastTime = performance.now();
let fps = 60;
/** ボール速度の直近ピーク。キック力の確認用。 */
let peakBallSpeed = 0;

resetBtn.addEventListener('click', () => {
  world.score[0] = 0;
  world.score[1] = 0;
  resetPositions(world);
  peakBallSpeed = 0;
});

function showFlash(text: string, color: string): void {
  flashEl.textContent = text;
  flashEl.style.color = color;
  flashEl.classList.add('show');
  window.setTimeout(() => flashEl.classList.remove('show'), 900);
}

function frame(now: number): void {
  const frameDt = Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;
  fps += (1 / Math.max(frameDt, 1e-4) - fps) * 0.1;

  renderer.resize();

  if (input.consumeKey('KeyR')) {
    resetPositions(world);
    peakBallSpeed = 0;
  }

  accumulator += frameDt;
  // 一度に処理するティック数に上限を設ける。タブ復帰時の暴走を防ぐ。
  let ticks = 0;
  while (accumulator >= C.DT && ticks < 8) {
    accumulator -= C.DT;
    ticks++;

    const local = world.players.find((p) => p.id === LOCAL_ID)!;
    const screen = renderer.toScreen(local.x, local.y);
    const sampled = input.sample(screen);
    lastInput = sampled;

    const events = step(world, new Map([[LOCAL_ID, sampled]]));

    if (events.goal !== null) {
      showFlash('GOAL', events.goal === 0 ? '#4da3ff' : '#ff6b4d');
      peakBallSpeed = 0;
    }
    for (const k of events.kicks) peakBallSpeed = k.speed;
  }
  // 積み残しが大きいときは捨てる（デバッガで止めた後などの巻き戻り防止）。
  if (accumulator > C.DT * 8) accumulator = 0;

  const local = world.players.find((p) => p.id === LOCAL_ID)!;
  renderer.updateCamera(
    { x: (local.x + world.ball.x) / 2, y: (local.y + world.ball.y) / 2 },
    frameDt,
  );
  renderer.draw(
    world,
    LOCAL_ID,
    { x: lastInput?.aimX ?? 1, y: lastInput?.aimY ?? 0 },
    input.stickView(),
    input.aimView(),
    input.touchMode,
  );

  scoreHome.textContent = String(world.score[0]);
  scoreAway.textContent = String(world.score[1]);

  const chargeRatio = Math.min(1, local.charge / C.CHARGE_TIME_MAX);
  powerFill.style.width = `${chargeRatio * 100}%`;
  powerFill.classList.toggle('max', chargeRatio >= 1);

  const ballSpeed = Math.hypot(world.ball.vx, world.ball.vy);
  debugEl.textContent = [
    `fps    ${fps.toFixed(0)}`,
    `tick   ${world.tick}`,
    `ball   ${ballSpeed.toFixed(1)} m/s`,
    `kick   ${peakBallSpeed.toFixed(1)} m/s`,
    `player ${Math.hypot(local.vx, local.vy).toFixed(1)} m/s`,
  ].join('\n');

  hintEl.textContent = input.touchMode
    ? '左半分: 移動（浮動スティック）\n右半分: 長押しでチャージ → 指の向きへキック'
    : 'WASD / 矢印: 移動\nマウス長押し: チャージ → カーソル方向へキック\nR: リセット';

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
