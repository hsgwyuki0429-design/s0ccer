import { clamp, emptyInput, normalize, type PlayerInput } from '@s0ccer/shared';

/**
 * 入力の抽象化。タッチとマウス／キーボードの差をここで吸収し、
 * 上位には PlayerInput という単一の形しか渡さない。
 *
 * 設計方針（design.md）:
 *   - 移動は「浮動スティック」。指を置いた場所がその都度の原点になるので
 *     中心ズレによる誤差が出ない。
 *   - キックは「押している時間 = パワー」「離す瞬間の方向 = 狙い」。
 *     オートエイム・オートパス・ブレは一切入れない。
 */

/** 浮動スティックの最大半径（CSS ピクセル）。ここまで倒すと最大速度。 */
const STICK_RADIUS = 64;
/** これ未満の指移動は「狙いなし」として扱う。誤爆防止のデッドゾーン。 */
const AIM_DEADZONE = 14;
/** 狙いのスティックをここまで倒すとキックの強さが最大になる。 */
const AIM_MAX_RADIUS = 72;
/** 倒し量が最小のときの強さ。0 にすると「蹴ったのに飛ばない」になるので下限を設ける。 */
const MIN_POWER = 0.15;

export interface StickView {
  active: boolean;
  originX: number;
  originY: number;
  curX: number;
  curY: number;
}

export interface AimView {
  active: boolean;
  originX: number;
  originY: number;
  curX: number;
  curY: number;
  /** 有効な狙いが定まっているか（デッドゾーンを超えたか）。 */
  hasDirection: boolean;
}

interface Pointer {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
}

export class InputController {
  private keys = new Set<string>();
  private movePointer: Pointer | null = null;
  private aimPointer: Pointer | null = null;
  private mouseX = 0;
  private mouseY = 0;
  private mouseDown = false;
  private seq = 0;

  /**
   * 直近に確定した狙いと強さ。
   *
   * 指を離した瞬間にはポインタがもう存在しないので、離す直前の値を
   * ここに保持しておき、キック成立時にはこれが使われる。
   */
  private lastAim = { x: 1, y: 0 };
  private lastPower = 1;

  /** 最後に触れた入力方式。UI の出し分けに使う。 */
  touchMode = false;

  /**
   * GK 交代の要求。UI のボタンから立てて、1ティック消費したら下ろす。
   * 押しっぱなしでも副作用はないが、意図しない再取得を避けるため単発にする。
   */
  private claimGkPending = false;

  /** 画面上のボタンから呼ぶ。次の入力で GK 交代を要求する。 */
  requestGoalkeeper(): void {
    this.claimGkPending = true;
  }

  constructor(private canvas: HTMLCanvasElement) {
    this.attach();
  }

  private attach(): void {
    const el = this.canvas;

    el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    el.addEventListener('pointermove', (e) => this.onPointerMove(e));
    el.addEventListener('pointerup', (e) => this.onPointerUp(e));
    el.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      // スペースでのスクロールなど、ブラウザ既定の動作を止める。
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown = false;
    });
  }

  private localPos(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerDown(e: PointerEvent): void {
    // 画面外へ指が出ても追従させる。合成イベントでは失敗しうるので握り潰す。
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const { x, y } = this.localPos(e);

    if (e.pointerType === 'mouse') {
      this.touchMode = false;
      this.mouseX = x;
      this.mouseY = y;
      if (e.button === 0) this.mouseDown = true;
      return;
    }

    this.touchMode = true;
    const half = this.canvas.clientWidth / 2;
    const pointer: Pointer = { id: e.pointerId, startX: x, startY: y, x, y };
    // 画面左半分＝移動、右半分＝キック。すでに使われている側は無視する。
    if (x < half) {
      if (!this.movePointer) this.movePointer = pointer;
    } else {
      if (!this.aimPointer) this.aimPointer = pointer;
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const { x, y } = this.localPos(e);

    if (e.pointerType === 'mouse') {
      this.mouseX = x;
      this.mouseY = y;
      return;
    }

    if (this.movePointer?.id === e.pointerId) {
      this.movePointer.x = x;
      this.movePointer.y = y;
    } else if (this.aimPointer?.id === e.pointerId) {
      this.aimPointer.x = x;
      this.aimPointer.y = y;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerType === 'mouse') {
      if (e.button === 0) this.mouseDown = false;
      return;
    }
    if (this.movePointer?.id === e.pointerId) this.movePointer = null;
    else if (this.aimPointer?.id === e.pointerId) this.aimPointer = null;
  }

  /** 移動スティックの現在値（-1..1）。 */
  private readMove(): { x: number; y: number } {
    if (this.movePointer) {
      const dx = this.movePointer.x - this.movePointer.startX;
      const dy = this.movePointer.y - this.movePointer.startY;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) return { x: 0, y: 0 };
      const scale = Math.min(len, STICK_RADIUS) / STICK_RADIUS / len;
      return { x: dx * scale, y: dy * scale };
    }

    let x = 0;
    let y = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y += 1;
    // 斜め入力が速くならないよう正規化する。
    if (x !== 0 && y !== 0) {
      const inv = 1 / Math.SQRT2;
      x *= inv;
      y *= inv;
    }
    return { x, y };
  }

  /**
   * 現在の入力を PlayerInput にまとめる。
   *
   * @param playerScreen プレイヤーの画面座標。マウス操作時の狙いの起点。
   */
  sample(playerScreen: { x: number; y: number }): PlayerInput {
    const input = emptyInput(this.seq++);
    const move = this.readMove();
    input.moveX = move.x;
    input.moveY = move.y;

    let aim: { x: number; y: number } | null = null;
    let power: number | null = null;
    let kick = false;

    if (this.aimPointer) {
      kick = true;
      const dx = this.aimPointer.x - this.aimPointer.startX;
      const dy = this.aimPointer.y - this.aimPointer.startY;
      const len = Math.hypot(dx, dy);
      if (len >= AIM_DEADZONE) aim = normalize({ x: dx, y: dy });
      // 倒し量がそのまま強さになる。フルチャージのままでも弱い球が撃てる。
      power = clamp(len / AIM_MAX_RADIUS, MIN_POWER, 1);
    } else if (this.mouseDown) {
      kick = true;
      aim = normalize({ x: this.mouseX - playerScreen.x, y: this.mouseY - playerScreen.y });
      // マウスは狙いが一瞬で定まるので、強さはチャージ時間だけで決める。
      power = 1;
    } else if (!this.touchMode) {
      // マウス操作では、押していないときもカーソル方向を狙いとして表示したい。
      aim = normalize({ x: this.mouseX - playerScreen.x, y: this.mouseY - playerScreen.y });
      power = 1;
    }

    if (aim && (aim.x !== 0 || aim.y !== 0)) this.lastAim = aim;
    if (power !== null) this.lastPower = power;

    input.kick = kick;
    input.aimX = this.lastAim.x;
    input.aimY = this.lastAim.y;
    input.power = this.lastPower;
    input.claimGk = this.claimGkPending;
    this.claimGkPending = false;
    return input;
  }

  /** 描画用のスティック状態。 */
  stickView(): StickView {
    if (!this.movePointer) {
      return { active: false, originX: 0, originY: 0, curX: 0, curY: 0 };
    }
    const dx = this.movePointer.x - this.movePointer.startX;
    const dy = this.movePointer.y - this.movePointer.startY;
    const len = Math.hypot(dx, dy);
    const scale = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
    return {
      active: true,
      originX: this.movePointer.startX,
      originY: this.movePointer.startY,
      curX: this.movePointer.startX + dx * scale,
      curY: this.movePointer.startY + dy * scale,
    };
  }

  /** 描画用の狙い状態。 */
  aimView(): AimView {
    if (!this.aimPointer) {
      return { active: false, originX: 0, originY: 0, curX: 0, curY: 0, hasDirection: false };
    }
    const dx = this.aimPointer.x - this.aimPointer.startX;
    const dy = this.aimPointer.y - this.aimPointer.startY;
    return {
      active: true,
      originX: this.aimPointer.startX,
      originY: this.aimPointer.startY,
      curX: this.aimPointer.x,
      curY: this.aimPointer.y,
      hasDirection: Math.hypot(dx, dy) >= AIM_DEADZONE,
    };
  }

  isKeyPressed(code: string): boolean {
    return this.keys.has(code);
  }

  consumeKey(code: string): boolean {
    if (!this.keys.has(code)) return false;
    this.keys.delete(code);
    return true;
  }
}
