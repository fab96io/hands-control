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
    point: boolean;
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
let prevPoint = false;
const MAX_DELTA = 0.05;
const PINCH_RELEASE_FRAMES = 6;
let pinchOffFrames = 0;

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
const trackScaleInput = document.getElementById('track-scale') as HTMLInputElement;
const panValEl = document.getElementById('pan-val')!;
const zoomValEl = document.getElementById('zoom-val')!;
const trackValEl = document.getElementById('track-val')!;

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
trackScaleInput.addEventListener('input', () => {
  trackValEl.textContent = (parseInt(trackScaleInput.value) / 10).toFixed(1);
});
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
  'no hands':  `<svg width="18" height="18" viewBox="0 0 256 256" fill="#B0FE76" style="overflow:visible"><path d="M53.92,34.62A8,8,0,1,0,42.08,45.38L61.32,66.55C25,88.84,9.38,123.2,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208a127.11,127.11,0,0,0,52.07-10.83l22,24.21a8,8,0,1,0,11.84-10.76Zm47.33,75.84,41.67,45.85a32,32,0,0,1-41.67-45.85ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.16,133.16,0,0,1,25,128c4.69-8.79,19.66-33.39,47.35-49.38l18,19.75a48,48,0,0,0,63.66,70l14.73,16.2A112,112,0,0,1,128,192Zm6-95.43a8,8,0,0,1,3-15.72,48.16,48.16,0,0,1,38.77,42.64,8,8,0,0,1-7.22,8.71,6.39,6.39,0,0,1-.75,0,8,8,0,0,1-8-7.26A32.09,32.09,0,0,0,134,96.57Zm113.28,34.69c-.42.94-10.55,23.37-33.36,43.8a8,8,0,1,1-10.67-11.92A132.77,132.77,0,0,0,231.05,128a133.15,133.15,0,0,0-23.12-30.77C185.67,75.19,158.78,64,128,64a118.37,118.37,0,0,0-19.36,1.57A8,8,0,1,1,106,49.79,134,134,0,0,1,128,48c34.88,0,66.57,13.26,91.66,38.35,18.83,18.83,27.3,37.62,27.65,38.41A8,8,0,0,1,247.31,131.26Z"/></svg>`,
  'point':     `<svg width="18" height="18" viewBox="0 0 256 256" fill="#B0FE76" style="overflow:visible"><path d="M196,88a27.86,27.86,0,0,0-13.35,3.39A28,28,0,0,0,144,74.7V44a28,28,0,0,0-56,0v80l-3.82-6.13A28,28,0,0,0,35.73,146l4.67,8.23C74.81,214.89,89.05,240,136,240a88.1,88.1,0,0,0,88-88V116A28,28,0,0,0,196,88Zm12,64a72.08,72.08,0,0,1-72,72c-37.63,0-47.84-18-81.68-77.68l-4.69-8.27,0-.05A12,12,0,0,1,54,121.61a11.88,11.88,0,0,1,6-1.6,12,12,0,0,1,10.41,6,1.76,1.76,0,0,0,.14.23l18.67,30A8,8,0,0,0,104,152V44a12,12,0,0,1,24,0v68a8,8,0,0,0,16,0V100a12,12,0,0,1,24,0v20a8,8,0,0,0,16,0v-4a12,12,0,0,1,24,0Z"/></svg>`,
  'pinch':     `<svg width="18" height="18" viewBox="0 0 256 256" fill="#B0FE76" style="overflow:visible"><path d="M188,80a27.79,27.79,0,0,0-13.36,3.4,28,28,0,0,0-46.64-11A28,28,0,0,0,80,92v20H68a28,28,0,0,0-28,28v12a88,88,0,0,0,176,0V108A28,28,0,0,0,188,80Zm12,72a72,72,0,0,1-144,0V140a12,12,0,0,1,12-12H80v24a8,8,0,0,0,16,0V92a12,12,0,0,1,24,0v28a8,8,0,0,0,16,0V92a12,12,0,0,1,24,0v28a8,8,0,0,0,16,0V108a12,12,0,0,1,24,0Z"/></svg>`,
  'fist':      `<svg width="18" height="18" viewBox="0 0 256 256" fill="#B0FE76" style="overflow:visible"><path d="M200,80H184V64a32,32,0,0,0-56-21.13A32,32,0,0,0,72.21,60.42,32,32,0,0,0,24,88v40a104,104,0,0,0,208,0V112A32,32,0,0,0,200,80ZM152,48a16,16,0,0,1,16,16V80H136V64A16,16,0,0,1,152,48ZM88,64a16,16,0,0,1,32,0v40a16,16,0,0,1-32,0ZM40,88a16,16,0,0,1,32,0v16a16,16,0,0,1-32,0Zm176,40a88,88,0,0,1-175.92,3.75A31.93,31.93,0,0,0,80,125.13a31.93,31.93,0,0,0,44.58,3.35,32.21,32.21,0,0,0,11.8,11.44A47.88,47.88,0,0,0,120,176a8,8,0,0,0,16,0,32,32,0,0,1,32-32,8,8,0,0,0,0-16H152a16,16,0,0,1-16-16V96h64a16,16,0,0,1,16,16Z"/></svg>`,
  'peace':     `<svg width="18" height="18" viewBox="0 0 256 256" fill="#B0FE76" style="overflow:visible"><path d="M212.24,30A28,28,0,0,0,161,36.77L148,85.09,135.05,36.77A28,28,0,1,0,81,51.26l9.38,35-8.73-1.68A28,28,0,0,0,56.8,132.38,27.86,27.86,0,0,0,48,152.87V160a80,80,0,0,0,80,80h.61c43.78-.33,79.39-36.62,79.39-80.9v-3.34a55.88,55.88,0,0,0-11.77-34.27L215,51.26A27.8,27.8,0,0,0,212.24,30ZM97.61,38a12,12,0,0,1,22,2.9l14.77,55.15a28,28,0,0,0-14,4.77,2.26,2.26,0,0,0-.16-.26A27.65,27.65,0,0,0,108,90.35L96.42,47.12A11.94,11.94,0,0,1,97.61,38Zm-33.36,71.6a12,12,0,0,1,14.25-9.34l20.71,4a12,12,0,0,1,9.36,14.16,12,12,0,0,1-14.25,9.34l-20.75-4a12,12,0,0,1-9.32-14.15Zm0,40.72a12,12,0,0,1,14-9.37l10.11,2a12,12,0,0,1,9.36,14.15,12,12,0,0,1-14.2,9.35l-10-2a12,12,0,0,1-9.34-14.16ZM192,159.1c0,35.53-28.49,64.64-63.5,64.9a64.08,64.08,0,0,1-61.56-44.78,30.74,30.74,0,0,0,3.48.95h0l10,2a28.33,28.33,0,0,0,5.61.57,28,28,0,0,0,24.16-42.14c.79-.43,1.57-.89,2.32-1.4l.16.26a27.82,27.82,0,0,0,17.78,12l6.32,1.26a36,36,0,0,0,9.53,32.49A8,8,0,0,0,157.71,174a20,20,0,0,1-3.31-23.51,8,8,0,0,0-5.46-11.66l-15.34-3.07a12,12,0,0,1-9.35-14.15h0a12,12,0,0,1,14.18-9.35l21.41,4.28A40.1,40.1,0,0,1,192,155.76Zm7.59-112-16.62,62a55.55,55.55,0,0,0-20-8.28l-2.5-.5L176.4,40.91a12,12,0,1,1,23.18,6.21Z"/></svg>`,
  'open palm': `<svg width="18" height="18" viewBox="0 0 256 256" fill="#B0FE76" style="overflow:visible"><path d="M188,88a27.75,27.75,0,0,0-12,2.71V60a28,28,0,0,0-41.36-24.6A28,28,0,0,0,80,44v6.71A27.75,27.75,0,0,0,68,48,28,28,0,0,0,40,76v76a88,88,0,0,0,176,0V116A28,28,0,0,0,188,88Zm12,64a72,72,0,0,1-144,0V76a12,12,0,0,1,24,0v44a8,8,0,0,0,16,0V44a12,12,0,0,1,24,0v68a8,8,0,0,0,16,0V60a12,12,0,0,1,24,0v68.67A48.08,48.08,0,0,0,120,176a8,8,0,0,0,16,0,32,32,0,0,1,32-32,8,8,0,0,0,8-8V116a12,12,0,0,1,24,0Z"/></svg>`,
  'pan':       `<svg width="18" height="18" viewBox="0 0 256 256" fill="#B0FE76" style="overflow:visible"><path d="M90.34,61.66a8,8,0,0,1,0-11.32l32-32a8,8,0,0,1,11.32,0l32,32a8,8,0,0,1-11.32,11.32L136,43.31V96a8,8,0,0,1-16,0V43.31L101.66,61.66A8,8,0,0,1,90.34,61.66Zm64,132.68L136,212.69V160a8,8,0,0,0-16,0v52.69l-18.34-18.35a8,8,0,0,0-11.32,11.32l32,32a8,8,0,0,0,11.32,0l32-32a8,8,0,0,0-11.32-11.32Zm83.32-72-32-32a8,8,0,0,0-11.32,11.32L212.69,120H160a8,8,0,0,0,0,16h52.69l-18.35,18.34a8,8,0,0,0,11.32,11.32l32-32A8,8,0,0,0,237.66,122.34ZM43.31,136H96a8,8,0,0,0,0-16H43.31l18.35-18.34A8,8,0,0,0,50.34,90.34l-32,32a8,8,0,0,0,0,11.32l32,32a8,8,0,0,0,11.32-11.32Z"/></svg>`,
  'two hands': `<svg width="18" height="18" viewBox="0 0 256 256" fill="#B0FE76" style="overflow:visible"><path d="M160.22,24V8a8,8,0,0,1,16,0V24a8,8,0,0,1-16,0ZM196.1,41a7.91,7.91,0,0,0,4.17,1.17,8,8,0,0,0,6.84-3.83l8-13.11a8,8,0,0,0-13.68-8.33l-8,13.1A8,8,0,0,0,196.1,41Zm47.51,12.59a8,8,0,0,0-10.08-5.16l-15.06,4.85a8,8,0,0,0,2.46,15.62,8.15,8.15,0,0,0,2.46-.39l15.05-4.85A8,8,0,0,0,243.61,53.55ZM217,97.58a80.22,80.22,0,0,1-10.22,94c-.34,1.73-.72,3.46-1.19,5.18A80.17,80.17,0,0,1,58.77,216L23.5,155a26,26,0,0,1,19.24-38.79l-3-5.2a26,26,0,0,1,19.2-38.78L58.24,71A26,26,0,0,1,95.47,36.53,26.06,26.06,0,0,1,140.3,37l12.26,21.2A26.07,26.07,0,0,1,195.81,61ZM109.07,55l0,0h0l25,43.17a26,26,0,0,1,17.33-10L126.42,45a10,10,0,1,0-17.35,10ZM72.12,63l6.46,11.17a26.05,26.05,0,0,1,17.32-10L89.45,53A10,10,0,1,0,72.12,63Zm111.54,81-20.22-35a10,10,0,0,0-17.74,9.25L158.3,140a8,8,0,0,1-13.87,8l-36.5-63A10,10,0,1,0,90.58,95l26.05,45a8,8,0,0,1-13.87,8L71,93h0l0,0a10,10,0,0,0-17.33,10l35.22,61A8,8,0,0,1,75,172L54.72,137a10,10,0,0,0-17.34,10l35.27,61a64.12,64.12,0,0,0,117.42-15.44A63.52,63.52,0,0,0,183.66,144Zm19.41-38.42L181.93,69A10,10,0,0,0,164.55,79l33,57.05A80.2,80.2,0,0,1,207,161.51,64.23,64.23,0,0,0,203.07,105.58Z"/></svg>`,
  'idle':      `<svg width="18" height="18" viewBox="0 0 256 256" fill="#B0FE76" style="overflow:visible"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Z"/></svg>`,
};

function gestureKey(text: string): string {
  if (text.startsWith('pinch')) return 'pinch';
  if (text.startsWith('fist')) return 'fist';
  if (text.startsWith('peace')) return 'peace';
  if (text.startsWith('point')) return 'point';
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
  const trackScale = parseInt(trackScaleInput.value) / 10;

  const rawPos = gestures.position;
  const pos = {
    x: Math.max(0, Math.min(1, 0.5 + (rawPos.x - 0.5) * trackScale)),
    y: Math.max(0, Math.min(1, 0.5 + (rawPos.y - 0.5) * trackScale)),
  };

  // Update UI
  coordsEl.textContent = `pos: (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}) | zoom: ${gestures.zoom?.toFixed(2) ?? '—'}`;

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
    prevPoint = false;
    pinchOffFrames = 0;
    dwellPos = null;
    dwellStart = null;
    dwellFired = false;
    return;
  }

  // ── Cursor always follows primary hand ─────────────────────────────────────
  send({ type: 'MOVE_CURSOR', x: pos.x, y: pos.y });

  // ── Pinch → drag only ─────────────────────────────────────────────────────
  if (gestures.pinch) {
    pinchOffFrames = 0;
    if (!prevPinch) {
      dragState = 'dragging';
      prevDragPos = { ...pos };
    }
  } else {
    pinchOffFrames++;
  }

  if (dragState === 'dragging') {
    if (gestures.pinch) {
      setGesture('pinch — drag');
      const rawDx = pos.x - prevDragPos!.x;
      const rawDy = pos.y - prevDragPos!.y;
      const dx = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, rawDx));
      const dy = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, rawDy));
      if (Math.abs(dx) > 0.003 || Math.abs(dy) > 0.003) {
        send({ type: 'MOVE_NODE', dx, dy });
      }
      prevDragPos = { ...pos };
    } else if (pinchOffFrames >= PINCH_RELEASE_FRAMES) {
      send({ type: 'MOVE_NODE_END' });
      dragState = 'idle';
      prevDragPos = null;
    }
  }

  // ── Fist → deselect all (blocked during active drag) ──────────────────────
  if (gestures.fist && !prevFist && dragState !== 'dragging') {
    setGesture('fist — deselect');
    send({ type: 'DESELECT_ALL' });
  }

  // ── Peace → undo ───────────────────────────────────────────────────────────
  if (gestures.peace && !prevPeace && dragState !== 'dragging') {
    setGesture('peace — undo');
    send({ type: 'UNDO' });
  }

  // ── Open palm → cursor movement only ──────────────────────────────────────
  if (gestures.openPalm && !prevOpenPalm) {
    setGesture('open palm');
  }

  // ── Point (index only) → select under cursor ──────────────────────────────
  if (gestures.point && !prevPoint) {
    setGesture('point — select');
    send({ type: 'SELECT_AT', x: pos.x, y: pos.y });
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
        const rawDx = pos.x - prevPosition.x;
        const rawDy = pos.y - prevPosition.y;
        const clampedDx = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, rawDx));
        const clampedDy = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, rawDy));
        const dx = clampedDx * panSens;
        const dy = clampedDy * panSens;
        if (Math.abs(dx) > 0.008 || Math.abs(dy) > 0.008) {
          send({ type: 'PAN', dx, dy });
        }
      }
      prevPosition = { ...pos };
    } else if (!gestures.isPanning) {
      prevPosition = null;
    }
  }

  prevPinch = gestures.pinch;
  prevFist = gestures.fist;
  prevPeace = gestures.peace;
  prevOpenPalm = gestures.openPalm;
  prevPoint = gestures.point;
}

connect();
