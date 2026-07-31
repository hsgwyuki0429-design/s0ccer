import {
  C,
  cloneWorld,
  createWorld,
  quantizeInput,
  step,
  type PlayerInput,
  type LobbyInfo,
  type PlayerState,
  type Snapshot,
  type TeamId,
  type World,
} from '@s0ccer/shared';
import type { Game, ScreenOf } from './game.ts';
import type { InputController } from './input.ts';
import type { NetClient } from './net.ts';

/**
 * オンラインモード。サーバー権威 + クライアント予測 + リコンシリエーション。
 *
 * ボールを含む世界全体を予測する。ボールだけ補間表示にすると、キックしてから
 * ボールが動いて見えるまで RTT + 補間遅延がかかり、サッカーとして成立しない。
 * 詳しくは docs/netcode.md。
 */

/** 誤差をこの割合まで1秒で減衰させる。小さいほど速く吸収する。 */
const ERROR_DECAY = 1e-3;
/** これを超えるズレは平滑化せず即座に合わせる（得点後のリセットなど）。 */
const MAX_SMOOTH_ERROR = 3;
/** 保持する未確認入力の上限。異常時に無限に伸びないようにする。 */
const MAX_PENDING = 120;
/** サーバー側の未処理入力キューの目標値。 */
const TARGET_QUEUE_DEPTH = 2;

interface Offset {
  x: number;
  y: number;
}

function worldFromSnapshot(s: Snapshot): World {
  return {
    tick: s.serverTick,
    players: s.players.map(
      (p): PlayerState => ({
        id: String(p.slot),
        team: p.team,
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy,
        facingX: p.facingX,
        facingY: p.facingY,
        charge: p.charge,
        kickHeld: p.kickHeld,
        kickCooldown: p.kickCooldown,
        isGk: p.isGk,
        isAi: p.isAi,
      }),
    ),
    ball: { ...s.ball },
    score: [s.score[0], s.score[1]],
    config: { ...s.config },
    phase: s.phase,
    phaseTimer: s.phaseTimer,
    half: s.half,
    clock: s.clock,
    sidesSwapped: s.sidesSwapped,
    // lastTouch はスナップショットに載せていない。予測でラインを割った場合の
    // 再開側がずれうるが、次のスナップショットで訂正されるので実害はない。
    lastTouch: null,
    restartTeam: s.restartTeam,
    restartTimer: s.restartTimer,
  };
}

export class OnlineGame implements Game {
  world: World = createWorld();
  localId = '';
  aimDir = { x: 1, y: 0 };
  power = 1;
  onGoal: ((team: TeamId) => void) | null = null;
  lobby: LobbyInfo | null = null;

  /** サーバーの状態に未確認入力を再適用した、いま操作している世界。 */
  private predicted: World = createWorld();
  /** サーバーがまだ処理を確認していない自分の入力。 */
  private pending: PlayerInput[] = [];
  /** 他プレイヤーが保持していると仮定する入力。再シミュレーションの外挿に使う。 */
  private otherInputs = new Map<string, PlayerInput>();
  /** 描画位置と予測位置のズレ。スナップショットのたびに積み、毎フレーム減衰させる。 */
  private errors = new Map<string, Offset>();

  private localTick = 0;
  private synced = false;
  private accumulator = 0;
  /** 正なら余分に進める、負なら1ティック飛ばす。サーバーとの歩調合わせ。 */
  private tickDebt = 0;

  private lastScore: [number, number] = [0, 0];
  private lastCorrection = 0;
  private queueDepth = 0;
  private peakKick = 0;

  constructor(
    private net: NetClient,
    private input: InputController,
    private screenOf: ScreenOf,
  ) {
    this.net.onWelcome = (w) => {
      this.localId = String(w.slot);
    };
    this.net.onSnapshot = (s) => this.applySnapshot(s);
    this.net.onLobby = (info) => {
      this.lobby = info;
    };
  }

  requestGoalkeeper(): void {
    this.input.requestGoalkeeper();
  }

  // --- サーバーからの訂正 ---------------------------------------------------

  private applySnapshot(s: Snapshot): void {
    const before = this.captureRenderPositions();

    const corrected = worldFromSnapshot(s);

    this.otherInputs.clear();
    for (const p of s.players) {
      const id = String(p.slot);
      if (id === this.localId) continue;
      this.otherInputs.set(id, { seq: 0, ...p.input });
    }

    // 確認済みの入力を捨て、残りを再適用して現在時刻まで追いつかせる。
    this.pending = this.pending.filter((i) => i.seq > s.lastProcessedSeq);
    for (const input of this.pending) {
      step(corrected, this.inputMap(input));
    }
    this.predicted = corrected;

    this.absorbError(before);

    this.queueDepth = s.queueDepth;
    if (!this.synced) {
      // 入力がサーバーに間に合うよう、片道遅延ぶんだけ先行して回す。
      const lead = Math.ceil(this.net.rtt / 2 / 1000 / C.DT) + TARGET_QUEUE_DEPTH;
      this.localTick = s.serverTick + lead;
      this.synced = true;
    } else if (s.queueDepth === 0) {
      // サーバーが入力に飢えている＝先行が足りない。
      this.tickDebt += 1;
    } else if (s.queueDepth > TARGET_QUEUE_DEPTH + 1) {
      // 先行しすぎ。自分の操作が相手に届くのが遅くなるので少し戻す。
      // 0 と閾値のあいだに幅を持たせて、上下に振動しないようにする。
      this.tickDebt -= 1;
    }

    if (s.score[0] > this.lastScore[0]) this.onGoal?.(0);
    else if (s.score[1] > this.lastScore[1]) this.onGoal?.(1);
    this.lastScore = [s.score[0], s.score[1]];
  }

  /**
   * 訂正前の描画位置を保ったまま、予測位置だけ差し替える。
   *
   * ズレを誤差として持ち越し、あとから滑らかに減衰させることで、
   * スナップショットのたびに全員がカクつくのを防ぐ。
   */
  private absorbError(before: Map<string, Offset>): void {
    let worst = 0;

    const absorb = (key: string, nx: number, ny: number) => {
      const prev = before.get(key);
      if (!prev) {
        this.errors.delete(key);
        return;
      }
      const ex = prev.x - nx;
      const ey = prev.y - ny;
      const dist = Math.hypot(ex, ey);
      worst = Math.max(worst, dist);
      // 大きすぎるズレを引きずると「ワープしながら滑る」になるので即合わせる。
      this.errors.set(key, dist > MAX_SMOOTH_ERROR ? { x: 0, y: 0 } : { x: ex, y: ey });
    };

    absorb('ball', this.predicted.ball.x, this.predicted.ball.y);
    for (const p of this.predicted.players) absorb(p.id, p.x, p.y);

    // 消えたプレイヤーの誤差は捨てる。
    const alive = new Set(this.predicted.players.map((p) => p.id));
    for (const key of this.errors.keys()) {
      if (key !== 'ball' && !alive.has(key)) this.errors.delete(key);
    }

    this.lastCorrection = worst;
  }

  private captureRenderPositions(): Map<string, Offset> {
    const map = new Map<string, Offset>();
    const ballError = this.errors.get('ball') ?? { x: 0, y: 0 };
    map.set('ball', {
      x: this.predicted.ball.x + ballError.x,
      y: this.predicted.ball.y + ballError.y,
    });
    for (const p of this.predicted.players) {
      const e = this.errors.get(p.id) ?? { x: 0, y: 0 };
      map.set(p.id, { x: p.x + e.x, y: p.y + e.y });
    }
    return map;
  }

  // --- 予測 -----------------------------------------------------------------

  private inputMap(mine: PlayerInput): Map<string, PlayerInput> {
    const map = new Map(this.otherInputs);
    if (this.localId) map.set(this.localId, mine);
    return map;
  }

  private doTick(): void {
    this.localTick++;

    const me = this.predicted.players.find((p) => p.id === this.localId);
    const screen = this.screenOf(me?.x ?? 0, me?.y ?? 0);
    // 送信と同じ量子化済みの値で予測する。ここが違うと毎ティックずれ続ける。
    const input = quantizeInput(this.input.sample(screen));
    input.seq = this.localTick;
    this.aimDir = { x: input.aimX, y: input.aimY };
    this.power = input.power;

    this.pending.push(input);
    if (this.pending.length > MAX_PENDING) this.pending.shift();

    const events = step(this.predicted, this.inputMap(input));
    for (const k of events.kicks) {
      if (k.playerId === this.localId) this.peakKick = k.speed;
    }

    this.net.sendInputs(this.pending);
  }

  update(frameDt: number): void {
    if (this.synced) {
      this.accumulator += frameDt;
      let steps = 0;
      while (this.accumulator >= C.DT && steps < 8) {
        this.accumulator -= C.DT;
        if (this.tickDebt < 0) {
          // 先行しすぎているので、このぶんは進めずに見送る。
          this.tickDebt++;
          continue;
        }
        this.doTick();
        steps++;
        if (this.tickDebt > 0) {
          this.tickDebt--;
          this.doTick();
          steps++;
        }
      }
      if (this.accumulator > C.DT * 8) this.accumulator = 0;
    }

    const decay = Math.pow(ERROR_DECAY, frameDt);
    for (const e of this.errors.values()) {
      e.x *= decay;
      e.y *= decay;
    }

    this.buildRenderWorld();
  }

  private buildRenderWorld(): void {
    const w = cloneWorld(this.predicted);
    const ballError = this.errors.get('ball');
    if (ballError) {
      w.ball.x += ballError.x;
      w.ball.y += ballError.y;
    }
    for (const p of w.players) {
      const e = this.errors.get(p.id);
      if (!e) continue;
      p.x += e.x;
      p.y += e.y;
    }
    this.world = w;
  }

  // --- HUD ------------------------------------------------------------------

  debugLines(): string[] {
    const me = this.predicted.players.find((p) => p.id === this.localId);
    return [
      `rtt    ${this.net.rtt.toFixed(0)} ms`,
      `tick   ${this.localTick} (+${this.pending.length})`,
      `queue  ${this.queueDepth}`,
      `fix    ${(this.lastCorrection * 100).toFixed(1)} cm`,
      `ball   ${Math.hypot(this.predicted.ball.vx, this.predicted.ball.vy).toFixed(1)} m/s`,
      `kick   ${this.peakKick.toFixed(1)} m/s`,
      `player ${me ? Math.hypot(me.vx, me.vy).toFixed(1) : '0.0'} m/s`,
    ];
  }

  statusText(): string {
    switch (this.net.status) {
      case 'connecting':
        return '接続中…';
      case 'open':
        return this.localId === ''
          ? '参加待ち…'
          : `オンライン ${this.predicted.players.length}人`;
      case 'closed':
        return '切断されました';
      case 'error':
        return '接続エラー';
    }
  }

  reset(): void {
    // サーバーが権威なのでクライアントからはリセットしない。
  }
}
