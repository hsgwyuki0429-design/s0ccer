import {
  MSG_LOBBY,
  MSG_PONG,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  MSG_PING,
  decodeLobby,
  decodePingPongId,
  decodeSnapshot,
  decodeWelcome,
  encodeHello,
  encodeInputs,
  encodePingPong,
  type LobbyInfo,
  type PlayerInput,
  type Snapshot,
  type Welcome,
} from '@s0ccer/shared';

export type NetStatus = 'connecting' | 'open' | 'closed' | 'error';

/** RTT の測定間隔（ミリ秒）。 */
const PING_INTERVAL = 500;
/** RTT の平滑化係数。跳ねた1回に振り回されないようにする。 */
const RTT_SMOOTHING = 0.2;

/**
 * WebSocket クライアント。プロトコルの入出力だけを担当し、
 * ゲームの状態は持たない。
 */
export class NetClient {
  status: NetStatus = 'connecting';
  welcome: Welcome | null = null;
  /** 平滑化済みの往復遅延（ミリ秒）。 */
  rtt = 0;
  /** 受信したスナップショット数。 */
  snapshotsReceived = 0;

  onWelcome: ((w: Welcome) => void) | null = null;
  onSnapshot: ((s: Snapshot) => void) | null = null;
  onLobby: ((info: LobbyInfo) => void) | null = null;

  private ws: WebSocket;
  private pingTimer: number | null = null;
  private pingId = 0;
  private pendingPings = new Map<number, number>();

  constructor(url: string, partyCode: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.addEventListener('open', () => {
      this.status = 'open';
      // 参加要求。コードが空なら、サーバーが新しいパーティを作って返す。
      this.ws.send(encodeHello(partyCode));
      this.pingTimer = window.setInterval(() => this.sendPing(), PING_INTERVAL);
      this.sendPing();
    });

    this.ws.addEventListener('close', () => {
      this.status = 'closed';
      this.stopPing();
    });

    this.ws.addEventListener('error', () => {
      this.status = 'error';
      this.stopPing();
    });

    this.ws.addEventListener('message', (e) => this.onMessage(e));
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private sendPing(): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const id = ++this.pingId;
    this.pendingPings.set(id, performance.now());
    // 取りこぼした ping が溜まらないよう、古いものは捨てる。
    if (this.pendingPings.size > 8) {
      const oldest = this.pendingPings.keys().next().value;
      if (oldest !== undefined) this.pendingPings.delete(oldest);
    }
    this.ws.send(encodePingPong(MSG_PING, id));
  }

  private onMessage(e: MessageEvent): void {
    if (!(e.data instanceof ArrayBuffer)) return;
    const view = new DataView(e.data);
    if (view.byteLength < 1) return;

    switch (view.getUint8(0)) {
      case MSG_WELCOME: {
        this.welcome = decodeWelcome(view);
        this.onWelcome?.(this.welcome);
        break;
      }
      case MSG_LOBBY: {
        this.onLobby?.(decodeLobby(view));
        break;
      }
      case MSG_SNAPSHOT: {
        this.snapshotsReceived++;
        this.onSnapshot?.(decodeSnapshot(view));
        break;
      }
      case MSG_PONG: {
        const id = decodePingPongId(view);
        const sent = this.pendingPings.get(id);
        if (sent === undefined) break;
        this.pendingPings.delete(id);
        const sample = performance.now() - sent;
        this.rtt = this.rtt === 0 ? sample : this.rtt + (sample - this.rtt) * RTT_SMOOTHING;
        break;
      }
    }
  }

  /** 未確認の入力をまとめて送る。冗長分がパケットロスを吸収する。 */
  sendInputs(inputs: PlayerInput[]): void {
    if (this.ws.readyState !== WebSocket.OPEN || inputs.length === 0) return;
    this.ws.send(encodeInputs(inputs));
  }

  close(): void {
    this.stopPing();
    this.ws.close();
  }
}
