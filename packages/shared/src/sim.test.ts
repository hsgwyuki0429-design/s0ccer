import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as C from './constants.ts';
import { cloneWorld, createPlayer, createWorld, resetPositions, step } from './sim.ts';
import { emptyInput, type PlayerInput, type World } from './types.ts';

/**
 * シミュレーションのテスト。
 *
 * ここが守っているのは主に2点:
 *   - 決定論（クライアント予測がサーバーと一致する前提条件）
 *   - キックの再現性（「同じ操作なら同じ球」というゲームの約束）
 */

/**
 * 物理のテストは常にプレー中の状態から始める。
 * createWorld() はカウントダウンから始まり、その間は入力を受け付けない。
 */
function beginPlay(w: World): World {
  w.phase = 'playing';
  w.phaseTimer = 0;
  w.clock = w.config.halfSeconds;
  return w;
}

function worldWithPlayer(x: number, y: number, ballX: number, ballY: number): World {
  const w = beginPlay(createWorld());
  const p = createPlayer('p1', 0);
  p.x = x;
  p.y = y;
  p.facingX = 1;
  p.facingY = 0;
  w.players.push(p);
  w.ball.x = ballX;
  w.ball.y = ballY;
  return w;
}

function run(world: World, ticks: number, input: Partial<PlayerInput>, id = 'p1'): void {
  for (let i = 0; i < ticks; i++) {
    step(world, new Map([[id, { ...emptyInput(i), ...input }]]));
  }
}

test('決定論: 同じ初期状態と同じ入力なら結果が完全に一致する', () => {
  const a = worldWithPlayer(-5, 2, -3, 1);
  const b = cloneWorld(a);

  const inputs: Partial<PlayerInput>[] = [];
  for (let i = 0; i < 240; i++) {
    // 周期的に変化する入力で、加速・減速・キックをひととおり通す。
    inputs.push({
      moveX: Math.sin(i / 17),
      moveY: Math.cos(i / 23),
      aimX: 1,
      aimY: 0,
      kick: i % 40 < 25,
    });
  }
  for (const input of inputs) {
    step(a, new Map([['p1', { ...emptyInput(0), ...input }]]));
    step(b, new Map([['p1', { ...emptyInput(0), ...input }]]));
  }

  assert.deepEqual(a.ball, b.ball);
  assert.deepEqual(a.players, b.players);
  assert.deepEqual(a.score, b.score);
});

test('キックの再現性: 同じチャージ量・同じ方向なら初速が完全に一致する', () => {
  const speeds: number[] = [];
  for (let trial = 0; trial < 2; trial++) {
    const w = worldWithPlayer(0, 0, 0.8, 0);
    // 静止したままフルチャージし、+x へ蹴る。
    run(w, 40, { kick: true, aimX: 1, aimY: 0 });
    step(w, new Map([['p1', { ...emptyInput(0), kick: false, aimX: 1, aimY: 0 }]]));
    speeds.push(Math.hypot(w.ball.vx, w.ball.vy));
  }
  assert.equal(speeds[0], speeds[1]);
  // フルチャージなら最大速度が出る（減衰1ティック分だけ差し引かれる）。
  assert.ok(speeds[0] > C.KICK_SPEED_MAX * 0.95, `speed=${speeds[0]}`);
});

test('チャージ量に応じてキック速度が単調に増える', () => {
  const measure = (chargeTicks: number): number => {
    const w = worldWithPlayer(0, 0, 0.8, 0);
    run(w, chargeTicks, { kick: true, aimX: 1, aimY: 0 });
    step(w, new Map([['p1', { ...emptyInput(0), kick: false, aimX: 1, aimY: 0 }]]));
    return Math.hypot(w.ball.vx, w.ball.vy);
  };
  const short = measure(2);
  const mid = measure(18);
  const full = measure(40);
  assert.ok(short < mid, `${short} < ${mid}`);
  assert.ok(mid < full, `${mid} < ${full}`);
});

test('チャージ中は足が遅くなり、離すと元の速度に戻る', () => {
  const measureTopSpeed = (input: Partial<PlayerInput>): number => {
    const w = worldWithPlayer(-20, 10, 30, 30);
    run(w, 200, { moveX: 1, moveY: 0, ...input });
    return Math.hypot(w.players[0].vx, w.players[0].vy);
  };

  const free = measureTopSpeed({});
  const charging = measureTopSpeed({ kick: true, aimX: 1, aimY: 0 });

  assert.ok(free > C.PLAYER_MAX_SPEED - 1e-6, `free=${free}`);
  // フルチャージぶんきっちり落ちる。
  const expected = C.PLAYER_MAX_SPEED * (1 - C.CHARGE_SPEED_PENALTY);
  assert.ok(Math.abs(charging - expected) < 0.05, `charging=${charging} expected=${expected}`);
});

test('減速はチャージ量に比例する（軽いパスではほとんど落ちない）', () => {
  const w = worldWithPlayer(-20, 10, 30, 30);
  // まず最高速まで走ってからチャージし始める。
  run(w, 120, { moveX: 1, moveY: 0 });
  run(w, 3, { moveX: 1, moveY: 0, kick: true, aimX: 1, aimY: 0 });
  const barelyCharged = Math.hypot(w.players[0].vx, w.players[0].vy);

  run(w, 120, { moveX: 1, moveY: 0, kick: true, aimX: 1, aimY: 0 });
  const fullyCharged = Math.hypot(w.players[0].vx, w.players[0].vy);

  assert.ok(barelyCharged > C.PLAYER_MAX_SPEED * 0.95, `barely=${barelyCharged}`);
  assert.ok(fullyCharged < barelyCharged, `${fullyCharged} < ${barelyCharged}`);
});

test('傾け度を下げるとフルチャージでも弱い球が飛ぶ', () => {
  const measure = (power: number): number => {
    const w = worldWithPlayer(0, 0, 0.8, 0);
    run(w, 40, { kick: true, aimX: 1, aimY: 0, power });
    step(w, new Map([['p1', { ...emptyInput(0), kick: false, aimX: 1, aimY: 0, power }]]));
    return Math.hypot(w.ball.vx, w.ball.vy);
  };

  const soft = measure(0.15);
  const half = measure(0.5);
  const full = measure(1);

  assert.ok(soft < half, `${soft} < ${half}`);
  assert.ok(half < full, `${half} < ${full}`);
  // 倍率を絞っても下限（＝軽いタップ相当）は下回らない。
  assert.ok(soft >= C.KICK_SPEED_MIN * 0.95, `soft=${soft}`);
  // 倍率1のときは従来どおり最大まで出る。
  assert.ok(full > C.KICK_SPEED_MAX * 0.95, `full=${full}`);
});

test('同じチャージ量・同じ傾け度なら初速が完全に一致する', () => {
  const measure = (): number => {
    const w = worldWithPlayer(0, 0, 0.8, 0);
    run(w, 25, { kick: true, aimX: 1, aimY: 0, power: 0.37 });
    step(w, new Map([['p1', { ...emptyInput(0), kick: false, aimX: 1, aimY: 0, power: 0.37 }]]));
    return Math.hypot(w.ball.vx, w.ball.vy);
  };
  assert.equal(measure(), measure());
});

test('ゴールエリアにプレイヤーは侵入できない', () => {
  const w = worldWithPlayer(15, 0, -20, 0);
  // 右ゴールへ向かって全力で走り続ける。
  run(w, 300, { moveX: 1, moveY: 0 });

  const p = w.players[0];
  const distToGoal = Math.hypot(p.x - C.HALF_W, p.y);
  const minDist = C.GOAL_AREA_RADIUS + C.PLAYER_RADIUS;
  assert.ok(distToGoal >= minDist - 1e-6, `distToGoal=${distToGoal} minDist=${minDist}`);
});

test('ゴールエリアの縁は滑って通れる（引っかからない）', () => {
  // 斜めに走り込んでも、境界に沿って移動し続けられること。
  const w = worldWithPlayer(18, -1, -20, 0);
  run(w, 60, { moveX: 1, moveY: 0 });
  const yBefore = w.players[0].y;
  run(w, 60, { moveX: 1, moveY: 0 });
  const yAfter = w.players[0].y;
  // 法線方向に押し出されるので、y は 0 から離れる向きに動き続ける。
  assert.ok(Math.abs(yAfter) > Math.abs(yBefore), `${yBefore} -> ${yAfter}`);
});

test('ボールはゴールに入ると得点になる', () => {
  const w = worldWithPlayer(10, 0, 10.8, 0);
  run(w, 40, { kick: true, aimX: 1, aimY: 0 });
  step(w, new Map([['p1', { ...emptyInput(0), kick: false, aimX: 1, aimY: 0 }]]));
  // ボールが飛んでいく間は入力なし。
  run(w, 120, {});

  assert.equal(w.score[0], 1);
  assert.equal(w.score[1], 0);
  // 得点後はキックオフ配置に戻る。
  assert.equal(w.ball.x, 0);
  assert.equal(w.ball.y, 0);
});

test('ゴールの外側に飛んだボールは得点にならず跳ね返る', () => {
  const w = worldWithPlayer(10, 8, 10.8, 8);
  run(w, 40, { kick: true, aimX: 1, aimY: 0 });
  step(w, new Map([['p1', { ...emptyInput(0), kick: false, aimX: 1, aimY: 0 }]]));
  run(w, 120, {});

  assert.equal(w.score[0], 0);
  assert.ok(w.ball.x <= C.HALF_W, `ball.x=${w.ball.x}`);
});

test('ボールはピッチの外に出ない', () => {
  const w = worldWithPlayer(0, 0, 0.8, 0);
  // いろいろな方向へ蹴って、どれも外に出ないことを確認する。
  for (const [ax, ay] of [
    [1, 1],
    [-1, 1],
    [0.3, -1],
    [-0.2, -1],
  ]) {
    w.ball.x = 0;
    w.ball.y = 0;
    w.ball.vx = 0;
    w.ball.vy = 0;
    w.players[0].x = -0.8;
    w.players[0].y = 0;
    w.players[0].kickCooldown = 0;

    run(w, 40, { kick: true, aimX: ax, aimY: ay });
    step(w, new Map([['p1', { ...emptyInput(0), kick: false, aimX: ax, aimY: ay }]]));
    run(w, 200, {});

    assert.ok(Math.abs(w.ball.x) <= C.HALF_W + 1e-6, `ball.x=${w.ball.x}`);
    assert.ok(Math.abs(w.ball.y) <= C.HALF_H + 1e-6, `ball.y=${w.ball.y}`);
  }
});

test('ボールは転がって必ず停止する', () => {
  const w = worldWithPlayer(-20, 10, 0, 0);
  w.ball.vx = 12;
  w.ball.vy = 3;
  run(w, 60 * 20, {});
  assert.equal(w.ball.vx, 0);
  assert.equal(w.ball.vy, 0);
});

test('走ってボールに追いつくと、ボールが手元に残る', () => {
  // 止まっているボールへ全力で走り込む。体に当たって弾き飛ばされたまま
  // 追いつけなくなる（＝コントロール圏外に逃げる）ことがあってはならない。
  const w = worldWithPlayer(-14, 0, -10, 0);
  run(w, 150, { moveX: 1, moveY: 0 });

  const p = w.players[0];
  const d = Math.hypot(p.x - w.ball.x, p.y - w.ball.y);
  assert.ok(d <= C.CONTROL_RADIUS + 1e-6, `距離=${d.toFixed(2)}m`);
});

test('ドリブルでボールが進行方向へ運ばれる', () => {
  const w = worldWithPlayer(-10, 0, -9.2, 0);
  run(w, 90, { moveX: 1, moveY: 0 });

  const p = w.players[0];
  // ボールはプレイヤーより前方にあり、一緒に移動している。
  assert.ok(w.ball.x > p.x, `ball.x=${w.ball.x} player.x=${p.x}`);
  assert.ok(w.ball.x > -6, `ball.x=${w.ball.x}`);
  assert.ok(Math.hypot(p.x - w.ball.x, p.y - w.ball.y) <= C.CONTROL_RADIUS + 1e-6);
});

test('同一ティックに2人が離したらボールに近いほうが勝つ', () => {
  const w = beginPlay(createWorld());
  const near = createPlayer('near', 0);
  near.x = -0.7;
  near.y = 0;
  const far = createPlayer('far', 1);
  far.x = 0;
  far.y = 1.1;
  w.players.push(near, far);
  w.ball.x = 0;
  w.ball.y = 0;

  const hold = (id: string, aimX: number, aimY: number, kick: boolean): [string, PlayerInput] => [
    id,
    { ...emptyInput(0), aimX, aimY, kick },
  ];

  for (let i = 0; i < 40; i++) {
    step(w, new Map([hold('near', 1, 0, true), hold('far', 0, -1, true)]));
  }
  step(w, new Map([hold('near', 1, 0, false), hold('far', 0, -1, false)]));

  // 近い near の狙い（+x）が通っているはず。
  assert.ok(w.ball.vx > 5, `vx=${w.ball.vx}`);
  assert.ok(Math.abs(w.ball.vy) < 1, `vy=${w.ball.vy}`);
});

test('コントロール半径の外ではキックできない', () => {
  const w = worldWithPlayer(0, 0, C.CONTROL_RADIUS + 1.0, 0);
  run(w, 40, { kick: true, aimX: 1, aimY: 0 });
  step(w, new Map([['p1', { ...emptyInput(0), kick: false, aimX: 1, aimY: 0 }]]));
  assert.equal(w.ball.vx, 0);
  assert.equal(w.ball.vy, 0);
});

test('キックオフ配置は人数によらず左右対称になる', () => {
  for (const size of [1, 2, 3]) {
    const w = createWorld();
    for (let i = 0; i < size; i++) {
      w.players.push(createPlayer(`a${i}`, 0));
      w.players.push(createPlayer(`b${i}`, 1));
    }
    resetPositions(w);

    for (const team of [0, 1] as const) {
      const ys = w.players.filter((p) => p.team === team).map((p) => p.y);
      const sum = ys.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum) < 1e-9, `team=${team} size=${size} ys=${ys.join(',')}`);
    }
    // 両チームは互いに反対側に並ぶ。
    assert.ok(w.players.filter((p) => p.team === 0).every((p) => p.x < 0));
    assert.ok(w.players.filter((p) => p.team === 1).every((p) => p.x > 0));
  }
});

test('プレイヤーは最大速度を超えない', () => {
  const w = worldWithPlayer(0, 0, 30, 30);
  run(w, 300, { moveX: 1, moveY: 1 });
  const p = w.players[0];
  assert.ok(Math.hypot(p.vx, p.vy) <= C.PLAYER_MAX_SPEED + 1e-6);
});
