import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';

const PORT = Number(process.env.PORT ?? 8080);
const wss = new WebSocketServer({ port: PORT });

const rooms = new Map<string, Set<WebSocket>>();

function getRoom(req: IncomingMessage): string {
  try {
    return new URL(req.url!, 'ws://x').searchParams.get('room') ?? 'default';
  } catch {
    return 'default';
  }
}

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const room = getRoom(req);
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room)!.add(ws);
  console.log(`[+] room=${room} total=${rooms.get(room)!.size}`);

  ws.on('message', (data) => {
    for (const client of rooms.get(room)!) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(data.toString());
      }
    }
  });

  ws.on('close', () => {
    rooms.get(room)?.delete(ws);
    const remaining = rooms.get(room);
    if (remaining) {
      if (remaining.size === 0) {
        rooms.delete(room);
      } else {
        const msg = JSON.stringify({ type: 'tracker_disconnected' });
        for (const client of remaining) {
          if (client.readyState === WebSocket.OPEN) client.send(msg);
        }
      }
    }
    console.log(`[-] room=${room} total=${rooms.get(room)?.size ?? 0}`);
  });

  ws.on('error', (err) => {
    console.error('[!] ws error:', err.message);
  });
});

console.log(`WS relay running on ws://localhost:${PORT}`);
