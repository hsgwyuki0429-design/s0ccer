import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

// shared はワークスペース名ではなく相対パスで読む。Node の型ストリッピングは
// node_modules 配下の .ts を処理しないため、シンボリックリンク経由だと動かない。
import * as C from '../../shared/src/constants.ts';
import {
  MSG_INPUT,
  MSG_PING,
  MSG_PONG,
  MAX_PLAYERS,
  decodeInputs,
  decodePingPongId,
  encodePingPong,
  encodeSnapshot,
  encodeWelcome,
  type Snapshot,
  type SnapshotPlayer,
} from '../../shared/src/protocol.ts';
import { createPlayer, createWorld, resetPositions, step } from '../../shared/src/sim.ts';
import { emptyInput, type PlayerInput, type TeamId, type World } from '../../shared/src/types.ts';

/**
 * ゲームサーバー。世界の唯一の正解を持つ。
 *
 * 60Hz でシミュレーションし、30Hz でスナップショットを配る。クライアントは
 * 同じ shared/sim.ts を使って予測するので、両者の物理は定義上一致する。
 *
 * Phase 2 なので部屋は1つだけ。部屋分けとマッチメイキングは Phase 3。
 */

const PORT = Number(process.env.PORT ?? 8787);
/** スナップショットを送る間隔（ティック）。60Hz / 2 = 30Hz。 */
const SNAPSHOT_EVERY = 2;
/** 未処理入力がこれを超えたら、1ティックで2つ消費して追いつく。 */
const QUEUE_CATCHUP = 6;

interface Client {
  slot: number;
  ws: WebSocket;
  /** 未処理の入力。到着順ではなく seq 順に処理する。 */
  queue: PlayerInput[];
  /** 直前に処理した入力。新しい入力が来ていないときはこれを維持する。 */
  last: PlayerInput;
  lastProcessedSeq: number;
  /** 受信済みの最大 seq。再送された古い入力を捨てるために持つ。 */
  highestSeqSeen: number;
}

const world: World = createWorld();
const clients = new Map<number, Client>();
let tick = 0;

function playerId(slot: number): string {
  return String(slot);
}

/** 人数の少ないチームへ入れる。同数ならチーム0。 */
function pickTeam(): TeamId {
  let a = 0;
  let b = 0;
  for (const p of world.players) {
    if (p.team === 0) a++;
    else b++;
  }
  return a <= b ? 0 : 1;
}

function freeSlot(): number | null {
  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (!clients.has(i)) return i;
  }
  return null;
}

function buildSnapshot(forClient: Client): Snapshot {
  const players: SnapshotPlayer[] = world.players.map((p) => {
    const c = clients.get(Number(p.id));
    const input = c?.last ?? emptyInput(0);
    return {
      slot: Number(p.id),
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
      input: {
        moveX: input.moveX,
        moveY: input.moveY,
        aimX: input.aimX,
        aimY: input.aimY,
        kick: input.kick,
      },
    };
  });

  return {
    serverTick: tick,
    lastProcessedSeq: forClient.lastProcessedSeq,
    queueDepth: forClient.queue.length,
    score: [world.score[0], world.score[1]],
    ball: { ...world.ball },
    players,
  };
}

function simulate(): void {
  const inputs = new Map<string, PlayerInput>();

  for (const c of clients.values()) {
    if (c.queue.length > 0) {
      // 溜まりすぎている＝クライアントが先行しすぎ。1つ捨てて追いつく。
      if (c.queue.length > QUEUE_CATCHUP) c.queue.shift();
      const next = c.queue.shift()!;
      c.last = next;
      c.lastProcessedSeq = next.seq;
    }
    // 新しい入力が届いていない場合は直前の入力を維持する。ここで入力を
    // 空にすると、パケットが1つ落ちただけで選手が止まってカクつく。
    inputs.set(playerId(c.slot), c.last);
  }

  step(world, inputs);
  tick++;

  if (tick % SNAPSHOT_EVERY === 0) {
    for (const c of clients.values()) {
      if (c.ws.readyState !== 1) continue;
      c.ws.send(encodeSnapshot(buildSnapshot(c)));
    }
  }
}

// --- 固定タイムステップのループ ---------------------------------------------
// setInterval の粒度は粗いので、実時間の経過分だけティックを進めて平均レートを保つ。
let lastTime = performance.now();
let accumulator = 0;

setInterval(() => {
  const now = performance.now();
  accumulator += (now - lastTime) / 1000;
  lastTime = now;

  let steps = 0;
  while (accumulator >= C.DT && steps < 10) {
    accumulator -= C.DT;
    simulate();
    steps++;
  }
  // 遅れが大きすぎるときは捨てる。無限に追いつこうとして固まるのを防ぐ。
  if (accumulator > C.DT * 10) accumulator = 0;
}, 4);

// --- WebSocket --------------------------------------------------------------

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`ok players=${clients.size} tick=${tick}`);
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const slot = freeSlot();
  if (slot === null) {
    ws.close(4000, 'room full');
    return;
  }

  // 誰もいなかったところに最初の1人が来たら、新しい試合として仕切り直す。
  if (clients.size === 0) {
    world.score[0] = 0;
    world.score[1] = 0;
  }

  const team = pickTeam();
  const client: Client = {
    slot,
    ws,
    queue: [],
    last: emptyInput(0),
    lastProcessedSeq: 0,
    highestSeqSeen: 0,
  };
  clients.set(slot, client);
  world.players.push(createPlayer(playerId(slot), team));

  // 1人目のときだけキックオフ配置に戻す。試合中の途中参加で全員を
  // 動かしてしまうと、プレーが壊れる。
  if (clients.size === 1) resetPositions(world);

  ws.binaryType = 'arraybuffer';
  ws.send(encodeWelcome({ slot, team, serverTick: tick }));
  console.log(`[join] slot=${slot} team=${team} players=${clients.size}`);

  ws.on('message', (data) => {
    const buf = data as ArrayBuffer | Buffer;
    const view =
      buf instanceof ArrayBuffer
        ? new DataView(buf)
        : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (view.byteLength < 1) return;

    switch (view.getUint8(0)) {
      case MSG_INPUT: {
        for (const input of decodeInputs(view)) {
          // 冗長送信されてくるので、すでに見た seq は捨てる。
          if (input.seq <= client.highestSeqSeen) continue;
          client.highestSeqSeen = input.seq;
          client.queue.push(input);
        }
        break;
      }
      case MSG_PING: {
        ws.send(encodePingPong(MSG_PONG, decodePingPongId(view)));
        break;
      }
    }
  });

  const drop = () => {
    if (!clients.delete(slot)) return;
    const index = world.players.findIndex((p) => p.id === playerId(slot));
    if (index >= 0) world.players.splice(index, 1);
    console.log(`[leave] slot=${slot} players=${clients.size}`);
  };
  ws.on('close', drop);
  ws.on('error', drop);
});

httpServer.listen(PORT, () => {
  console.log(`s0ccer server listening on :${PORT} (ws)`);
});
