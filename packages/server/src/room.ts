import type { WebSocket } from 'ws';

import { startMatch } from '../../shared/src/match.ts';
import {
  MAX_PLAYERS,
  encodeSnapshot,
  encodeWelcome,
  type Snapshot,
  type SnapshotPlayer,
} from '../../shared/src/protocol.ts';
import {
  createPlayer,
  createWorld,
  ensureGoalkeepers,
  resetPositions,
  step,
} from '../../shared/src/sim.ts';
import { emptyInput, type PlayerInput, type TeamId, type World } from '../../shared/src/types.ts';
import { aiInput, createAiState, type AiState } from './ai.ts';

/**
 * 1試合ぶんの部屋。世界の唯一の正解を持ち、60Hz で回して 30Hz で配る。
 *
 * 部屋ごとに独立したループを持たず、Lobby から tick() を呼ばれる形にしてある。
 * タイマーを部屋の数だけ作ると、数が増えたときに時刻がばらつくため。
 */

/** スナップショットを送る間隔（ティック）。60Hz / 2 = 30Hz。 */
const SNAPSHOT_EVERY = 2;
/** 未処理入力がこれを超えたら、1ティックで2つ消費して追いつく。 */
const QUEUE_CATCHUP = 6;
/** 1チームの上限。 */
const TEAM_CAP = MAX_PLAYERS / 2;

export interface Client {
  slot: number;
  ws: WebSocket;
  /** 所属パーティのコード。 */
  partyCode: string;
  queue: PlayerInput[];
  last: PlayerInput;
  lastProcessedSeq: number;
  highestSeqSeen: number;
}

export class Room {
  readonly world: World = createWorld();
  readonly clients = new Map<number, Client>();

  /** AI が占める席。slot -> 状態。 */
  private aiStates = new Map<number, AiState>();
  /**
   * AI が直近に出した入力。スナップショットに載せて、クライアントが
   * 人間と同じように外挿できるようにする。ここを空にすると、AI だけ
   * スナップショットの間で減速して見える。
   */
  private aiLastInputs = new Map<number, PlayerInput>();
  private tickCount = 0;

  readonly id: number;

  constructor(id: number) {
    // Node の型ストリッピングはパラメータプロパティに対応しないので明示的に代入する。
    this.id = id;
    startMatch(this.world, resetPositions);
  }

  get humanCount(): number {
    return this.clients.size;
  }

  /** その席の id 文字列。sim 側はプレイヤーを文字列 id で扱う。 */
  private static idOf(slot: number): string {
    return String(slot);
  }

  /** チームの人数（AI 含む）。 */
  teamSize(team: TeamId): number {
    return this.world.players.filter((p) => p.team === team).length;
  }

  /** そのチームにまだ人間が入れるか。 */
  hasSpaceOn(team: TeamId): boolean {
    return this.humansOn(team) < TEAM_CAP;
  }

  /** そのチームに人間が何人いるか。 */
  private humansOn(team: TeamId): number {
    let n = 0;
    for (const c of this.clients.values()) {
      const p = this.world.players.find((q) => q.id === Room.idOf(c.slot));
      if (p?.team === team) n++;
    }
    return n;
  }

  /** partySize 人が同じチームに入れるか。入れるならそのチームを返す。 */
  findTeamFor(partySize: number): TeamId | null {
    const options: TeamId[] = [0, 1];
    // 人数の少ないチームを優先して、偏りを避ける。
    options.sort((a, b) => this.humansOn(a) - this.humansOn(b));
    for (const team of options) {
      if (this.humansOn(team) + partySize <= TEAM_CAP) return team;
    }
    return null;
  }

  private freeSlot(): number | null {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (!this.clients.has(i) && !this.aiStates.has(i)) return i;
    }
    return null;
  }

  /**
   * 人間を参加させる。席が AI に埋まっていれば、その AI を退けて席を渡す。
   * design.md の「後から人が入ってきたら AI の枠を人間が乗っ取る」の実装。
   */
  join(ws: WebSocket, partyCode: string, team: TeamId): Client | null {
    let slot = this.freeSlot();
    if (slot === null) {
      // 同じチームの AI がいれば、その席を明け渡す。
      const victim = [...this.aiStates.keys()].find((s) => {
        const p = this.world.players.find((q) => q.id === Room.idOf(s));
        return p?.team === team;
      });
      if (victim === undefined) return null;
      this.removeSeat(victim);
      slot = victim;
    }

    const client: Client = {
      slot,
      ws,
      partyCode,
      queue: [],
      last: emptyInput(0),
      lastProcessedSeq: 0,
      highestSeqSeen: 0,
    };
    this.clients.set(slot, client);
    this.world.players.push(createPlayer(Room.idOf(slot), team));

    // 最初の1人が来たら新しい試合として仕切り直す。
    if (this.clients.size === 1) startMatch(this.world, resetPositions);

    this.syncAi();
    ensureGoalkeepers(this.world);

    ws.binaryType = 'arraybuffer';
    ws.send(encodeWelcome({ slot, team, serverTick: this.tickCount }));
    return client;
  }

  leave(slot: number): void {
    if (!this.clients.delete(slot)) return;
    this.removeSeat(slot);
    this.syncAi();
    ensureGoalkeepers(this.world);
  }

  private removeSeat(slot: number): void {
    this.aiStates.delete(slot);
    this.aiLastInputs.delete(slot);
    const index = this.world.players.findIndex((p) => p.id === Room.idOf(slot));
    if (index >= 0) this.world.players.splice(index, 1);
  }

  /**
   * AI の数を人数に合わせる。
   *
   * 規則は「**両チームを常に同数にする**」の一点。人間の多いほうの人数に
   * 揃え、足りない側を AI で埋める。
   *
   * design.md の「奇数のときだけ AI を1体」は、人間が両チームに均等に
   * 散っている場合のこの式の帰結。パーティは全員が同じチームに入るので
   * 人間は均等に散らず、たとえば2人パーティだけの部屋は 2v2（AI 2体）に
   * なる。人数だけで数えると 2v1 という壊れた試合になってしまう。
   *
   * 人間が抜けた席も、この計算の結果として AI が埋める。
   */
  private syncAi(): void {
    const humans = this.clients.size;
    if (humans === 0) {
      for (const slot of [...this.aiStates.keys()]) this.removeSeat(slot);
      return;
    }

    const perTeam = Math.min(TEAM_CAP, Math.max(this.humansOn(0), this.humansOn(1)));

    for (const team of [0, 1] as const) {
      // 多すぎる AI を削る。
      while (this.teamSize(team) > perTeam) {
        const extra = [...this.aiStates.keys()].find((s) => {
          const p = this.world.players.find((q) => q.id === Room.idOf(s));
          return p?.team === team;
        });
        if (extra === undefined) break;
        this.removeSeat(extra);
      }
      // 足りないぶんを AI で埋める。
      while (this.teamSize(team) < perTeam) {
        const slot = this.freeSlot();
        if (slot === null) break;
        this.aiStates.set(slot, createAiState());
        this.world.players.push(createPlayer(Room.idOf(slot), team, true));
      }
    }
  }

  /** クライアントから届いた入力を受け取る。 */
  receiveInputs(client: Client, inputs: PlayerInput[]): void {
    for (const input of inputs) {
      // 冗長送信されてくるので、すでに見た seq は捨てる。
      if (input.seq <= client.highestSeqSeen) continue;
      client.highestSeqSeen = input.seq;
      client.queue.push(input);
    }
  }

  /** 1ティック進める。必要ならスナップショットも配る。 */
  tick(): void {
    const inputs = new Map<string, PlayerInput>();

    for (const c of this.clients.values()) {
      if (c.queue.length > 0) {
        // 溜まりすぎている＝クライアントが先行しすぎ。1つ捨てて追いつく。
        if (c.queue.length > QUEUE_CATCHUP) c.queue.shift();
        const next = c.queue.shift()!;
        c.last = next;
        c.lastProcessedSeq = next.seq;
      }
      // 新しい入力が届いていない場合は直前の入力を維持する。ここで入力を
      // 空にすると、パケットが1つ落ちただけで選手が止まってカクつく。
      inputs.set(Room.idOf(c.slot), c.last);
    }

    for (const [slot, state] of this.aiStates) {
      const me = this.world.players.find((p) => p.id === Room.idOf(slot));
      if (!me) continue;
      const decided = aiInput(this.world, me, state, this.tickCount);
      this.aiLastInputs.set(slot, decided);
      inputs.set(Room.idOf(slot), decided);
    }

    step(this.world, inputs);
    this.tickCount++;

    if (this.tickCount % SNAPSHOT_EVERY === 0) this.broadcast();
  }

  private broadcast(): void {
    for (const c of this.clients.values()) {
      if (c.ws.readyState !== 1) continue;
      c.ws.send(encodeSnapshot(this.buildSnapshot(c)));
    }
  }

  private buildSnapshot(forClient: Client): Snapshot {
    const w = this.world;
    const players: SnapshotPlayer[] = w.players.map((p) => {
      const slot = Number(p.id);
      const client = this.clients.get(slot);
      const input = client?.last ?? this.aiLastInputs.get(slot) ?? emptyInput(0);
      return {
        slot,
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
        input: {
          moveX: input.moveX,
          moveY: input.moveY,
          aimX: input.aimX,
          aimY: input.aimY,
          power: input.power,
          kick: input.kick,
          claimGk: input.claimGk,
        },
      };
    });

    return {
      serverTick: this.tickCount,
      lastProcessedSeq: forClient.lastProcessedSeq,
      queueDepth: forClient.queue.length,
      score: [w.score[0], w.score[1]],
      ball: { ...w.ball },
      players,
      config: { ...w.config },
      phase: w.phase,
      phaseTimer: w.phaseTimer,
      half: w.half,
      clock: w.clock,
      sidesSwapped: w.sidesSwapped,
      restartTeam: w.restartTeam,
      restartTimer: w.restartTimer,
    };
  }
}
