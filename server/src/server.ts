import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';

const PORT = Number(process.env.PORT ?? 8080);
const PING_INTERVAL_MS = 25_000;

const wss = new WebSocketServer({ port: PORT, host: '0.0.0.0' });

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

  // Keepalive: ping every 25s so mobile networks don't kill idle connections
  let alive = true;
  const pingTimer = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    alive = false;
    ws.ping();
  }, PING_INTERVAL_MS);
  ws.on('pong', () => { alive = true; });

  ws.on('message', (data) => {
    for (const client of rooms.get(room)!) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(data.toString());
      }
    }
  });

  ws.on('close', () => {
    clearInterval(pingTimer);
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
