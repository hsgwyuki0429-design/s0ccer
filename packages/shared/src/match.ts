import * as C from './constants.ts';
import type { MatchPhase, StepEvents, TeamId, World } from './types.ts';

/**
 * 試合進行の状態遷移。
 *
 * サーバーとクライアントの両方が同じ関数を呼ぶ（step() の一部）。時計や
 * フェーズをサーバーだけで進めると、クライアントの予測と食い違って
 * カウントダウンが飛んだり戻ったりする。
 */

/** チームが守るゴールの側（-1 = 左、+1 = 右）。後半は入れ替わる。 */
export function defendingSide(team: TeamId, sidesSwapped: boolean): -1 | 1 {
  const base = team === 0 ? -1 : 1;
  return (sidesSwapped ? -base : base) as -1 | 1;
}

/** その側のゴールを守っているチーム。 */
export function teamDefending(side: -1 | 1, sidesSwapped: boolean): TeamId {
  return defendingSide(0, sidesSwapped) === side ? 0 : 1;
}

/** そのチームが攻める側のゴールの x 座標。 */
export function attackingGoalX(team: TeamId, sidesSwapped: boolean): number {
  return -defendingSide(team, sidesSwapped) * C.HALF_W;
}

export function otherTeam(team: TeamId): TeamId {
  return team === 0 ? 1 : 0;
}

/** そのフェーズでプレイヤーの入力を受け付けるか。 */
export function acceptsInput(phase: MatchPhase): boolean {
  return phase === 'playing';
}

/** 試合が決着したか（時間制なら後半終了、先取点制なら目標得点到達）。 */
function isDecided(world: World): boolean {
  if (world.config.mode === 'firstTo') {
    return (
      world.score[0] >= world.config.targetScore || world.score[1] >= world.config.targetScore
    );
  }
  return world.half === 2 && world.clock <= 0;
}

/**
 * 試合の時計とフェーズを1ティック進める。
 *
 * 物理の後に呼ぶ。得点はすでに events.goal と world.score に反映されている前提。
 */
export function advanceMatch(
  world: World,
  dt: number,
  events: StepEvents,
  resetPositions: (world: World) => void,
): void {
  const before = world.phase;

  switch (world.phase) {
    case 'countdown': {
      world.phaseTimer -= dt;
      if (world.phaseTimer <= 0) {
        world.phaseTimer = 0;
        world.phase = 'playing';
      }
      break;
    }

    case 'playing': {
      if (world.config.mode === 'time') world.clock = Math.max(0, world.clock - dt);
      else world.clock += dt;

      if (world.restartTimer > 0) {
        world.restartTimer = Math.max(0, world.restartTimer - dt);
        if (world.restartTimer === 0) world.restartTeam = null;
      }

      if (events.goal !== null) {
        // 得点したら位置を戻して仕切り直す。
        resetPositions(world);
        world.restartTeam = null;
        world.restartTimer = 0;
        world.phase = isDecided(world) ? 'finished' : 'countdown';
        world.phaseTimer = world.phase === 'finished' ? C.FINISHED_SECONDS : C.COUNTDOWN_SECONDS;
        break;
      }

      if (world.config.mode === 'time' && world.clock <= 0) {
        if (world.half === 1) {
          world.phase = 'halftime';
          world.phaseTimer = C.HALFTIME_SECONDS;
        } else {
          world.phase = 'finished';
          world.phaseTimer = C.FINISHED_SECONDS;
        }
        resetPositions(world);
        world.restartTeam = null;
        world.restartTimer = 0;
      }
      break;
    }

    case 'halftime': {
      world.phaseTimer -= dt;
      if (world.phaseTimer <= 0) {
        // コートチェンジしてから後半を始める。
        world.sidesSwapped = !world.sidesSwapped;
        world.half = 2;
        world.clock = world.config.halfSeconds;
        resetPositions(world);
        world.phase = 'countdown';
        world.phaseTimer = C.COUNTDOWN_SECONDS;
      }
      break;
    }

    case 'finished': {
      world.phaseTimer -= dt;
      if (world.phaseTimer <= 0) startMatch(world, resetPositions);
      break;
    }
  }

  events.phaseChanged = world.phase === before ? null : world.phase;
}

/** 新しい試合を始める。得点・時計・コートを初期化する。 */
export function startMatch(world: World, resetPositions: (world: World) => void): void {
  world.score = [0, 0];
  world.half = 1;
  world.clock = world.config.mode === 'time' ? world.config.halfSeconds : 0;
  world.sidesSwapped = false;
  world.lastTouch = null;
  world.restartTeam = null;
  world.restartTimer = 0;
  resetPositions(world);
  world.phase = 'countdown';
  world.phaseTimer = C.COUNTDOWN_SECONDS;
}

/** 勝者。引き分けなら null、まだ決着していなければ undefined。 */
export function winner(world: World): TeamId | null | undefined {
  if (world.phase !== 'finished') return undefined;
  if (world.score[0] === world.score[1]) return null;
  return world.score[0] > world.score[1] ? 0 : 1;
}
