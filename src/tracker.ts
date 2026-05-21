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

let wsManualClose = false;

function connectWs(roomId: string) {
  wsManualClose = false;
  const WS_URL = `wss://${RELAY_HOST}/ws?room=${roomId}`;
  ws = new WebSocket(WS_URL);
  ws.onopen = () => updateStatus(`Connected (room: ${roomId})`, 'green');
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'room_closed') {
        wsManualClose = true;
        document.getElementById('btn-disconnect')!.click();
      }
    } catch {}
  };
  ws.onclose = () => {
    if (wsManualClose) return;
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

function classifyGesture(results: { landmarks: Array<Array<{ x: number; y: number; z: number }>> }): string {
  if (results.landmarks.length === 0) return 'no hands';
  if (results.landmarks.length === 2) return 'zoom';
  const lm = results.landmarks[0];
  if (dist(lm[4], lm[8]) < PINCH_THRESHOLD) return 'pinch';
  if (!isExtended(lm,0)&&!isExtended(lm,1)&&!isExtended(lm,2)&&!isExtended(lm,3)) return 'fist';
  if (isExtended(lm,0)&&isExtended(lm,1)&&!isExtended(lm,2)&&!isExtended(lm,3)) return 'peace';
  if (isExtended(lm,0)&&isExtended(lm,1)&&isExtended(lm,2)&&!isExtended(lm,3)) return 'pan';
  if (isExtended(lm,0)&&isExtended(lm,1)&&isExtended(lm,2)&&isExtended(lm,3)) return 'open palm';
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
  (document.getElementById('btn-disconnect') as HTMLButtonElement).style.display = 'block';

  const video = document.getElementById('video') as HTMLVideoElement;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;

  let stopped = false;

  document.getElementById('btn-disconnect')!.onclick = () => {
    stopped = true;
    wsManualClose = true;
    ws?.close();
    stream.getTracks().forEach(t => t.stop());
    video.srcObject = null;
    document.getElementById('tracker-ui')!.style.display = 'none';
    document.getElementById('room-entry')!.style.display = 'flex';
    (document.getElementById('btn-disconnect') as HTMLButtonElement).style.display = 'none';
    (document.getElementById('room-input') as HTMLInputElement).value = '';
    updateStatus('—', 'red');
  };

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
    if (stopped) return;
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

          const classified = classifyGesture(results);
          fist      = classified === 'fist';
          peace     = classified === 'peace';
          isPanning = classified === 'pan';
          openPalm  = classified === 'open palm';

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

// ── Wizard ────────────────────────────────────────────────────────────────────

const WIZARD_GESTURES = [
  { key: 'pinch',     name: 'Pinch',     action: 'Drag node' },
  { key: 'open palm', name: 'Open Palm', action: 'Select node' },
  { key: 'fist',      name: 'Fist',      action: 'Deselect all' },
  { key: 'peace',     name: 'Peace ✌',  action: 'Undo' },
  { key: 'pan',       name: '3 Fingers', action: 'Pan viewport' },
  { key: 'zoom',      name: 'Two Hands', action: 'Zoom + rotate' },
] as const;

function showRoomEntry() {
  document.getElementById('wizard')!.style.display = 'none';
  document.getElementById('room-entry')!.style.display = 'flex';
}

async function startGesturePractice() {
  let currentIdx = 0;
  let consecutiveFrames = 0;
  let practiceStopped = false;
  const video = document.getElementById('video') as HTMLVideoElement;
  const preview = document.getElementById('wizard-preview') as HTMLCanvasElement;

  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
  video.srcObject = stream;
  await video.play();
  preview.width = video.videoWidth;
  preview.height = video.videoHeight;

  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
  const hl = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
    numHands: 2,
    runningMode: 'VIDEO',
  });

  function updateWizardUI() {
    const g = WIZARD_GESTURES[currentIdx];
    document.getElementById('wizard-gesture-name')!.textContent = g.name;
    document.getElementById('wizard-gesture-action')!.textContent = '→ ' + g.action;
    document.getElementById('wizard-gesture-icon')!.innerHTML = GESTURE_ICONS[g.key] ?? '';
    document.getElementById('wizard-count')!.textContent = String(currentIdx);
    document.getElementById('wizard-hold-bar')!.style.width = '0%';
    document.getElementById('wizard-gesture-status')!.textContent = '';
  }

  updateWizardUI();
  let lastVideoTime = -1;

  function stopStream() {
    stream.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }

  function practiceLoop() {
    if (practiceStopped) return;
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const results = hl.detectForVideo(video, Date.now());

      const pCtx = preview.getContext('2d')!;
      pCtx.save();
      pCtx.scale(-1, 1);
      pCtx.drawImage(video, -preview.width, 0);
      pCtx.restore();

      const detected = classifyGesture(results);
      const target = WIZARD_GESTURES[currentIdx].key;

      if (detected === target) {
        consecutiveFrames = Math.min(consecutiveFrames + 1, 15);
      } else {
        consecutiveFrames = 0;
      }

      document.getElementById('wizard-hold-bar')!.style.width = (consecutiveFrames / 15 * 100) + '%';

      if (consecutiveFrames >= 15) {
        consecutiveFrames = 0;
        currentIdx++;
        document.getElementById('wizard-count')!.textContent = String(currentIdx);
        if (currentIdx >= WIZARD_GESTURES.length) {
          practiceStopped = true;
          stopStream();
          localStorage.setItem('hc-wizard-done', '1');
          (document.getElementById('wizard-connect') as HTMLButtonElement).disabled = false;
          document.getElementById('wizard-gesture-status')!.textContent = '✓ All done!';
        } else {
          document.getElementById('wizard-gesture-status')!.textContent = '✓ Got it!';
          setTimeout(updateWizardUI, 600);
        }
      }
    }
    requestAnimationFrame(practiceLoop);
  }

  practiceLoop();

  document.getElementById('wizard-skip')!.onclick = () => {
    practiceStopped = true;
    stopStream();
    localStorage.setItem('hc-wizard-done', '1');
    showRoomEntry();
  };

  document.getElementById('wizard-connect')!.onclick = () => showRoomEntry();
}

function initWizard() {
  (document.getElementById('wizard-connect') as HTMLButtonElement).disabled = true;
  document.getElementById('wizard-step-1')!.style.display = 'flex';
  document.getElementById('wizard-step-2')!.style.display = 'none';
  document.getElementById('wizard')!.style.display = 'flex';

  document.getElementById('wizard-start')!.onclick = () => {
    document.getElementById('wizard-step-1')!.style.display = 'none';
    document.getElementById('wizard-step-2')!.style.display = 'flex';
    startGesturePractice().catch(err => console.error('Wizard practice error:', err));
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────
const urlRoom = new URLSearchParams(window.location.search).get('room');

if (urlRoom) {
  startTracker(urlRoom).catch(err => {
    updateStatus(`Error: ${err.message}`, 'red');
  });
} else {
  if (localStorage.getItem('hc-wizard-done')) {
    showRoomEntry();
  } else {
    initWizard();
  }

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

  document.getElementById('show-guide-again')!.onclick = () => {
    localStorage.removeItem('hc-wizard-done');
    document.getElementById('room-entry')!.style.display = 'none';
    initWizard();
  };
}
