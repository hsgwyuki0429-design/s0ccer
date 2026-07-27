import {
  C,
  hasControl,
  type BallState,
  type PlayerState,
  type World,
} from '@s0ccer/shared';
import type { AimView, StickView } from './input.ts';

/**
 * トップダウン 2D レンダラ。
 *
 * カメラは「自分の選手とボールの中点」を追う。ボールから目を離さずに
 * 自分の位置も把握できる形。ピッチ外を映しすぎないようクランプする。
 */

/** 画面に収めたい範囲（メートル）。狭いほど選手が大きく見える。 */
const VIEW_W = 36;
const VIEW_H = 22;
/** カメラがピッチ外を映してよい余白（メートル）。 */
const MARGIN = 2.5;

const TEAM_COLORS = ['#4da3ff', '#ff6b4d'];
const TEAM_COLORS_DARK = ['#1f5fa8', '#a83d28'];

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private scale = 20;
  private camX = 0;
  private camY = 0;
  /** カメラの追従は滑らかにする。急な切り替えは酔いの原因になる。 */
  private camInitialized = false;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D コンテキストを取得できませんでした');
    this.ctx = ctx;
  }

  /** CSS サイズと devicePixelRatio に合わせてバッファを調整する。 */
  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.scale = Math.min(w / VIEW_W, h / VIEW_H);
  }

  private get viewW(): number {
    return this.canvas.clientWidth;
  }
  private get viewH(): number {
    return this.canvas.clientHeight;
  }

  updateCamera(target: { x: number; y: number }, dt: number): void {
    const halfViewX = this.viewW / 2 / this.scale;
    const halfViewY = this.viewH / 2 / this.scale;

    const maxX = Math.max(0, C.HALF_W + MARGIN - halfViewX);
    const maxY = Math.max(0, C.HALF_H + MARGIN - halfViewY);
    const wantX = Math.max(-maxX, Math.min(maxX, target.x));
    const wantY = Math.max(-maxY, Math.min(maxY, target.y));

    if (!this.camInitialized) {
      this.camX = wantX;
      this.camY = wantY;
      this.camInitialized = true;
      return;
    }
    // 指数平滑。dt に依存しない形にしてフレームレート差で挙動が変わらないようにする。
    const t = 1 - Math.pow(0.0001, dt);
    this.camX += (wantX - this.camX) * t;
    this.camY += (wantY - this.camY) * t;
  }

  toScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: (x - this.camX) * this.scale + this.viewW / 2,
      y: (y - this.camY) * this.scale + this.viewH / 2,
    };
  }

  draw(
    world: World,
    localId: string,
    aimDir: { x: number; y: number },
    stick: StickView,
    aim: AimView,
    touchMode: boolean,
  ): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.viewW, this.viewH);
    ctx.fillStyle = '#14361f';
    ctx.fillRect(0, 0, this.viewW, this.viewH);

    this.drawPitch();

    const local = world.players.find((p) => p.id === localId);
    if (local) this.drawAimLine(local, world.ball, aimDir);

    this.drawBall(world.ball);
    for (const p of world.players) {
      this.drawPlayer(p, p.id === localId, world.ball);
    }

    if (touchMode) {
      this.drawStick(stick);
      this.drawAimPad(aim);
    }
  }

  private drawPitch(): void {
    const ctx = this.ctx;
    const s = this.scale;
    const tl = this.toScreen(-C.HALF_W, -C.HALF_H);

    // 芝のストライプ
    const stripeW = 5;
    ctx.save();
    ctx.beginPath();
    ctx.rect(tl.x, tl.y, C.PITCH_WIDTH * s, C.PITCH_HEIGHT * s);
    ctx.clip();
    for (let i = 0; i * stripeW < C.PITCH_WIDTH; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#1d4a2b' : '#1a4326';
      const x = this.toScreen(-C.HALF_W + i * stripeW, 0).x;
      ctx.fillRect(x, tl.y, stripeW * s, C.PITCH_HEIGHT * s);
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(1, 0.12 * s);

    // 外枠
    ctx.strokeRect(tl.x, tl.y, C.PITCH_WIDTH * s, C.PITCH_HEIGHT * s);

    // ハーフウェイライン
    const top = this.toScreen(0, -C.HALF_H);
    const bottom = this.toScreen(0, C.HALF_H);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.stroke();

    // センターサークル
    const center = this.toScreen(0, 0);
    ctx.beginPath();
    ctx.arc(center.x, center.y, C.CENTER_CIRCLE_RADIUS * s, 0, Math.PI * 2);
    ctx.stroke();

    for (const side of [-1, 1] as const) {
      const goalX = side * C.HALF_W;
      const g = this.toScreen(goalX, 0);

      // ゴールエリア（侵入禁止の半円）。GK の代わりなので視覚的に強調する。
      const a0 = side === 1 ? Math.PI / 2 : -Math.PI / 2;
      const a1 = side === 1 ? (Math.PI * 3) / 2 : Math.PI / 2;
      ctx.beginPath();
      ctx.arc(g.x, g.y, C.GOAL_AREA_RADIUS * s, a0, a1);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fill();
      ctx.stroke();

      // ゴール（ネット部分）
      const mouthTop = this.toScreen(goalX, -C.GOAL_WIDTH / 2);
      const depth = side * C.GOAL_DEPTH * s;
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(mouthTop.x, mouthTop.y, depth, C.GOAL_WIDTH * s);
      ctx.strokeRect(mouthTop.x, mouthTop.y, depth, C.GOAL_WIDTH * s);

      // ゴールポスト
      for (const py of [-C.GOAL_WIDTH / 2, C.GOAL_WIDTH / 2]) {
        const post = this.toScreen(goalX, py);
        ctx.beginPath();
        ctx.arc(post.x, post.y, Math.max(2, 0.1 * s), 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }
    }
  }

  private drawBall(ball: BallState): void {
    const ctx = this.ctx;
    const p = this.toScreen(ball.x, ball.y);
    const r = Math.max(3, C.BALL_RADIUS * this.scale);

    ctx.beginPath();
    ctx.arc(p.x + r * 0.35, p.y + r * 0.5, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.25);
    ctx.strokeStyle = '#20303a';
    ctx.stroke();
  }

  private drawPlayer(p: PlayerState, isLocal: boolean, ball: BallState): void {
    const ctx = this.ctx;
    const pos = this.toScreen(p.x, p.y);
    const r = C.PLAYER_RADIUS * this.scale;

    // コントロール範囲。ボールが操作可能かを一目で分かるようにする。
    if (isLocal) {
      const controlling = hasControl(p, ball);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, C.CONTROL_RADIUS * this.scale, 0, Math.PI * 2);
      ctx.strokeStyle = controlling ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.16)';
      ctx.lineWidth = controlling ? 2 : 1;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(pos.x + r * 0.2, pos.y + r * 0.35, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fillStyle = TEAM_COLORS[p.team];
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.18);
    ctx.strokeStyle = isLocal ? '#ffffff' : TEAM_COLORS_DARK[p.team];
    ctx.stroke();

    // 向き
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    ctx.lineTo(pos.x + p.facingX * r * 1.5, pos.y + p.facingY * r * 1.5);
    ctx.lineWidth = Math.max(2, r * 0.22);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.lineCap = 'butt';

    // チャージリング
    if (p.charge > 0) {
      const t = Math.min(1, p.charge / C.CHARGE_TIME_MAX);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r * 1.45, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t);
      ctx.lineWidth = Math.max(3, r * 0.3);
      ctx.strokeStyle = t >= 1 ? '#ffe14d' : '#ffffff';
      ctx.stroke();
    }
  }

  /** 狙いとパワーの可視化。「同じ操作 = 同じ球」を目で確認できるようにする。 */
  private drawAimLine(p: PlayerState, ball: BallState, aimDir: { x: number; y: number }): void {
    const ctx = this.ctx;
    // コントロール圏外ではキックが成立しない。そこで線を出すと「蹴れる」と
    // 誤解させるので、触れているときだけ描く。チャージ中でも例外にしない。
    if (!hasControl(p, ball)) return;
    if (aimDir.x === 0 && aimDir.y === 0) return;

    const charging = p.charge > 0;

    const t = Math.min(1, p.charge / C.CHARGE_TIME_MAX);
    const speed = C.KICK_SPEED_MIN + (C.KICK_SPEED_MAX - C.KICK_SPEED_MIN) * t;
    // 線の長さでボールの初速を表す（1秒後にどこまで進むかの目安）。
    const lengthM = speed * 0.55;

    const from = this.toScreen(ball.x, ball.y);
    const to = this.toScreen(ball.x + aimDir.x * lengthM, ball.y + aimDir.y * lengthM);

    ctx.save();
    ctx.setLineDash([8, 7]);
    ctx.lineWidth = charging ? 3 : 1.5;
    ctx.strokeStyle = charging
      ? `rgba(255,225,77,${0.45 + t * 0.5})`
      : 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }

  private drawStick(stick: StickView): void {
    if (!stick.active) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(stick.originX, stick.originY, 64, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(stick.curX, stick.curY, 26, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fill();
  }

  private drawAimPad(aim: AimView): void {
    if (!aim.active) return;
    const ctx = this.ctx;
    const color = aim.hasDirection ? 'rgba(255,225,77,0.55)' : 'rgba(255,255,255,0.3)';

    // ボールと見間違えないよう、塗りつぶさず輪郭だけで描く。
    ctx.beginPath();
    ctx.arc(aim.originX, aim.originY, 16, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    if (!aim.hasDirection) return;

    ctx.beginPath();
    ctx.moveTo(aim.originX, aim.originY);
    ctx.lineTo(aim.curX, aim.curY);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(aim.curX, aim.curY, 7, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}
