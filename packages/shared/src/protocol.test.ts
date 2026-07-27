import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as C from './constants.ts';
import {
  MSG_INPUT,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  decodeInputs,
  decodeSnapshot,
  decodeWelcome,
  encodeInputs,
  encodeSnapshot,
  encodeWelcome,
  quantizeInput,
  type Snapshot,
} from './protocol.ts';
import { emptyInput, type PlayerInput } from './types.ts';

/**
 * プロトコルのテスト。
 *
 * 一番大事なのは「量子化した入力が往復しても変わらない」こと。ここが崩れると
 * サーバーとクライアントが別々の入力で計算し、予測が毎ティックずれ続ける。
 */

test('量子化した入力はエンコード・デコードしても一致する', () => {
  const inputs: PlayerInput[] = [];
  for (let i = 0; i < 5; i++) {
    inputs.push(
      quantizeInput({
        seq: 1000 + i,
        moveX: Math.sin(i),
        moveY: Math.cos(i * 2),
        aimX: Math.sin(i * 3),
        aimY: Math.cos(i),
        kick: i % 2 === 0,
      }),
    );
  }

  const view = new DataView(encodeInputs(inputs));
  assert.equal(view.getUint8(0), MSG_INPUT);
  const decoded = decodeInputs(view);

  assert.equal(decoded.length, inputs.length);
  for (let i = 0; i < inputs.length; i++) {
    assert.deepEqual(decoded[i], inputs[i]);
  }
});

test('量子化は冪等（二度かけても変わらない）', () => {
  const once = quantizeInput({ ...emptyInput(7), moveX: 0.123456, aimY: -0.98765 });
  const twice = quantizeInput(once);
  assert.deepEqual(twice, once);
});

test('入力は1パケットの上限を超えると新しいものが残る', () => {
  const inputs = Array.from({ length: 30 }, (_, i) => emptyInput(i));
  const decoded = decodeInputs(new DataView(encodeInputs(inputs)));
  assert.ok(decoded.length <= 10);
  // 末尾（最新）が残っていること。
  assert.equal(decoded[decoded.length - 1].seq, 29);
});

test('スナップショットが往復しても位置と速度が保たれる', () => {
  const snapshot: Snapshot = {
    serverTick: 123456,
    lastProcessedSeq: 654321,
    queueDepth: 3,
    score: [2, 5],
    ball: { x: -12.25, y: 7.5, vx: 18.75, vy: -3.5 },
    players: [
      {
        slot: 0,
        team: 0,
        x: -8.5,
        y: 3.25,
        vx: 6.5,
        vy: -1.25,
        facingX: 0.6,
        facingY: -0.8,
        charge: C.CHARGE_TIME_MAX,
        kickHeld: true,
        kickCooldown: 0.22,
        input: { moveX: 0.5, moveY: -0.25, aimX: 1, aimY: 0, kick: true },
      },
      {
        slot: 4,
        team: 1,
        x: 11,
        y: -6,
        vx: 0,
        vy: 0,
        facingX: -1,
        facingY: 0,
        charge: 0,
        kickHeld: false,
        kickCooldown: 0,
        input: { moveX: 0, moveY: 0, aimX: -1, aimY: 0, kick: false },
      },
    ],
  };

  const view = new DataView(encodeSnapshot(snapshot));
  assert.equal(view.getUint8(0), MSG_SNAPSHOT);
  const decoded = decodeSnapshot(view);

  assert.equal(decoded.serverTick, snapshot.serverTick);
  assert.equal(decoded.lastProcessedSeq, snapshot.lastProcessedSeq);
  assert.equal(decoded.queueDepth, snapshot.queueDepth);
  assert.deepEqual(decoded.score, snapshot.score);
  // 位置と速度は f32 なので、この程度の値なら完全一致する。
  assert.deepEqual(decoded.ball, snapshot.ball);

  assert.equal(decoded.players.length, 2);
  for (let i = 0; i < 2; i++) {
    const a = decoded.players[i];
    const b = snapshot.players[i];
    assert.equal(a.slot, b.slot);
    assert.equal(a.team, b.team);
    assert.equal(a.x, b.x);
    assert.equal(a.y, b.y);
    assert.equal(a.vx, b.vx);
    assert.equal(a.vy, b.vy);
    assert.equal(a.kickHeld, b.kickHeld);
    assert.deepEqual(a.input, b.input);
    assert.ok(Math.abs(a.facingX - b.facingX) < 0.011);
    assert.ok(Math.abs(a.charge - b.charge) < 0.01);
    assert.ok(Math.abs(a.kickCooldown - b.kickCooldown) < 0.002);
  }
});

test('welcome が往復する', () => {
  const view = new DataView(encodeWelcome({ slot: 5, team: 1, serverTick: 98765 }));
  assert.equal(view.getUint8(0), MSG_WELCOME);
  assert.deepEqual(decodeWelcome(view), { slot: 5, team: 1, serverTick: 98765 });
});
