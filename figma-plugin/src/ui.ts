// ── Shared types (mirrored from tracker/src/tracker.ts) ───────────────────────
type HandMessage = {
  type: 'hand_update';
  timestamp: number;
  hands: Array<{
    handedness: 'Left' | 'Right';
    landmarks: Array<{ x: number; y: number; z: number }>;
  }>;
  gestures: {
    pinch: boolean;
    position: { x: number; y: number };
    zoom: number | null;
    rotation: number | null;
    isPanning: boolean;
    fist: boolean;
    peace: boolean;
    openPalm: boolean;
  };
};

type PluginCommand =
  | { type: 'MOVE_CURSOR'; x: number; y: number }
  | { type: 'SELECT_AT'; x: number; y: number }
  | { type: 'PAN'; dx: number; dy: number }
  | { type: 'ZOOM'; factor: number }
  | { type: 'ROTATE_NODE'; angleDeg: number }
  | { type: 'MOVE_NODE'; dx: number; dy: number }
  | { type: 'MOVE_NODE_END' }
  | { type: 'UNDO' }
  | { type: 'DESELECT_ALL' };

// ── State ─────────────────────────────────────────────────────────────────────
let paused = false;
let prevPosition: { x: number; y: number } | null = null;
let prevZoomDist: number | null = null;
let prevRotationAngle: number | null = null;
let rotationAccum = 0;
const ROTATE_SNAP_DEG = 15;
let prevPinch = false;

type DragState = 'idle' | 'dragging';
let dragState: DragState = 'idle';
let prevDragPos: { x: number; y: number } | null = null;
let prevFist = false;
let prevPeace = false;
let prevOpenPalm = false;
const MAX_DELTA = 0.05;

const DWELL_MS = 500;
const DWELL_STILL_THRESHOLD = 0.018;
let dwellPos: { x: number; y: number } | null = null;
let dwellStart: number | null = null;
let dwellFired = false;

const RELAY_HOST = 'hand-relay.fly.dev';
const TRACKER_HOST = 'fab96io.github.io/hands-control';

function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = (n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${part(3)}-${part(3)}`;
}

let roomId = generateRoomId();
const TRACKER_BASE = `https://${TRACKER_HOST}`;

function wsUrl() { return `wss://${RELAY_HOST}/ws?room=${roomId}`; }

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dotEl = document.getElementById('dot')!;
const statusEl = document.getElementById('status')!;
const gestureEl = document.getElementById('gesture')!;
const coordsEl = document.getElementById('coords')!;
const logEl = document.getElementById('log')!;
const btnToggle = document.getElementById('btn-toggle') as HTMLButtonElement;
const btnCopy = document.getElementById('btn-copy') as HTMLButtonElement;
const btnOpen = document.getElementById('btn-open') as HTMLButtonElement;
const btnDisconnect = document.getElementById('btn-disconnect') as HTMLButtonElement;
const roomActionsDisc = document.getElementById('room-actions-disconnected')!;
const roomActionsConn = document.getElementById('room-actions-connected')!;
const roomCodeEl = document.getElementById('room-code')!;
const panSensInput = document.getElementById('pan-sens') as HTMLInputElement;
const zoomSensInput = document.getElementById('zoom-sens') as HTMLInputElement;
const panValEl = document.getElementById('pan-val')!;
const zoomValEl = document.getElementById('zoom-val')!;

roomCodeEl.textContent = roomId;

btnCopy.addEventListener('click', () => {
  const ta = document.createElement('textarea');
  ta.value = roomId;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  btnCopy.innerHTML = btnCopy.innerHTML.replace('Copy', 'Copied!');
  setTimeout(() => { btnCopy.innerHTML = btnCopy.innerHTML.replace('Copied!', 'Copy'); }, 1500);
});

btnOpen.addEventListener('click', () => {
  parent.postMessage({ pluginMessage: { type: 'OPEN_URL', url: TRACKER_BASE } }, '*');
});

btnDisconnect.addEventListener('click', () => {
  if (activeWs?.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify({ type: 'room_closed' }));
  }
  manualDisconnect = true;
  setTimeout(() => {
    activeWs?.close();
    setTracking(false);
    roomId = generateRoomId();
    roomCodeEl.textContent = roomId;
    setTimeout(() => connect(), 100);
  }, 100);
});

panSensInput.addEventListener('input', () => { panValEl.textContent = panSensInput.value; });
zoomSensInput.addEventListener('input', () => { zoomValEl.textContent = zoomSensInput.value; });

btnToggle.addEventListener('click', () => {
  paused = !paused;
  btnToggle.textContent = paused ? 'Resume' : 'Pause';
  setGesture(paused ? 'PAUSED' : '—');
});

function setConnected(connected: boolean) {
  dotEl.className = 'dot' + (connected ? ' connected' : '');
  statusEl.textContent = connected ? 'Connected' : 'Disconnected';
  if (!connected) setTracking(false);
}

function setTracking(active: boolean) {
  const d = active ? 'block' : 'none';
  document.getElementById('connected-ui')!.style.display = d;
  document.getElementById('sliders-ui')!.style.display = active ? 'flex' : 'none';
  document.getElementById('log')!.style.display = d;
  roomActionsDisc.style.display = active ? 'none' : 'flex';
  roomActionsConn.style.display = active ? 'flex' : 'none';
}

function log(msg: string) {
  logEl.textContent = msg;
}

const GESTURE_ICONS: Record<string, string> = {
  'no hands':  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="overflow:visible"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
  'pinch':     `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="overflow:visible"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8l-2-2.5a1.5 1.5 0 0 0-2.5 1.5l3 5A5 5 0 0 0 9 21h6a5 5 0 0 0 5-5v-5a2 2 0 0 0-4 0v1"/></svg>`,
  'fist':      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="overflow:visible"><rect x="3" y="8" width="18" height="13" rx="2"/><path d="M7 8V6a2 2 0 0 1 4 0v2"/><path d="M11 8V5a2 2 0 0 1 4 0v3"/><path d="M15 8V7a2 2 0 0 1 4 0v1"/></svg>`,
  'peace':     `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="overflow:visible"><circle cx="12" cy="12" r="10"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="12" y1="12" x2="4.93" y2="19.07"/><line x1="12" y1="12" x2="19.07" y2="19.07"/></svg>`,
  'open palm': `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="overflow:visible"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10V5a2 2 0 0 0-4 0v9"/><path d="M6 14v-3a2 2 0 0 0-4 0v5a8 8 0 0 0 8 8h4a8 8 0 0 0 8-8V6a2 2 0 0 0-4 0v8"/></svg>`,
  'pan':       `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="overflow:visible"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>`,
  'two hands': `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="overflow:visible"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
  'idle':      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="overflow:visible"><circle cx="12" cy="12" r="10"/></svg>`,
};

function gestureKey(text: string): string {
  if (text.startsWith('pinch')) return 'pinch';
  if (text.startsWith('fist')) return 'fist';
  if (text.startsWith('peace')) return 'peace';
  if (text.startsWith('open palm')) return 'open palm';
  if (text.startsWith('pan')) return 'pan';
  if (text.startsWith('two hands')) return 'two hands';
  if (text.startsWith('no hands')) return 'no hands';
  return 'idle';
}

const gestureIconEl = document.getElementById('gesture-icon');
function setGesture(text: string) {
  gestureEl.textContent = text;
  if (gestureIconEl) gestureIconEl.innerHTML = GESTURE_ICONS[gestureKey(text)] ?? GESTURE_ICONS['idle'];
}

function send(cmd: PluginCommand) {
  parent.postMessage({ pluginMessage: cmd }, '*');
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
let activeWs: WebSocket | null = null;
let manualDisconnect = false;

function connect() {
  manualDisconnect = false;
  const ws = new WebSocket(wsUrl());
  activeWs = ws;

  ws.onopen = () => setConnected(true);

  ws.onclose = () => {
    setConnected(false);
    prevPosition = null;
    prevZoomDist = null;
    if (!manualDisconnect) setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    let msg: HandMessage | { type: string };
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'tracker_disconnected') {
      manualDisconnect = true;
      activeWs?.close();
      setTracking(false);
      roomId = generateRoomId();
      roomCodeEl.textContent = roomId;
      setTimeout(() => connect(), 100);
      return;
    }

    if (paused || msg.type !== 'hand_update') return;
    setTracking(true);
    processMessage(msg as HandMessage);
  };
}

function processMessage(msg: HandMessage) {
  const { gestures } = msg;
  const panSens = parseInt(panSensInput.value);
  const zoomSens = parseInt(zoomSensInput.value) / 10;

  // Update UI
  coordsEl.textContent = `pos: (${gestures.position.x.toFixed(2)}, ${gestures.position.y.toFixed(2)}) | zoom: ${gestures.zoom?.toFixed(2) ?? '—'}`;

  if (msg.hands.length === 0) {
    setGesture('no hands');
    prevPosition = null;
    prevZoomDist = null;
    prevRotationAngle = null;
    rotationAccum = 0;
    prevPinch = false;
    dragState = 'idle';
    prevDragPos = null;
    prevFist = false;
    prevPeace = false;
    prevOpenPalm = false;
    dwellPos = null;
    dwellStart = null;
    dwellFired = false;
    return;
  }

  // ── Cursor always follows primary hand ─────────────────────────────────────
  send({ type: 'MOVE_CURSOR', x: gestures.position.x, y: gestures.position.y });

  // ── Pinch → drag only ─────────────────────────────────────────────────────
  if (gestures.pinch && !prevPinch) {
    dragState = 'dragging';
    prevDragPos = { ...gestures.position };
  }

  if (gestures.pinch && dragState === 'dragging') {
    setGesture('pinch — drag');
    const rawDx = gestures.position.x - prevDragPos!.x;
    const rawDy = gestures.position.y - prevDragPos!.y;
    const dx = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, rawDx));
    const dy = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, rawDy));
    if (Math.abs(dx) > 0.003 || Math.abs(dy) > 0.003) {
      send({ type: 'MOVE_NODE', dx, dy });
    }
    prevDragPos = { ...gestures.position };
  }

  if (!gestures.pinch && prevPinch) {
    send({ type: 'MOVE_NODE_END' });
    dragState = 'idle';
    prevDragPos = null;
  }

  // ── Fist → deselect all ────────────────────────────────────────────────────
  if (gestures.fist && !prevFist) {
    setGesture('fist — deselect');
    send({ type: 'DESELECT_ALL' });
  }

  // ── Peace → undo ───────────────────────────────────────────────────────────
  if (gestures.peace && !prevPeace) {
    setGesture('peace — undo');
    send({ type: 'UNDO' });
  }

  // ── Open palm → select under cursor ───────────────────────────────────────
  if (gestures.openPalm && !prevOpenPalm) {
    setGesture('open palm — select');
    send({ type: 'SELECT_AT', x: gestures.position.x, y: gestures.position.y });
  }

  // ── Two-hand zoom + rotate ────────────────────────────────────────────────
  if (gestures.zoom !== null) {
    setGesture('two hands');
    if (prevZoomDist !== null) {
      const ratio = gestures.zoom / prevZoomDist;
      const factor = 1 + (ratio - 1) * zoomSens * 10;
      if (Math.abs(factor - 1) > 0.005) {
        send({ type: 'ZOOM', factor });
      }
    }
    prevZoomDist = gestures.zoom;

    if (gestures.rotation !== null && prevRotationAngle !== null) {
      let delta = gestures.rotation - prevRotationAngle;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      if (Math.abs(delta) > 0.2 && Math.abs(delta) < 20) {
        rotationAccum += delta;
        if (Math.abs(rotationAccum) >= ROTATE_SNAP_DEG) {
          const steps = Math.trunc(rotationAccum / ROTATE_SNAP_DEG);
          send({ type: 'ROTATE_NODE', angleDeg: steps * ROTATE_SNAP_DEG });
          rotationAccum -= steps * ROTATE_SNAP_DEG;
          log(`rotate: ${steps * ROTATE_SNAP_DEG}°`);
        }
      }
    }
    prevRotationAngle = gestures.rotation;
    prevPosition = null;
  } else {
    prevZoomDist = null;
    prevRotationAngle = null;

    // ── One-hand pan ─────────────────────────────────────────────────────────
    if (gestures.isPanning && !gestures.pinch) {
      setGesture('pan');
      if (prevPosition !== null) {
        const rawDx = gestures.position.x - prevPosition.x;
        const rawDy = gestures.position.y - prevPosition.y;
        const clampedDx = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, rawDx));
        const clampedDy = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, rawDy));
        const dx = clampedDx * panSens;
        const dy = clampedDy * panSens;
        if (Math.abs(dx) > 0.008 || Math.abs(dy) > 0.008) {
          send({ type: 'PAN', dx, dy });
        }
      }
      prevPosition = { ...gestures.position };
    } else if (!gestures.isPanning) {
      prevPosition = null;
    }
  }

  prevPinch = gestures.pinch;
  prevFist = gestures.fist;
  prevPeace = gestures.peace;
  prevOpenPalm = gestures.openPalm;
}

connect();
