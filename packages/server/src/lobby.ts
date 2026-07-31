import type { WebSocket } from 'ws';

import * as C from '../../shared/src/constants.ts';
import { encodeLobby } from '../../shared/src/protocol.ts';
import type { TeamId } from '../../shared/src/types.ts';
import { Room, type Client } from './room.ts';

/**
 * ロビー。部屋の作成・破棄と、パーティ単位のマッチメイキングを担当する。
 *
 * 「先着順で空き部屋に自動振り分け」が基本だが、それだけだと友達同士で
 * 入っても別々の部屋・別々のチームに散ってしまう。そこでパーティを併設し、
 * 同じコードを持つ人は必ず同じ部屋・同じチームへ入れる。
 */

/** パーティの上限。1チーム分。これ以上は対戦を分ける必要が出て複雑になる。 */
export const MAX_PARTY = 3;

/** コードに使う文字。見間違えやすい 0/O/1/I/L を除いてある。 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

interface Party {
  code: string;
  /** このパーティが入っている部屋。まだ入っていなければ null。 */
  roomId: number | null;
  /**
   * このパーティが割り当てられたチーム。最初の1人で決まり、以降の
   * メンバーは必ず同じチームへ入る。これがないと友達同士が敵味方に割れる。
   */
  team: TeamId | null;
  members: Set<Client>;
}

export class Lobby {
  private rooms = new Map<number, Room>();
  private parties = new Map<string, Party>();
  private nextRoomId = 1;

  private newCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.parties.has(code)) return code;
    }
    // 事実上ここには来ないが、衝突し続けた場合の保険。
    return `R${this.nextRoomId++}`;
  }

  /**
   * 参加させる。
   *
   * @param requestedCode 友達から共有されたパーティコード。空なら新規に作る。
   */
  join(ws: WebSocket, requestedCode: string): { client: Client; room: Room } | null {
    const normalized = requestedCode.trim().toUpperCase();

    let party = normalized ? this.parties.get(normalized) : undefined;
    if (!party) {
      // 知らないコードを渡された場合も、そのコードで新しいパーティを作る。
      // 「先に開いた人がまだ来ていない」だけのことが多く、弾くと合流できない。
      const code = normalized && normalized.length <= 8 ? normalized : this.newCode();
      party = { code, roomId: null, team: null, members: new Set() };
      this.parties.set(code, party);
    }

    if (party.members.size >= MAX_PARTY) return null;

    const placement = this.findRoomFor(party);
    if (!placement) return null;

    const { room, team } = placement;
    const client = room.join(ws, party.code, team);
    if (!client) return null;

    party.members.add(client);
    party.roomId = room.id;
    party.team = team;
    this.sendLobby(party);
    return { client, room };
  }

  /**
   * パーティが入るべき部屋を選ぶ。
   *
   * すでにメンバーが試合中ならその部屋へ合流し、なければ空きのある部屋を
   * 先着順で探す。どこも埋まっていれば新しい部屋を作る。
   */
  private findRoomFor(party: Party): { room: Room; team: TeamId } | null {
    // すでにメンバーが試合中なら、その部屋の**同じチーム**へ合流する。
    // パーティの上限（3）は1チームの定員と同じなので、ここが埋まっていて
    // 溢れることはない。つまりパーティが敵味方に割れることはない。
    if (party.roomId !== null && party.team !== null) {
      const existing = this.rooms.get(party.roomId);
      if (existing && existing.hasSpaceOn(party.team)) {
        return { room: existing, team: party.team };
      }
    }

    // 先着順＝部屋 id の若い順に、空きのある部屋を埋めていく。
    const ids = [...this.rooms.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const room = this.rooms.get(id)!;
      const team = room.findTeamFor(1);
      if (team !== null) return { room, team };
    }

    const room = new Room(this.nextRoomId++);
    this.rooms.set(room.id, room);
    const team = room.findTeamFor(1);
    return team === null ? null : { room, team };
  }

  leave(client: Client): void {
    for (const room of this.rooms.values()) {
      if (room.clients.get(client.slot) !== client) continue;
      room.leave(client.slot);
      if (room.humanCount === 0) this.rooms.delete(room.id);
      break;
    }

    const party = this.parties.get(client.partyCode);
    if (!party) return;
    party.members.delete(client);
    if (party.members.size === 0) {
      this.parties.delete(party.code);
    } else {
      this.sendLobby(party);
    }
  }

  /** パーティのメンバー全員に、現在のパーティ状態を送る。 */
  private sendLobby(party: Party): void {
    const room = party.roomId === null ? null : this.rooms.get(party.roomId);
    for (const member of party.members) {
      if (member.ws.readyState !== 1) continue;
      member.ws.send(
        encodeLobby({
          partyCode: party.code,
          partySize: party.members.size,
          roomPlayers: room ? room.world.players.length : 0,
          roomHumans: room ? room.humanCount : 0,
        }),
      );
    }
  }

  /** 全部屋を1ティック進める。 */
  tickAll(): void {
    for (const room of this.rooms.values()) room.tick();
  }

  get stats(): { rooms: number; players: number; parties: number } {
    let players = 0;
    for (const room of this.rooms.values()) players += room.humanCount;
    return { rooms: this.rooms.size, players, parties: this.parties.size };
  }

  /** 固定タイムステップのループを回す。 */
  run(): void {
    let lastTime = performance.now();
    let accumulator = 0;

    // setInterval の粒度は粗いので、実時間の経過ぶんだけ進めて平均レートを保つ。
    setInterval(() => {
      const now = performance.now();
      accumulator += (now - lastTime) / 1000;
      lastTime = now;

      let steps = 0;
      while (accumulator >= C.DT && steps < 10) {
        accumulator -= C.DT;
        this.tickAll();
        steps++;
      }
      // 遅れが大きすぎるときは捨てる。追いつこうとして固まるのを防ぐ。
      if (accumulator > C.DT * 10) accumulator = 0;
    }, 4);
  }
}
