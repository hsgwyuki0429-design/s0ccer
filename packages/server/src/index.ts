import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

// shared はワークスペース名ではなく相対パスで読む。Node の型ストリッピングは
// node_modules 配下の .ts を処理しないため、シンボリックリンク経由だと動かない。
import {
  MSG_HELLO,
  MSG_INPUT,
  MSG_PING,
  MSG_PONG,
  decodeHello,
  decodeInputs,
  decodePingPongId,
  encodePingPong,
} from '../../shared/src/protocol.ts';
import { Lobby } from './lobby.ts';
import type { Client, Room } from './room.ts';

/**
 * ゲームサーバー。
 *
 * 部屋の中身は Room、部屋割りとパーティは Lobby が持つ。ここは HTTP と
 * WebSocket の受け口だけを担当する。
 */

const PORT = Number(process.env.PORT ?? 8787);

const lobby = new Lobby();
lobby.run();

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    const s = lobby.stats;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...s }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.binaryType = 'arraybuffer';

  let client: Client | null = null;
  let room: Room | null = null;

  const drop = () => {
    if (!client) return;
    lobby.leave(client);
    console.log(`[leave] slot=${client.slot} party=${client.partyCode}`, lobby.stats);
    client = null;
    room = null;
  };

  ws.on('message', (data) => {
    const buf = data as ArrayBuffer | Buffer;
    const view =
      buf instanceof ArrayBuffer
        ? new DataView(buf)
        : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (view.byteLength < 1) return;

    switch (view.getUint8(0)) {
      case MSG_HELLO: {
        // 参加は一度だけ。二重に送られてきても無視する。
        if (client) break;
        const placed = lobby.join(ws, decodeHello(view));
        if (!placed) {
          ws.close(4000, 'no room available');
          break;
        }
        client = placed.client;
        room = placed.room;
        console.log(
          `[join] room=${room.id} slot=${client.slot} party=${client.partyCode}`,
          lobby.stats,
        );
        break;
      }

      case MSG_INPUT: {
        if (!client || !room) break;
        room.receiveInputs(client, decodeInputs(view));
        break;
      }

      case MSG_PING: {
        ws.send(encodePingPong(MSG_PONG, decodePingPongId(view)));
        break;
      }
    }
  });

  ws.on('close', drop);
  ws.on('error', drop);
});

httpServer.listen(PORT, () => {
  console.log(`s0ccer server listening on :${PORT} (ws)`);
});
