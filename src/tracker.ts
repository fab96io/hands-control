import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

// ── Shared types (mirrored in figma-plugin/src/ui.ts) ────────────────────────
export type HandMessage = {
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

// ── Constants ─────────────────────────────────────────────────────────────────
const RELAY_HOST = 'hand-relay.fly.dev';
const PINCH_THRESHOLD = 0.06;
const THROTTLE_MS = 1000 / 30;

const MEDIAPIPE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// ── State ─────────────────────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let lastSendTs = 0;

const POS_ALPHA = 0.25;
const POINT_ALPHA = 0.45;
let smoothPos = { x: 0.5, y: 0.5 };
let smoothInitialized = false;
let prevPointing = false;

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isExtended(lm: Array<{ x: number; y: number; z: number }>, finger: number): boolean {
  const tips = [8, 12, 16, 20];
  const pips = [6, 10, 14, 18];
  return lm[tips[finger]].y < lm[pips[finger]].y;
}

function connectWs(roomId: string) {
  const WS_URL = `wss://${RELAY_HOST}/ws?room=${roomId}`;
  ws = new WebSocket(WS_URL);
  ws.onopen = () => updateStatus(`Connected (room: ${roomId})`, 'green');
  ws.onclose = () => {
    updateStatus('Disconnected — retrying…', 'red');
    setTimeout(() => connectWs(roomId), 2000);
  };
  ws.onerror = () => ws?.close();
}

function updateStatus(text: string, color: string) {
  const el = document.getElementById('status');
  if (el) { el.textContent = text; el.style.color = color === 'green' ? '' : color; }
  const dot = document.getElementById('dot');
  if (dot) dot.className = 'dot' + (color === 'green' ? ' connected' : '');
}

const GESTURE_ICONS: Record<string, string> = {
  'no hands':   `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
  'pinch':      `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8l-2-2.5a1.5 1.5 0 0 0-2.5 1.5l3 5A5 5 0 0 0 9 21h6a5 5 0 0 0 5-5v-5a2 2 0 0 0-4 0v1"/></svg>`,
  'fist':       `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="13" rx="2"/><path d="M7 8V6a2 2 0 0 1 4 0v2"/><path d="M11 8V5a2 2 0 0 1 4 0v3"/><path d="M15 8V7a2 2 0 0 1 4 0v1"/></svg>`,
  'peace':      `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="12" y1="12" x2="4.93" y2="19.07"/><line x1="12" y1="12" x2="19.07" y2="19.07"/></svg>`,
  'open palm':  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10V5a2 2 0 0 0-4 0v9"/><path d="M6 14v-3a2 2 0 0 0-4 0v5a8 8 0 0 0 8 8h4a8 8 0 0 0 8-8V6a2 2 0 0 0-4 0v8"/></svg>`,
  'pan':        `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>`,
  'zoom':       `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
  'idle':       `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>`,
};

function gestureKey(text: string): string {
  if (text.startsWith('pinch')) return 'pinch';
  if (text.startsWith('fist')) return 'fist';
  if (text.startsWith('peace')) return 'peace';
  if (text.startsWith('open palm')) return 'open palm';
  if (text.startsWith('pan')) return 'pan';
  if (text.startsWith('zoom') || text.startsWith('two')) return 'zoom';
  if (text.startsWith('no hands')) return 'no hands';
  return 'idle';
}

function updateGesture(text: string) {
  const el = document.getElementById('gesture');
  if (el) el.textContent = text;
  const icon = document.getElementById('gesture-icon');
  if (icon) icon.innerHTML = GESTURE_ICONS[gestureKey(text)] ?? GESTURE_ICONS['idle'];
}

async function startTracker(roomId: string) {
  document.getElementById('room-entry')!.style.display = 'none';
  document.getElementById('tracker-ui')!.style.display = 'contents';

  const video = document.getElementById('video') as HTMLVideoElement;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;

  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
  video.srcObject = stream;
  await video.play();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  updateStatus('Loading MediaPipe…', 'orange');

  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
  const handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
    numHands: 2,
    runningMode: 'VIDEO',
  });

  updateStatus('MediaPipe ready', 'blue');
  connectWs(roomId);

  let lastVideoTime = -1;

  function detect() {
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const results = handLandmarker.detectForVideo(video, Date.now());

      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(video, -canvas.width, 0);
      ctx.restore();

      const now = Date.now();
      if (now - lastSendTs >= THROTTLE_MS && ws?.readyState === WebSocket.OPEN) {
        lastSendTs = now;

        const hands = results.landmarks.map((lm, i) => ({
          handedness: (results.handedness[i]?.[0]?.categoryName ?? 'Right') as 'Left' | 'Right',
          landmarks: lm.map(p => ({ x: p.x, y: p.y, z: p.z })),
        }));

        if (hands.length === 0) smoothInitialized = false;

        const primary = hands[0];
        let pinch = false;
        let position = { x: 0.5, y: 0.5 };
        let zoom: number | null = null;
        let isPanning = false;
        let fist = false;
        let peace = false;
        let openPalm = false;

        if (primary) {
          const thumbTip = primary.landmarks[4];
          const indexTip = primary.landmarks[8];

          const palmIdxs = [0, 5, 9, 13, 17];
          const palmX = palmIdxs.reduce((s, i) => s + primary.landmarks[i].x, 0) / palmIdxs.length;
          const palmY = palmIdxs.reduce((s, i) => s + primary.landmarks[i].y, 0) / palmIdxs.length;

          pinch = dist(thumbTip, indexTip) < PINCH_THRESHOLD;

          if (!smoothInitialized) {
            smoothPos = { x: 1 - palmX, y: palmY };
            smoothInitialized = true;
          } else {
            smoothPos.x = POS_ALPHA * (1 - palmX) + (1 - POS_ALPHA) * smoothPos.x;
            smoothPos.y = POS_ALPHA * palmY + (1 - POS_ALPHA) * smoothPos.y;
          }

          position = { x: smoothPos.x, y: smoothPos.y };

          fist = !pinch
            && !isExtended(primary.landmarks, 0)
            && !isExtended(primary.landmarks, 1)
            && !isExtended(primary.landmarks, 2)
            && !isExtended(primary.landmarks, 3);

          peace = !pinch
            && isExtended(primary.landmarks, 0)
            && isExtended(primary.landmarks, 1)
            && !isExtended(primary.landmarks, 2)
            && !isExtended(primary.landmarks, 3);

          isPanning = !pinch
            && isExtended(primary.landmarks, 0)
            && isExtended(primary.landmarks, 1)
            && isExtended(primary.landmarks, 2)
            && !isExtended(primary.landmarks, 3);

          openPalm = !pinch
            && isExtended(primary.landmarks, 0)
            && isExtended(primary.landmarks, 1)
            && isExtended(primary.landmarks, 2)
            && isExtended(primary.landmarks, 3);

          ctx.fillStyle = pinch ? 'red' : 'lime';
          for (const lm of primary.landmarks) {
            ctx.beginPath();
            ctx.arc((1 - lm.x) * canvas.width, lm.y * canvas.height, 4, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        let rotation: number | null = null;
        if (hands.length === 2) {
          const w0 = hands[0].landmarks[0];
          const w1 = hands[1].landmarks[0];
          zoom = dist(w0, w1);
          rotation = Math.atan2(w1.y - w0.y, w1.x - w0.x) * 180 / Math.PI;
        }

        const msg: HandMessage = {
          type: 'hand_update',
          timestamp: now,
          hands,
          gestures: { pinch, position, zoom, rotation, isPanning, fist, peace, openPalm },
        };

        ws.send(JSON.stringify(msg));
        updateGesture(
          hands.length === 0 ? 'no hands'
            : pinch ? 'pinch'
            : fist ? 'fist'
            : peace ? 'peace'
            : openPalm ? 'open palm — select'
            : zoom !== null ? `zoom (dist: ${zoom.toFixed(2)})`
            : isPanning ? 'pan (3 fingers)'
            : 'idle'
        );
      }
    }

    requestAnimationFrame(detect);
  }

  detect();
}

// ── Entry point ───────────────────────────────────────────────────────────────
const urlRoom = new URLSearchParams(window.location.search).get('room');

if (urlRoom) {
  startTracker(urlRoom).catch(err => {
    updateStatus(`Error: ${err.message}`, 'red');
  });
} else {
  // Show room entry form
  document.getElementById('room-entry')!.style.display = 'flex';
  document.getElementById('tracker-ui')!.style.display = 'none';

  const form = document.getElementById('room-form') as HTMLFormElement;
  const input = document.getElementById('room-input') as HTMLInputElement;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = input.value.trim().toUpperCase();
    if (!id) return;
    startTracker(id).catch(err => {
      updateStatus(`Error: ${err.message}`, 'red');
    });
  });
}
