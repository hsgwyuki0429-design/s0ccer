import * as C from '../../shared/src/constants.ts';
import { attackingGoalX, defendingSide } from '../../shared/src/match.ts';
import { clamp, normalize } from '../../shared/src/math.ts';
import { emptyInput, type PlayerInput, type PlayerState, type World } from '../../shared/src/types.ts';

/**
 * AI プレイヤー。
 *
 * **AI は PlayerInput しか出せない。** 位置を直接書き換えたり、人間より速く
 * 動いたりはできない。人間と完全に同じ物理・同じ上限で動き、違うのは
 * 判断ロジックだけ。design.md の「AI と人間は同一パラメータ」を構造で保証する。
 *
 * サーバー側でのみ動く。出力した入力はスナップショットに載るので、
 * クライアントは人間と同じように外挿できる。
 */

/** ボールにこれより近ければ「自分が追う」と判断する。 */
const CHASE_MARGIN = 0.5;
/** GK がゴール前で保つ距離（メートル）。 */
const GK_DEPTH = 3.2;
/** シュートを狙う距離。これより遠ければドリブルで詰める。 */
const SHOOT_RANGE = 18;
/** 味方との重なりを避けるために離れる距離。 */
const SPREAD = 5;

/** AI ごとに持ち越す状態。世界には入れない（決定論の対象外）。 */
export interface AiState {
  /** チャージを開始してからの経過秒。0 なら非チャージ。 */
  charging: number;
  /** 目標のチャージ量（秒）。ここに達したら離す。 */
  targetCharge: number;
  /** 狙い。チャージ開始時に固定して、ブレないようにする。 */
  aimX: number;
  aimY: number;
  power: number;
}

export function createAiState(): AiState {
  return { charging: 0, targetCharge: 0, aimX: 1, aimY: 0, power: 1 };
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** ボールに最も近い味方が自分かどうか。 */
function isClosestOnTeam(world: World, me: PlayerState): boolean {
  const myDist = distance(me.x, me.y, world.ball.x, world.ball.y);
  for (const p of world.players) {
    if (p.team !== me.team || p.id === me.id) continue;
    if (p.isGk) continue;
    if (distance(p.x, p.y, world.ball.x, world.ball.y) < myDist - CHASE_MARGIN) return false;
  }
  return true;
}

/** 目標地点へ向かう移動ベクトル。近づいたら減速する。 */
function moveToward(me: PlayerState, tx: number, ty: number): { x: number; y: number } {
  const dx = tx - me.x;
  const dy = ty - me.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.25) return { x: 0, y: 0 };
  const dir = normalize({ x: dx, y: dy });
  // 目標の手前で緩めることで、行き過ぎて往復するのを防ぐ。
  const throttle = clamp(d / 2, 0.25, 1);
  return { x: dir.x * throttle, y: dir.y * throttle };
}

/** GK の立ち位置。ボールとゴール中心を結ぶ線上に構える。 */
function goalkeeperTarget(world: World, me: PlayerState): { x: number; y: number } {
  const side = defendingSide(me.team, world.sidesSwapped);
  const goalX = side * C.HALF_W;
  const toBall = normalize({ x: world.ball.x - goalX, y: world.ball.y });
  if (toBall.x === 0 && toBall.y === 0) return { x: goalX - side * GK_DEPTH, y: 0 };

  // ゴールマウスの幅に収まる範囲で、ボール方向へ出る。
  return {
    x: goalX + toBall.x * GK_DEPTH,
    y: clamp(toBall.y * GK_DEPTH, -C.GOAL_WIDTH, C.GOAL_WIDTH),
  };
}

/**
 * 1ティック分の AI の入力を決める。
 *
 * @param state この AI が持ち越す状態。関数内で更新される。
 */
export function aiInput(world: World, me: PlayerState, state: AiState, seq: number): PlayerInput {
  const input = emptyInput(seq);
  const ball = world.ball;
  const goalX = attackingGoalX(me.team, world.sidesSwapped);
  const ballDist = distance(me.x, me.y, ball.x, ball.y);
  const inControl = ballDist <= C.CONTROL_RADIUS;

  // --- チャージ中ならその継続だけを考える -------------------------------
  if (state.charging > 0) {
    state.charging += C.DT;
    input.aimX = state.aimX;
    input.aimY = state.aimY;
    input.power = state.power;

    // ボールを失った、または目標チャージに達したら離す。
    if (!inControl || state.charging >= state.targetCharge) {
      state.charging = 0;
      input.kick = false;
    } else {
      input.kick = true;
    }
    // 蹴るあいだもボールへ体を寄せておく。
    const m = moveToward(me, ball.x, ball.y);
    input.moveX = m.x;
    input.moveY = m.y;
    return input;
  }

  // --- 立ち位置 ----------------------------------------------------------
  const chasing = me.isGk
    ? // GK も、ボールが自陣エリアの近くまで来たら出る。
      distance(me.x, me.y, ball.x, ball.y) < C.GOAL_AREA_RADIUS + 2
    : isClosestOnTeam(world, me);

  let target: { x: number; y: number };
  if (me.isGk && !chasing) {
    target = goalkeeperTarget(world, me);
  } else if (chasing) {
    // ボールの「ゴールと反対側」に回り込む。そのまま押せば前進する形。
    const behind = normalize({ x: ball.x - goalX, y: ball.y - 0 });
    target = {
      x: ball.x + behind.x * C.DRIBBLE_DISTANCE * 0.8,
      y: ball.y + behind.y * C.DRIBBLE_DISTANCE * 0.8,
    };
  } else {
    // 追わない選手は、ボールより少し前で幅を取る。
    const spreadDir = me.y >= ball.y ? 1 : -1;
    target = {
      x: (ball.x + goalX) / 2,
      y: clamp(ball.y + spreadDir * SPREAD, -C.HALF_H + 2, C.HALF_H - 2),
    };
  }

  const move = moveToward(me, target.x, target.y);
  input.moveX = move.x;
  input.moveY = move.y;

  // --- 蹴るかどうか ------------------------------------------------------
  if (!inControl || me.kickCooldown > 0) return input;

  const goalDist = Math.abs(goalX - me.x);
  const aim = normalize({ x: goalX - ball.x, y: 0 - ball.y });
  if (aim.x === 0 && aim.y === 0) return input;

  // ゴールが射程内ならシュート、遠ければ軽く前へ運ぶ。
  const shooting = goalDist <= SHOOT_RANGE;
  state.aimX = aim.x;
  state.aimY = aim.y;
  state.power = 1;
  // 距離に応じたチャージ量。届かない球を撃たないよう、必要な初速から逆算する。
  const wanted = shooting ? C.KICK_SPEED_MAX : clamp(goalDist * 0.9, 12, C.KICK_SPEED_MAX);
  state.targetCharge = solveCharge(wanted);
  state.charging = C.DT;
  input.kick = true;
  input.aimX = aim.x;
  input.aimY = aim.y;
  return input;
}

/** 目標の初速を出すために必要なチャージ秒。kickSpeed() の逆算。 */
function solveCharge(wantedSpeed: number): number {
  const t = clamp(
    (wantedSpeed - C.KICK_SPEED_MIN) / (C.KICK_SPEED_MAX - C.KICK_SPEED_MIN),
    0,
    1,
  );
  const charge = t * C.CHARGE_TIME_MAX;
  // 逆算が正しいことを前提にしすぎないよう、最低1ティックは押す。
  return Math.max(C.DT, charge);
}
