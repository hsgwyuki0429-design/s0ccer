import * as C from './constants.ts';
import { clamp, clampLength, normalize } from './math.ts';
import type { BallState, PlayerInput, PlayerState, StepEvents, TeamId, World } from './types.ts';

/**
 * 決定論シミュレーション。
 *
 * サーバーとクライアント（予測）が **同じ関数** を呼ぶ。ここが両者で分岐すると
 * リコンシリエーションが毎ティック補正を打ち続け、操作感が壊れる。
 *
 * 乱数は一切使わない。同じ world と同じ入力からは必ず同じ結果が出る。
 */

/** ゴールポストの半径。当たり判定にのみ使う。 */
const POST_RADIUS = 0.08;

/** チーム 0 は左ゴール（x = -HALF_W）を守り、右ゴールを攻める。 */
export function attackingGoalX(team: TeamId): number {
  return team === 0 ? C.HALF_W : -C.HALF_W;
}

/**
 * キックの初速。チャージ量と強さの倍率の積で決まる。
 *
 * 乱数は入らない。同じチャージ量・同じ倍率なら必ず同じ初速になる。
 * UI もこの関数で表示するので、画面のゲージと実際の球は常に一致する。
 */
export function kickSpeed(charge: number, power: number): number {
  const t = clamp(charge / C.CHARGE_TIME_MAX, 0, 1) * clamp(power, 0, 1);
  return C.KICK_SPEED_MIN + (C.KICK_SPEED_MAX - C.KICK_SPEED_MIN) * t;
}

/** チャージ中の最大速度。チャージ量に比例して落ちる。 */
export function chargedMaxSpeed(charge: number): number {
  const t = clamp(charge / C.CHARGE_TIME_MAX, 0, 1);
  return C.PLAYER_MAX_SPEED * (1 - C.CHARGE_SPEED_PENALTY * t);
}

export function createWorld(): World {
  return {
    tick: 0,
    players: [],
    ball: { x: 0, y: 0, vx: 0, vy: 0 },
    score: [0, 0],
  };
}

/** チームの人数に応じた縦の間隔（メートル）。 */
const SPAWN_SPACING = 6;
/** キックオフ時にゴールから離す距離（メートル）。 */
const SPAWN_DEPTH = 8;

/**
 * キックオフ位置。チーム人数の中心が y = 0 に来るよう左右対称に並べる。
 *
 * 人数が 1〜3 のどれでも対称になることが重要。人数によって片側に寄ると、
 * 1v1 のときにボールから遠い選手が生まれてしまう。
 */
function spawnPosition(team: TeamId, index: number, teamSize: number): { x: number; y: number } {
  const side = team === 0 ? -1 : 1;
  return {
    x: side * SPAWN_DEPTH,
    y: (index - (teamSize - 1) / 2) * SPAWN_SPACING,
  };
}

/**
 * プレイヤーを生成する。位置は仮置きで、実際のキックオフ配置は
 * 全員を追加したあとに resetPositions() が決める（人数に依存するため）。
 */
export function createPlayer(id: string, team: TeamId): PlayerState {
  const side = team === 0 ? -1 : 1;
  return {
    id,
    team,
    x: side * SPAWN_DEPTH,
    y: 0,
    vx: 0,
    vy: 0,
    facingX: -side,
    facingY: 0,
    charge: 0,
    kickHeld: false,
    kickCooldown: 0,
  };
}

/** キックオフ配置に戻す。得点後とハーフタイムに呼ぶ。 */
export function resetPositions(world: World): void {
  world.ball.x = 0;
  world.ball.y = 0;
  world.ball.vx = 0;
  world.ball.vy = 0;

  const teamSize: Record<number, number> = { 0: 0, 1: 0 };
  for (const p of world.players) teamSize[p.team]++;

  const seen: Record<number, number> = { 0: 0, 1: 0 };
  for (const p of world.players) {
    const index = seen[p.team]++;
    const side = p.team === 0 ? -1 : 1;
    const pos = spawnPosition(p.team, index, teamSize[p.team]);
    p.x = pos.x;
    p.y = pos.y;
    p.vx = 0;
    p.vy = 0;
    p.facingX = -side;
    p.facingY = 0;
    p.charge = 0;
    p.kickHeld = false;
    p.kickCooldown = 0;
  }
}

export function cloneWorld(world: World): World {
  return {
    tick: world.tick,
    players: world.players.map((p) => ({ ...p })),
    ball: { ...world.ball },
    score: [world.score[0], world.score[1]],
  };
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * 1ティック進める。world を破壊的に更新し、そのティックで起きた出来事を返す。
 *
 * @param inputs プレイヤー id -> 入力。欠けているプレイヤーは「入力なし」として扱う。
 */
export function step(world: World, inputs: Map<string, PlayerInput>, dt: number = C.DT): StepEvents {
  const events: StepEvents = { goal: null, kicks: [], wallHit: false };
  const ball = world.ball;

  // --- 1. プレイヤーの移動 ------------------------------------------------
  for (const p of world.players) {
    const input = inputs.get(p.id);
    const move = input ? clampLength({ x: input.moveX, y: input.moveY }, 1) : { x: 0, y: 0 };

    // チャージ中は足が遅くなる。強い球にはそれだけの拘束を伴わせる。
    const maxSpeed = chargedMaxSpeed(p.charge);
    const targetVx = move.x * maxSpeed;
    const targetVy = move.y * maxSpeed;
    const targetSpeed = Math.hypot(targetVx, targetVy);
    const currentSpeed = Math.hypot(p.vx, p.vy);
    // 加速中か減速中かでレートを変える。減速を速くすると切り返しがキビキビする。
    const rate = targetSpeed >= currentSpeed ? C.PLAYER_ACCEL : C.PLAYER_DECEL;

    const dv = clampLength({ x: targetVx - p.vx, y: targetVy - p.vy }, rate * dt);
    p.vx += dv.x;
    p.vy += dv.y;

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    if (Math.hypot(move.x, move.y) > 0.1) {
      const f = normalize({ x: move.x, y: move.y });
      p.facingX = f.x;
      p.facingY = f.y;
    }

    if (p.kickCooldown > 0) p.kickCooldown = Math.max(0, p.kickCooldown - dt);
  }

  // --- 2. プレイヤー同士の衝突 --------------------------------------------
  const minSep = C.PLAYER_RADIUS * 2;
  for (let i = 0; i < world.players.length; i++) {
    for (let j = i + 1; j < world.players.length; j++) {
      const a = world.players[i];
      const b = world.players[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= minSep || d < 1e-9) continue;

      const nx = dx / d;
      const ny = dy / d;
      const overlap = (minSep - d) / 2;
      a.x -= nx * overlap;
      a.y -= ny * overlap;
      b.x += nx * overlap;
      b.y += ny * overlap;

      // 法線方向の速度差だけを打ち消す（等質量、非弾性寄り）。
      const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rel < 0) {
        const impulse = rel * 0.5;
        a.vx += nx * impulse;
        a.vy += ny * impulse;
        b.vx -= nx * impulse;
        b.vy -= ny * impulse;
      }
    }
  }

  // --- 3. ゴールエリアとピッチ境界 ----------------------------------------
  for (const p of world.players) {
    constrainPlayer(p);
  }

  // --- 4. キック ----------------------------------------------------------
  // 「離した瞬間」に発射する。同一ティックに複数人が離した場合は
  // ボールに近いほうを優先する（netcode.md 参照）。
  interface KickCandidate {
    p: PlayerState;
    d: number;
    aimX: number;
    aimY: number;
    charge: number;
    power: number;
  }
  const candidates: KickCandidate[] = [];

  for (const p of world.players) {
    const input = inputs.get(p.id);
    const held = input?.kick ?? false;

    if (held && p.kickCooldown <= 0) {
      p.charge = Math.min(C.CHARGE_TIME_MAX, p.charge + dt);
    }

    const released = p.kickHeld && !held;
    p.kickHeld = held;
    if (!released) continue;

    const chargeAmount = p.charge;
    p.charge = 0;
    if (p.kickCooldown > 0) continue;

    const d = dist(p.x, p.y, ball.x, ball.y);
    if (d > C.CONTROL_RADIUS) continue;

    // 狙いが零ベクトルなら向いている方向へ蹴る。
    let aim = normalize({ x: input?.aimX ?? 0, y: input?.aimY ?? 0 });
    if (aim.x === 0 && aim.y === 0) aim = { x: p.facingX, y: p.facingY };
    if (aim.x === 0 && aim.y === 0) continue;

    candidates.push({
      p,
      d,
      aimX: aim.x,
      aimY: aim.y,
      charge: chargeAmount,
      // 離した瞬間の傾け度で強さが決まる。狙いと同じく、指を離した時点の値。
      power: input?.power ?? 1,
    });
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => a.d - b.d);
    const winner = candidates[0];
    const speed = kickSpeed(winner.charge, winner.power);

    // 加算ではなく代入。同じチャージ・同じ方向なら必ず同じ球が飛ぶことを保証する。
    ball.vx = winner.aimX * speed;
    ball.vy = winner.aimY * speed;
    winner.p.kickCooldown = C.KICK_COOLDOWN;
    events.kicks.push({ playerId: winner.p.id, speed });
  }

  // --- 5. ドリブル --------------------------------------------------------
  // コントロール半径内で最も近い1人だけがボールを操作できる。
  let dribbler: PlayerState | null = null;
  let dribblerDist = Infinity;
  for (const p of world.players) {
    if (p.kickCooldown > 0) continue;
    if (Math.hypot(p.vx, p.vy) < C.DRIBBLE_MIN_SPEED) continue;
    const d = dist(p.x, p.y, ball.x, ball.y);
    if (d <= C.CONTROL_RADIUS && d < dribblerDist) {
      dribbler = p;
      dribblerDist = d;
    }
  }
  if (dribbler) {
    const dir = normalize({ x: dribbler.vx, y: dribbler.vy });
    const targetX = dribbler.x + dir.x * C.DRIBBLE_DISTANCE;
    const targetY = dribbler.y + dir.y * C.DRIBBLE_DISTANCE;
    // 「プレイヤーの速度」＋「目標点へ引き寄せる速度」を狙いの速度とする。
    const desiredVx = dribbler.vx + (targetX - ball.x) * 6;
    const desiredVy = dribbler.vy + (targetY - ball.y) * 6;
    const dv = clampLength(
      { x: desiredVx - ball.vx, y: desiredVy - ball.vy },
      C.DRIBBLE_ACCEL * dt,
    );
    ball.vx += dv.x;
    ball.vy += dv.y;
  }

  // --- 6. ボールの積分と減衰 ----------------------------------------------
  const capped = clampLength({ x: ball.vx, y: ball.vy }, C.BALL_MAX_SPEED);
  ball.vx = capped.x;
  ball.vy = capped.y;

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  const damp = Math.pow(C.BALL_DAMPING, dt);
  ball.vx *= damp;
  ball.vy *= damp;
  if (Math.hypot(ball.vx, ball.vy) < C.BALL_STOP_SPEED) {
    ball.vx = 0;
    ball.vy = 0;
  }

  // --- 7. ボールとプレイヤーの衝突 ----------------------------------------
  const contact = C.PLAYER_RADIUS + C.BALL_RADIUS;
  for (const p of world.players) {
    const dx = ball.x - p.x;
    const dy = ball.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d >= contact || d < 1e-9) continue;

    const nx = dx / d;
    const ny = dy / d;
    // 相対速度が離れる向きなら何もしない。蹴った直後のボールを掴み直さないため。
    const rel = (ball.vx - p.vx) * nx + (ball.vy - p.vy) * ny;
    if (rel >= 0) continue;

    ball.x = p.x + nx * contact;
    ball.y = p.y + ny * contact;

    // コントロールしている本人は反発ゼロ＝トラップ。ボールを殺してから
    // ドリブルで運ぶ。他人の体に当たった場合だけ弾く。
    const restitution = p === dribbler ? 0 : C.PLAYER_BALL_RESTITUTION;

    // プレイヤーの速度を基準に反射させる。走り込めばボールは前へ押される。
    const relVx = ball.vx - p.vx;
    const relVy = ball.vy - p.vy;
    const dot = relVx * nx + relVy * ny;
    ball.vx = p.vx + (relVx - (1 + restitution) * dot * nx);
    ball.vy = p.vy + (relVy - (1 + restitution) * dot * ny);
  }

  // --- 8. ゴールポスト ----------------------------------------------------
  for (const goalX of [-C.HALF_W, C.HALF_W]) {
    for (const postY of [-C.GOAL_WIDTH / 2, C.GOAL_WIDTH / 2]) {
      const dx = ball.x - goalX;
      const dy = ball.y - postY;
      const d = Math.hypot(dx, dy);
      const minDist = POST_RADIUS + C.BALL_RADIUS;
      if (d >= minDist || d < 1e-9) continue;

      const nx = dx / d;
      const ny = dy / d;
      ball.x = goalX + nx * minDist;
      ball.y = postY + ny * minDist;
      const dot = ball.vx * nx + ball.vy * ny;
      if (dot < 0) {
        ball.vx -= (1 + C.BALL_RESTITUTION) * dot * nx;
        ball.vy -= (1 + C.BALL_RESTITUTION) * dot * ny;
        events.wallHit = true;
      }
    }
  }

  // --- 9. ゴール判定とサイドライン ----------------------------------------
  // Phase 1 ではラインを割ったボールは跳ね返す。本来のルールでは相手ボールで
  // リスタート（design.md 参照）。Phase 5 で差し替える。
  // ゴールマウスの内側には壁を置かない。ここに壁があるとボールがゴールラインへ
  // 到達する前に跳ね返され、永遠に得点にならない。
  const inGoalMouth = Math.abs(ball.y) <= C.GOAL_WIDTH / 2;

  if (inGoalMouth && ball.x > C.HALF_W) {
    world.score[0]++;
    events.goal = 0;
  } else if (inGoalMouth && ball.x < -C.HALF_W) {
    world.score[1]++;
    events.goal = 1;
  } else if (!inGoalMouth) {
    // 縦のライン（ゴールライン）
    if (ball.x > C.HALF_W - C.BALL_RADIUS) {
      ball.x = C.HALF_W - C.BALL_RADIUS;
      if (ball.vx > 0) {
        ball.vx = -ball.vx * C.BALL_RESTITUTION;
        events.wallHit = true;
      }
    } else if (ball.x < -C.HALF_W + C.BALL_RADIUS) {
      ball.x = -C.HALF_W + C.BALL_RADIUS;
      if (ball.vx < 0) {
        ball.vx = -ball.vx * C.BALL_RESTITUTION;
        events.wallHit = true;
      }
    }
  }

  // 横のライン（サイドライン）はゴールマウスと無関係に常に有効。
  if (ball.y > C.HALF_H - C.BALL_RADIUS) {
    ball.y = C.HALF_H - C.BALL_RADIUS;
    if (ball.vy > 0) {
      ball.vy = -ball.vy * C.BALL_RESTITUTION;
      events.wallHit = true;
    }
  } else if (ball.y < -C.HALF_H + C.BALL_RADIUS) {
    ball.y = -C.HALF_H + C.BALL_RADIUS;
    if (ball.vy < 0) {
      ball.vy = -ball.vy * C.BALL_RESTITUTION;
      events.wallHit = true;
    }
  }

  if (events.goal !== null) {
    resetPositions(world);
  }

  world.tick++;
  return events;
}

/**
 * プレイヤーをゴールエリアの外・ピッチの内に留める。
 *
 * ワープさせず、境界に沿って滑らせる。壁沿いの移動が引っかからないようにするため。
 */
function constrainPlayer(p: PlayerState): void {
  // ゴールエリア（半円）。GK を置かない代わりの侵入禁止ゾーン。
  for (const goalX of [-C.HALF_W, C.HALF_W]) {
    const dx = p.x - goalX;
    const dy = p.y - 0;
    const d = Math.hypot(dx, dy);
    const minDist = C.GOAL_AREA_RADIUS + C.PLAYER_RADIUS;
    if (d >= minDist) continue;

    const nx = d < 1e-9 ? (goalX > 0 ? -1 : 1) : dx / d;
    const ny = d < 1e-9 ? 0 : dy / d;
    p.x = goalX + nx * minDist;
    p.y = 0 + ny * minDist;

    // 法線方向（＝エリアへ入ろうとする）成分だけ取り除き、接線方向は残す。
    const inward = p.vx * nx + p.vy * ny;
    if (inward < 0) {
      p.vx -= nx * inward;
      p.vy -= ny * inward;
    }
  }

  const limitX = C.HALF_W - C.PLAYER_RADIUS;
  const limitY = C.HALF_H - C.PLAYER_RADIUS;
  if (p.x > limitX) {
    p.x = limitX;
    if (p.vx > 0) p.vx = 0;
  } else if (p.x < -limitX) {
    p.x = -limitX;
    if (p.vx < 0) p.vx = 0;
  }
  if (p.y > limitY) {
    p.y = limitY;
    if (p.vy > 0) p.vy = 0;
  } else if (p.y < -limitY) {
    p.y = -limitY;
    if (p.vy < 0) p.vy = 0;
  }
}

/** ボールがそのプレイヤーのコントロール下にあるか（UI 表示用）。 */
export function hasControl(p: PlayerState, ball: BallState): boolean {
  return dist(p.x, p.y, ball.x, ball.y) <= C.CONTROL_RADIUS;
}
