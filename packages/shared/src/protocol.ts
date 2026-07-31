import * as C from './constants.ts';
import { clamp } from './math.ts';
import type {
  BallState,
  MatchConfig,
  MatchPhase,
  PlayerInput,
  TeamId,
} from './types.ts';

/**
 * ネットワークプロトコル。すべてバイナリ（固定レイアウト）。
 *
 * 差分圧縮はまだ入れていない。6人フルでもスナップショットは 200 バイト弱、
 * 30Hz で 6KB/s 程度なので、実測して問題になってから足せばよい。
 */

export const MSG_WELCOME = 0;
export const MSG_INPUT = 1;
export const MSG_SNAPSHOT = 2;
export const MSG_PING = 3;
export const MSG_PONG = 4;
/** クライアント→サーバー。参加要求。パーティコードを伴う。 */
export const MSG_HELLO = 5;
/** サーバー→クライアント。パーティと部屋の状況。 */
export const MSG_LOBBY = 6;

/** 1パケットに詰める入力の最大数。パケットロスに対する冗長分。 */
export const MAX_INPUTS_PER_PACKET = 10;

/** 部屋の定員。3v3。 */
export const MAX_PLAYERS = 6;

// ---------------------------------------------------------------------------
// 量子化
// ---------------------------------------------------------------------------

/**
 * 入力の各軸を -1..1 の 1/100 刻みに丸める。
 *
 * **クライアントは丸めた値で予測しなければならない。** 送信時にだけ丸めると
 * サーバーとクライアントが違う入力で計算することになり、予測が毎ティック
 * ズレ続ける。sample した直後に quantizeInput() を通すこと。
 */
export function quantizeAxis(v: number): number {
  return Math.round(clamp(v, -1, 1) * 100) / 100;
}

export function quantizeInput(input: PlayerInput): PlayerInput {
  return {
    seq: input.seq,
    moveX: quantizeAxis(input.moveX),
    moveY: quantizeAxis(input.moveY),
    aimX: quantizeAxis(input.aimX),
    aimY: quantizeAxis(input.aimY),
    power: Math.round(clamp(input.power, 0, 1) * 100) / 100,
    kick: input.kick,
    claimGk: input.claimGk,
  };
}

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** スナップショット内の1プレイヤー。 */
export interface SnapshotPlayer {
  slot: number;
  team: TeamId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facingX: number;
  facingY: number;
  charge: number;
  kickHeld: boolean;
  kickCooldown: number;
  isGk: boolean;
  isAi: boolean;
  /**
   * サーバーが最後に処理したこのプレイヤーの入力。
   * クライアントは再シミュレーション中、他プレイヤーがこの入力を保持し続けると
   * 仮定して外挿する。再シミュレーションは数ティックしかないので誤差は小さい。
   */
  input: {
    moveX: number;
    moveY: number;
    aimX: number;
    aimY: number;
    power: number;
    kick: boolean;
    claimGk: boolean;
  };
}

export interface Snapshot {
  serverTick: number;
  /** 受信側クライアントの入力のうち、サーバーが最後に処理したもの。 */
  lastProcessedSeq: number;
  /** サーバー側に溜まっている受信側クライアントの未処理入力数。時計合わせに使う。 */
  queueDepth: number;
  score: [number, number];
  ball: BallState;
  players: SnapshotPlayer[];

  config: MatchConfig;
  phase: MatchPhase;
  phaseTimer: number;
  half: 1 | 2;
  clock: number;
  sidesSwapped: boolean;
  restartTeam: TeamId | null;
  restartTimer: number;
}

/** フェーズの数値表現。バイト1つに収めるための対応表。 */
const PHASES: MatchPhase[] = ['countdown', 'playing', 'halftime', 'finished'];
const MODES: MatchConfig['mode'][] = ['time', 'firstTo'];

export interface Welcome {
  slot: number;
  team: TeamId;
  serverTick: number;
}

export interface LobbyInfo {
  /** 自分のパーティコード。友達に共有すると同じ部屋・同じチームに入れる。 */
  partyCode: string;
  /** パーティの人数。 */
  partySize: number;
  /** 部屋にいる選手の総数（AI 含む）。 */
  roomPlayers: number;
  /** 部屋にいる人間の数。 */
  roomHumans: number;
}

// ---------------------------------------------------------------------------
// エンコード / デコード
// ---------------------------------------------------------------------------

const INPUT_HEADER = 2;
const INPUT_SIZE = 10;

export function encodeInputs(inputs: PlayerInput[]): ArrayBuffer {
  const count = Math.min(inputs.length, MAX_INPUTS_PER_PACKET);
  // 新しいものを優先して詰める。
  const slice = inputs.slice(inputs.length - count);

  const buf = new ArrayBuffer(INPUT_HEADER + INPUT_SIZE * count);
  const view = new DataView(buf);
  view.setUint8(0, MSG_INPUT);
  view.setUint8(1, count);

  for (let i = 0; i < count; i++) {
    const input = slice[i];
    const o = INPUT_HEADER + i * INPUT_SIZE;
    view.setUint32(o, input.seq >>> 0, true);
    view.setInt8(o + 4, Math.round(input.moveX * 100));
    view.setInt8(o + 5, Math.round(input.moveY * 100));
    view.setInt8(o + 6, Math.round(input.aimX * 100));
    view.setInt8(o + 7, Math.round(input.aimY * 100));
    view.setUint8(o + 8, (input.kick ? 1 : 0) | (input.claimGk ? 2 : 0));
    view.setUint8(o + 9, Math.round(clamp(input.power, 0, 1) * 100));
  }
  return buf;
}

export function decodeInputs(view: DataView): PlayerInput[] {
  const count = view.getUint8(1);
  const out: PlayerInput[] = [];
  for (let i = 0; i < count; i++) {
    const o = INPUT_HEADER + i * INPUT_SIZE;
    if (o + INPUT_SIZE > view.byteLength) break;
    out.push({
      seq: view.getUint32(o, true),
      moveX: view.getInt8(o + 4) / 100,
      moveY: view.getInt8(o + 5) / 100,
      aimX: view.getInt8(o + 6) / 100,
      aimY: view.getInt8(o + 7) / 100,
      power: view.getUint8(o + 9) / 100,
      kick: (view.getUint8(o + 8) & 1) !== 0,
      claimGk: (view.getUint8(o + 8) & 2) !== 0,
    });
  }
  return out;
}

/**
 * スナップショットのレイアウト。
 *
 * 0  u8   type
 * 1  u32  serverTick
 * 5  u32  lastProcessedSeq
 * 9  u8   queueDepth
 * 10 u8   scoreA
 * 11 u8   scoreB
 * 12 f32  ball x, y, vx, vy   (12..27)
 * 28 u8   phase
 * 29 u8   half
 * 30 f32  clock
 * 34 f32  phaseTimer
 * 35 u8   flags (bit0 sidesSwapped)
 * 39 u8   restartTeam (0, 1, 255=なし)
 * 40 f32  restartTimer
 * 44 u8   config.mode
 * 45 u16  config.halfSeconds
 * 47 u8   config.targetScore
 * 48 u8   playerCount
 */
const SNAP_HEADER = 49;
const SNAP_PLAYER = 28;

export function encodeSnapshot(s: Snapshot): ArrayBuffer {
  const buf = new ArrayBuffer(SNAP_HEADER + SNAP_PLAYER * s.players.length);
  const view = new DataView(buf);

  view.setUint8(0, MSG_SNAPSHOT);
  view.setUint32(1, s.serverTick >>> 0, true);
  view.setUint32(5, s.lastProcessedSeq >>> 0, true);
  view.setUint8(9, Math.min(255, s.queueDepth));
  view.setUint8(10, Math.min(255, s.score[0]));
  view.setUint8(11, Math.min(255, s.score[1]));
  view.setFloat32(12, s.ball.x, true);
  view.setFloat32(16, s.ball.y, true);
  view.setFloat32(20, s.ball.vx, true);
  view.setFloat32(24, s.ball.vy, true);

  view.setUint8(28, Math.max(0, PHASES.indexOf(s.phase)));
  view.setUint8(29, s.half);
  view.setFloat32(30, s.clock, true);
  view.setFloat32(34, s.phaseTimer, true);
  view.setUint8(38, s.sidesSwapped ? 1 : 0);
  view.setUint8(39, s.restartTeam === null ? 255 : s.restartTeam);
  view.setFloat32(40, s.restartTimer, true);
  view.setUint8(44, Math.max(0, MODES.indexOf(s.config.mode)));
  view.setUint16(45, s.config.halfSeconds, true);
  view.setUint8(47, s.config.targetScore);
  view.setUint8(48, s.players.length);

  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i];
    const o = SNAP_HEADER + i * SNAP_PLAYER;
    view.setUint8(o, p.slot);
    view.setUint8(o + 1, p.team);
    view.setUint8(
      o + 2,
      (p.kickHeld ? 1 : 0) |
        (p.input.kick ? 2 : 0) |
        (p.isGk ? 4 : 0) |
        (p.isAi ? 8 : 0) |
        (p.input.claimGk ? 16 : 0),
    );
    view.setUint8(o + 3, Math.round(clamp(p.charge / C.CHARGE_TIME_MAX, 0, 1) * 255));
    view.setFloat32(o + 4, p.x, true);
    view.setFloat32(o + 8, p.y, true);
    view.setFloat32(o + 12, p.vx, true);
    view.setFloat32(o + 16, p.vy, true);
    view.setInt8(o + 20, Math.round(clamp(p.facingX, -1, 1) * 100));
    view.setInt8(o + 21, Math.round(clamp(p.facingY, -1, 1) * 100));
    view.setUint8(o + 22, Math.min(255, Math.round(p.kickCooldown * 1000)));
    view.setInt8(o + 23, Math.round(p.input.moveX * 100));
    view.setInt8(o + 24, Math.round(p.input.moveY * 100));
    view.setInt8(o + 25, Math.round(p.input.aimX * 100));
    view.setInt8(o + 26, Math.round(p.input.aimY * 100));
    view.setUint8(o + 27, Math.round(clamp(p.input.power, 0, 1) * 100));
  }
  return buf;
}

export function decodeSnapshot(view: DataView): Snapshot {
  const count = view.getUint8(48);
  const players: SnapshotPlayer[] = [];

  for (let i = 0; i < count; i++) {
    const o = SNAP_HEADER + i * SNAP_PLAYER;
    if (o + SNAP_PLAYER > view.byteLength) break;
    const flags = view.getUint8(o + 2);
    players.push({
      slot: view.getUint8(o),
      team: view.getUint8(o + 1) === 0 ? 0 : 1,
      kickHeld: (flags & 1) !== 0,
      isGk: (flags & 4) !== 0,
      isAi: (flags & 8) !== 0,
      charge: (view.getUint8(o + 3) / 255) * C.CHARGE_TIME_MAX,
      x: view.getFloat32(o + 4, true),
      y: view.getFloat32(o + 8, true),
      vx: view.getFloat32(o + 12, true),
      vy: view.getFloat32(o + 16, true),
      facingX: view.getInt8(o + 20) / 100,
      facingY: view.getInt8(o + 21) / 100,
      kickCooldown: view.getUint8(o + 22) / 1000,
      input: {
        moveX: view.getInt8(o + 23) / 100,
        moveY: view.getInt8(o + 24) / 100,
        aimX: view.getInt8(o + 25) / 100,
        aimY: view.getInt8(o + 26) / 100,
        power: view.getUint8(o + 27) / 100,
        kick: (flags & 2) !== 0,
        claimGk: (flags & 16) !== 0,
      },
    });
  }

  const restartTeamRaw = view.getUint8(39);

  return {
    serverTick: view.getUint32(1, true),
    lastProcessedSeq: view.getUint32(5, true),
    queueDepth: view.getUint8(9),
    score: [view.getUint8(10), view.getUint8(11)],
    ball: {
      x: view.getFloat32(12, true),
      y: view.getFloat32(16, true),
      vx: view.getFloat32(20, true),
      vy: view.getFloat32(24, true),
    },
    players,
    phase: PHASES[view.getUint8(28)] ?? 'playing',
    half: view.getUint8(29) === 2 ? 2 : 1,
    clock: view.getFloat32(30, true),
    phaseTimer: view.getFloat32(34, true),
    sidesSwapped: view.getUint8(38) !== 0,
    restartTeam: restartTeamRaw === 255 ? null : restartTeamRaw === 0 ? 0 : 1,
    restartTimer: view.getFloat32(40, true),
    config: {
      mode: MODES[view.getUint8(44)] ?? 'time',
      halfSeconds: view.getUint16(45, true),
      targetScore: view.getUint8(47),
    },
  };
}

export function encodeWelcome(w: Welcome): ArrayBuffer {
  const buf = new ArrayBuffer(7);
  const view = new DataView(buf);
  view.setUint8(0, MSG_WELCOME);
  view.setUint8(1, w.slot);
  view.setUint8(2, w.team);
  view.setUint32(3, w.serverTick >>> 0, true);
  return buf;
}

export function decodeWelcome(view: DataView): Welcome {
  return {
    slot: view.getUint8(1),
    team: view.getUint8(2) === 0 ? 0 : 1,
    serverTick: view.getUint32(3, true),
  };
}

export function encodePingPong(type: number, id: number): ArrayBuffer {
  const buf = new ArrayBuffer(5);
  const view = new DataView(buf);
  view.setUint8(0, type);
  view.setUint32(1, id >>> 0, true);
  return buf;
}

export function decodePingPongId(view: DataView): number {
  return view.getUint32(1, true);
}

// ---------------------------------------------------------------------------
// ロビー
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** 参加要求。パーティコードは空文字なら「新規に作ってほしい」を意味する。 */
export function encodeHello(partyCode: string): ArrayBuffer {
  const code = textEncoder.encode(partyCode.slice(0, 16));
  const buf = new ArrayBuffer(2 + code.length);
  const view = new DataView(buf);
  view.setUint8(0, MSG_HELLO);
  view.setUint8(1, code.length);
  new Uint8Array(buf, 2).set(code);
  return buf;
}

export function decodeHello(view: DataView): string {
  const len = view.getUint8(1);
  if (2 + len > view.byteLength) return '';
  return textDecoder.decode(new Uint8Array(view.buffer, view.byteOffset + 2, len));
}

export function encodeLobby(info: LobbyInfo): ArrayBuffer {
  const code = textEncoder.encode(info.partyCode.slice(0, 16));
  const buf = new ArrayBuffer(5 + code.length);
  const view = new DataView(buf);
  view.setUint8(0, MSG_LOBBY);
  view.setUint8(1, info.partySize);
  view.setUint8(2, info.roomPlayers);
  view.setUint8(3, info.roomHumans);
  view.setUint8(4, code.length);
  new Uint8Array(buf, 5).set(code);
  return buf;
}

export function decodeLobby(view: DataView): LobbyInfo {
  const len = view.getUint8(4);
  const partyCode =
    5 + len <= view.byteLength
      ? textDecoder.decode(new Uint8Array(view.buffer, view.byteOffset + 5, len))
      : '';
  return {
    partySize: view.getUint8(1),
    roomPlayers: view.getUint8(2),
    roomHumans: view.getUint8(3),
    partyCode,
  };
}
