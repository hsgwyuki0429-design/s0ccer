import {
  C,
  createPlayer,
  createWorld,
  resetPositions,
  step,
  type TeamId,
  type World,
} from '@s0ccer/shared';
import type { Game, ScreenOf } from './game.ts';
import type { InputController } from './input.ts';

const LOCAL_ID = 'me';

/**
 * オフラインモード。サーバーに繋がらないときの単独プレイ。
 *
 * Phase 1 のプロトタイプそのもの。物理の手触りを確認する用途と、
 * サーバー未設定でもページが死なないようにするための保険を兼ねる。
 */
export class LocalGame implements Game {
  readonly world: World = createWorld();
  readonly localId = LOCAL_ID;
  aimDir = { x: 1, y: 0 };
  power = 1;
  onGoal: ((team: TeamId) => void) | null = null;

  private accumulator = 0;
  private peakKick = 0;

  constructor(
    private input: InputController,
    private screenOf: ScreenOf,
  ) {
    this.world.players.push(createPlayer(LOCAL_ID, 0));
    resetPositions(this.world);
  }

  update(frameDt: number): void {
    this.accumulator += frameDt;
    let steps = 0;
    // 一度に処理するティック数に上限を設ける。タブ復帰時の暴走を防ぐ。
    while (this.accumulator >= C.DT && steps < 8) {
      this.accumulator -= C.DT;
      steps++;

      const me = this.world.players.find((p) => p.id === LOCAL_ID)!;
      const sampled = this.input.sample(this.screenOf(me.x, me.y));
      this.aimDir = { x: sampled.aimX, y: sampled.aimY };
      this.power = sampled.power;

      const events = step(this.world, new Map([[LOCAL_ID, sampled]]));
      if (events.goal !== null) {
        this.onGoal?.(events.goal);
        this.peakKick = 0;
      }
      for (const k of events.kicks) this.peakKick = k.speed;
    }
    if (this.accumulator > C.DT * 8) this.accumulator = 0;
  }

  debugLines(): string[] {
    const me = this.world.players.find((p) => p.id === LOCAL_ID);
    return [
      `tick   ${this.world.tick}`,
      `ball   ${Math.hypot(this.world.ball.vx, this.world.ball.vy).toFixed(1)} m/s`,
      `kick   ${this.peakKick.toFixed(1)} m/s`,
      `player ${me ? Math.hypot(me.vx, me.vy).toFixed(1) : '0.0'} m/s`,
    ];
  }

  statusText(): string {
    return 'オフライン（単独）';
  }

  reset(): void {
    this.world.score[0] = 0;
    this.world.score[1] = 0;
    resetPositions(this.world);
    this.peakKick = 0;
  }
}
