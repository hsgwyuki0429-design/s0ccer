import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as C from './constants.ts';
import { attackingGoalX, defendingSide, startMatch, teamDefending, winner } from './match.ts';
import { createPlayer, createWorld, ensureGoalkeepers, resetPositions, step } from './sim.ts';
import { emptyInput, type PlayerInput, type World } from './types.ts';

/**
 * GK と試合進行のテスト。
 *
 * とくに GK は「自陣のゴールエリアにだけ入れる」という非対称な規則なので、
 * 攻守・前後半のどの組み合わせでも正しいことを固定しておく。
 */

function makeWorld(teamSizes: [number, number] = [1, 1]): World {
  const w = createWorld();
  for (const team of [0, 1] as const) {
    for (let i = 0; i < teamSizes[team]; i++) {
      w.players.push(createPlayer(`${team}-${i}`, team));
    }
  }
  resetPositions(w);
  w.phase = 'playing';
  w.phaseTimer = 0;
  return w;
}

function run(world: World, ticks: number, per: Record<string, Partial<PlayerInput>>): void {
  for (let i = 0; i < ticks; i++) {
    const map = new Map<string, PlayerInput>();
    for (const [id, input] of Object.entries(per)) {
      map.set(id, { ...emptyInput(i), ...input });
    }
    step(world, map);
  }
}

// ---------------------------------------------------------------------------
// GK
// ---------------------------------------------------------------------------

test('各チームにちょうど1人の GK が選ばれる', () => {
  const w = makeWorld([3, 3]);
  ensureGoalkeepers(w, () => 0);
  for (const team of [0, 1] as const) {
    const gks = w.players.filter((p) => p.team === team && p.isGk);
    assert.equal(gks.length, 1, `team=${team}`);
  }
});

test('GK が抜けたら残りから選び直される', () => {
  const w = makeWorld([3, 3]);
  ensureGoalkeepers(w, () => 0);
  const gk = w.players.find((p) => p.team === 0 && p.isGk)!;

  w.players.splice(w.players.indexOf(gk), 1);
  ensureGoalkeepers(w, () => 0);

  assert.equal(w.players.filter((p) => p.team === 0 && p.isGk).length, 1);
});

test('GK は自陣のゴールエリアに入れる', () => {
  const w = makeWorld([1, 1]);
  const gk = w.players.find((p) => p.team === 0)!;
  gk.isGk = true;
  // チーム0 は左ゴールを守る。左へ全力で走る。
  gk.x = -14;
  gk.y = 0;

  run(w, 300, { [gk.id]: { moveX: -1 } });

  const distToOwnGoal = Math.hypot(gk.x - -C.HALF_W, gk.y);
  assert.ok(
    distToOwnGoal < C.GOAL_AREA_RADIUS,
    `自陣エリアに入れていない distToOwnGoal=${distToOwnGoal.toFixed(2)}`,
  );
});

test('GK でも相手のゴールエリアには入れない', () => {
  const w = makeWorld([1, 1]);
  const gk = w.players.find((p) => p.team === 0)!;
  gk.isGk = true;
  gk.x = 14;
  gk.y = 0;

  run(w, 300, { [gk.id]: { moveX: 1 } });

  const distToEnemyGoal = Math.hypot(gk.x - C.HALF_W, gk.y);
  assert.ok(
    distToEnemyGoal >= C.GOAL_AREA_RADIUS + C.PLAYER_RADIUS - 1e-6,
    `相手エリアに入れてしまった distToEnemyGoal=${distToEnemyGoal.toFixed(2)}`,
  );
});

test('GK でない選手は自陣のゴールエリアにも入れない', () => {
  const w = makeWorld([1, 1]);
  const field = w.players.find((p) => p.team === 0)!;
  field.isGk = false;
  field.x = -14;
  field.y = 0;

  run(w, 300, { [field.id]: { moveX: -1 } });

  const dist = Math.hypot(field.x - -C.HALF_W, field.y);
  assert.ok(dist >= C.GOAL_AREA_RADIUS + C.PLAYER_RADIUS - 1e-6, `dist=${dist.toFixed(2)}`);
});

test('ボタンで GK を代わると、それまでの GK は通常の選手に戻る', () => {
  const w = makeWorld([3, 3]);
  ensureGoalkeepers(w, () => 0);

  const before = w.players.find((p) => p.team === 0 && p.isGk)!;
  const claimer = w.players.find((p) => p.team === 0 && !p.isGk)!;

  run(w, 1, { [claimer.id]: { claimGk: true } });

  assert.equal(claimer.isGk, true, '押した本人が GK になっていない');
  assert.equal(before.isGk, false, '前の GK が戻っていない');
  // 交代後もチームの GK はちょうど1人。
  assert.equal(w.players.filter((p) => p.team === 0 && p.isGk).length, 1);
  // 相手チームには影響しない。
  assert.equal(w.players.filter((p) => p.team === 1 && p.isGk).length, 1);
});

test('GK 交代はカウントダウン中でも受け付ける', () => {
  const w = makeWorld([2, 2]);
  ensureGoalkeepers(w, () => 0);
  w.phase = 'countdown';
  w.phaseTimer = C.COUNTDOWN_SECONDS;

  const claimer = w.players.find((p) => p.team === 0 && !p.isGk)!;
  run(w, 1, { [claimer.id]: { claimGk: true } });

  assert.equal(claimer.isGk, true);
});

// ---------------------------------------------------------------------------
// 攻守の向き
// ---------------------------------------------------------------------------

test('コートチェンジで守るゴールが入れ替わる', () => {
  assert.equal(defendingSide(0, false), -1);
  assert.equal(defendingSide(1, false), 1);
  assert.equal(defendingSide(0, true), 1);
  assert.equal(defendingSide(1, true), -1);

  assert.equal(attackingGoalX(0, false), C.HALF_W);
  assert.equal(attackingGoalX(0, true), -C.HALF_W);

  assert.equal(teamDefending(-1, false), 0);
  assert.equal(teamDefending(-1, true), 1);
});

test('後半は逆向きのゴールに入れて得点になる', () => {
  const w = makeWorld([1, 1]);
  w.sidesSwapped = true; // 後半：チーム0 は右を守り、左を攻める
  const striker = w.players.find((p) => p.team === 0)!;
  striker.x = -10;
  striker.y = 0;
  w.ball.x = -10.8;
  w.ball.y = 0;

  run(w, 40, { [striker.id]: { kick: true, aimX: -1, aimY: 0 } });
  run(w, 1, { [striker.id]: { kick: false, aimX: -1, aimY: 0 } });
  run(w, 120, {});

  assert.equal(w.score[0], 1, '後半に左ゴールへ入れてもチーム0 の得点にならない');
});

// ---------------------------------------------------------------------------
// 試合進行
// ---------------------------------------------------------------------------

test('カウントダウン中は操作を受け付けない', () => {
  const w = makeWorld([1, 1]);
  w.phase = 'countdown';
  w.phaseTimer = C.COUNTDOWN_SECONDS;
  const p = w.players[0];
  const startX = p.x;

  run(w, 30, { [p.id]: { moveX: 1 } });

  assert.equal(p.x, startX, 'カウントダウン中に動けてしまう');
  assert.ok(w.phaseTimer < C.COUNTDOWN_SECONDS, 'カウントダウンが進んでいない');
});

test('カウントダウンが終わればプレーが始まり、操作できる', () => {
  const w = makeWorld([1, 1]);
  w.phase = 'countdown';
  w.phaseTimer = 0.1;
  const p = w.players[0];
  const startX = p.x;

  run(w, 60, { [p.id]: { moveX: 1 } });

  assert.equal(w.phase, 'playing');
  assert.ok(p.x > startX, '再開後に動けていない');
});

test('得点したらカウントダウンを挟んで再開する', () => {
  const w = makeWorld([1, 1]);
  const striker = w.players.find((p) => p.team === 0)!;
  striker.x = 10;
  striker.y = 0;
  w.ball.x = 10.8;
  w.ball.y = 0;

  run(w, 40, { [striker.id]: { kick: true, aimX: 1, aimY: 0 } });
  run(w, 1, { [striker.id]: { kick: false, aimX: 1, aimY: 0 } });
  run(w, 120, {});

  assert.equal(w.score[0], 1);
  assert.equal(w.phase, 'countdown');
  assert.equal(w.ball.x, 0);
});

test('時間制：前半が終わるとハーフタイムを挟んでコートが入れ替わる', () => {
  const w = makeWorld([1, 1]);
  w.clock = 0.05;

  run(w, 10, {});
  assert.equal(w.phase, 'halftime');
  assert.equal(w.sidesSwapped, false, 'ハーフタイムに入った時点ではまだ入れ替わらない');

  run(w, Math.ceil(C.HALFTIME_SECONDS * 60) + 5, {});
  assert.equal(w.sidesSwapped, true, 'コートチェンジしていない');
  assert.equal(w.half, 2);
  assert.equal(w.clock, w.config.halfSeconds);
  assert.equal(w.phase, 'countdown');
});

test('時間制：後半が終わると試合終了になる', () => {
  const w = makeWorld([1, 1]);
  w.half = 2;
  w.clock = 0.05;
  w.score = [3, 1];

  run(w, 10, {});
  assert.equal(w.phase, 'finished');
  assert.equal(winner(w), 0);
});

test('先取点制：目標得点に到達したら即終了する', () => {
  const w = makeWorld([1, 1]);
  w.config = { mode: 'firstTo', halfSeconds: 180, targetScore: 1 };
  w.clock = 0;

  const striker = w.players.find((p) => p.team === 0)!;
  striker.x = 10;
  striker.y = 0;
  w.ball.x = 10.8;
  w.ball.y = 0;

  run(w, 40, { [striker.id]: { kick: true, aimX: 1, aimY: 0 } });
  run(w, 1, { [striker.id]: { kick: false, aimX: 1, aimY: 0 } });
  run(w, 120, {});

  assert.equal(w.score[0], 1);
  assert.equal(w.phase, 'finished');
  assert.equal(winner(w), 0);
});

test('試合終了後は自動的に次の試合が始まる', () => {
  const w = makeWorld([1, 1]);
  w.phase = 'finished';
  w.phaseTimer = 0.1;
  w.score = [4, 2];
  w.half = 2;
  w.sidesSwapped = true;

  run(w, 30, {});

  assert.deepEqual(w.score, [0, 0]);
  assert.equal(w.half, 1);
  assert.equal(w.sidesSwapped, false);
  assert.equal(w.phase, 'countdown');
});

test('startMatch は引き分けを null で返す', () => {
  const w = makeWorld([1, 1]);
  startMatch(w, resetPositions);
  assert.equal(winner(w), undefined, 'まだ決着していない');
  w.phase = 'finished';
  assert.equal(winner(w), null);
});

// ---------------------------------------------------------------------------
// ライン割れ
// ---------------------------------------------------------------------------

test('サイドラインを割ったら相手ボールで再開し、割った側は触れない', () => {
  const w = makeWorld([1, 1]);
  const kicker = w.players.find((p) => p.team === 0)!;
  kicker.x = 0;
  kicker.y = 10;
  w.ball.x = 0.8;
  w.ball.y = 10;

  // 上方向（-y）へ強く蹴ってサイドラインを割らせる。
  run(w, 40, { [kicker.id]: { kick: true, aimX: 0, aimY: 1 } });
  run(w, 1, { [kicker.id]: { kick: false, aimX: 0, aimY: 1 } });
  run(w, 60, {});

  assert.equal(w.restartTeam, 1, '相手ボールになっていない');
  assert.ok(w.restartTimer > 0);
  // ボールは場内に置き直され、止まっている。
  assert.ok(Math.abs(w.ball.y) <= C.HALF_H, `ball.y=${w.ball.y}`);
  assert.equal(w.ball.vx, 0);
  assert.equal(w.ball.vy, 0);

  // ロック中、割った側（チーム0）が近づいても蹴れない。
  kicker.x = w.ball.x - 0.8;
  kicker.y = w.ball.y;
  kicker.kickCooldown = 0;
  run(w, 20, { [kicker.id]: { kick: true, aimX: 1, aimY: 0 } });
  run(w, 1, { [kicker.id]: { kick: false, aimX: 1, aimY: 0 } });
  assert.equal(Math.hypot(w.ball.vx, w.ball.vy), 0, 'ロック中なのに蹴れてしまった');
});

test('ロックが解ければ誰でも触れるようになる', () => {
  const w = makeWorld([1, 1]);
  w.lastTouch = 0;
  w.restartTeam = 1;
  w.restartTimer = C.RESTART_LOCK_SECONDS;

  const locked = w.players.find((p) => p.team === 0)!;
  locked.x = -0.8;
  locked.y = 0;
  w.ball.x = 0;
  w.ball.y = 0;

  // ロックが切れるまで待つ。
  run(w, Math.ceil(C.RESTART_LOCK_SECONDS * 60) + 5, {});
  assert.equal(w.restartTeam, null);

  locked.kickCooldown = 0;
  run(w, 40, { [locked.id]: { kick: true, aimX: 1, aimY: 0 } });
  run(w, 1, { [locked.id]: { kick: false, aimX: 1, aimY: 0 } });
  assert.ok(Math.hypot(w.ball.vx, w.ball.vy) > 1, 'ロック解除後に蹴れていない');
});

test('決定論: GK 交代と試合進行を含めても結果が一致する', () => {
  const build = (): World => {
    const w = makeWorld([3, 3]);
    ensureGoalkeepers(w, () => 0);
    return w;
  };
  const a = build();
  const b = build();

  for (let i = 0; i < 400; i++) {
    const per: Record<string, Partial<PlayerInput>> = {};
    for (const p of a.players) {
      per[p.id] = {
        moveX: Math.sin(i / 13 + p.id.length),
        moveY: Math.cos(i / 19),
        aimX: 1,
        aimY: 0,
        kick: i % 37 < 20,
        claimGk: i % 121 === 0,
      };
    }
    run(a, 1, per);
    run(b, 1, per);
  }

  assert.deepEqual(a.players, b.players);
  assert.deepEqual(a.ball, b.ball);
  assert.deepEqual(a.score, b.score);
  assert.equal(a.phase, b.phase);
  assert.equal(a.clock, b.clock);
});
