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
    point: boolean;
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
  'no hands':   `<svg width="22" height="22" viewBox="0 0 256 256" fill="#B0FE76"><path d="M53.92,34.62A8,8,0,1,0,42.08,45.38L61.32,66.55C25,88.84,9.38,123.2,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208a127.11,127.11,0,0,0,52.07-10.83l22,24.21a8,8,0,1,0,11.84-10.76Zm47.33,75.84,41.67,45.85a32,32,0,0,1-41.67-45.85ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.16,133.16,0,0,1,25,128c4.69-8.79,19.66-33.39,47.35-49.38l18,19.75a48,48,0,0,0,63.66,70l14.73,16.2A112,112,0,0,1,128,192Zm6-95.43a8,8,0,0,1,3-15.72,48.16,48.16,0,0,1,38.77,42.64,8,8,0,0,1-7.22,8.71,6.39,6.39,0,0,1-.75,0,8,8,0,0,1-8-7.26A32.09,32.09,0,0,0,134,96.57Zm113.28,34.69c-.42.94-10.55,23.37-33.36,43.8a8,8,0,1,1-10.67-11.92A132.77,132.77,0,0,0,231.05,128a133.15,133.15,0,0,0-23.12-30.77C185.67,75.19,158.78,64,128,64a118.37,118.37,0,0,0-19.36,1.57A8,8,0,1,1,106,49.79,134,134,0,0,1,128,48c34.88,0,66.57,13.26,91.66,38.35,18.83,18.83,27.3,37.62,27.65,38.41A8,8,0,0,1,247.31,131.26Z"/></svg>`,
  'point':      `<svg width="22" height="22" viewBox="0 0 256 256" fill="#B0FE76"><path d="M196,88a27.86,27.86,0,0,0-13.35,3.39A28,28,0,0,0,144,74.7V44a28,28,0,0,0-56,0v80l-3.82-6.13A28,28,0,0,0,35.73,146l4.67,8.23C74.81,214.89,89.05,240,136,240a88.1,88.1,0,0,0,88-88V116A28,28,0,0,0,196,88Zm12,64a72.08,72.08,0,0,1-72,72c-37.63,0-47.84-18-81.68-77.68l-4.69-8.27,0-.05A12,12,0,0,1,54,121.61a11.88,11.88,0,0,1,6-1.6,12,12,0,0,1,10.41,6,1.76,1.76,0,0,0,.14.23l18.67,30A8,8,0,0,0,104,152V44a12,12,0,0,1,24,0v68a8,8,0,0,0,16,0V100a12,12,0,0,1,24,0v20a8,8,0,0,0,16,0v-4a12,12,0,0,1,24,0Z"/></svg>`,
  'pinch':      `<svg width="22" height="22" viewBox="0 0 256 256" fill="#B0FE76"><path d="M188,80a27.79,27.79,0,0,0-13.36,3.4,28,28,0,0,0-46.64-11A28,28,0,0,0,80,92v20H68a28,28,0,0,0-28,28v12a88,88,0,0,0,176,0V108A28,28,0,0,0,188,80Zm12,72a72,72,0,0,1-144,0V140a12,12,0,0,1,12-12H80v24a8,8,0,0,0,16,0V92a12,12,0,0,1,24,0v28a8,8,0,0,0,16,0V92a12,12,0,0,1,24,0v28a8,8,0,0,0,16,0V108a12,12,0,0,1,24,0Z"/></svg>`,
  'fist':       `<svg width="22" height="22" viewBox="0 0 256 256" fill="#B0FE76"><path d="M200,80H184V64a32,32,0,0,0-56-21.13A32,32,0,0,0,72.21,60.42,32,32,0,0,0,24,88v40a104,104,0,0,0,208,0V112A32,32,0,0,0,200,80ZM152,48a16,16,0,0,1,16,16V80H136V64A16,16,0,0,1,152,48ZM88,64a16,16,0,0,1,32,0v40a16,16,0,0,1-32,0ZM40,88a16,16,0,0,1,32,0v16a16,16,0,0,1-32,0Zm176,40a88,88,0,0,1-175.92,3.75A31.93,31.93,0,0,0,80,125.13a31.93,31.93,0,0,0,44.58,3.35,32.21,32.21,0,0,0,11.8,11.44A47.88,47.88,0,0,0,120,176a8,8,0,0,0,16,0,32,32,0,0,1,32-32,8,8,0,0,0,0-16H152a16,16,0,0,1-16-16V96h64a16,16,0,0,1,16,16Z"/></svg>`,
  'peace':      `<svg width="22" height="22" viewBox="0 0 256 256" fill="#B0FE76"><path d="M212.24,30A28,28,0,0,0,161,36.77L148,85.09,135.05,36.77A28,28,0,1,0,81,51.26l9.38,35-8.73-1.68A28,28,0,0,0,56.8,132.38,27.86,27.86,0,0,0,48,152.87V160a80,80,0,0,0,80,80h.61c43.78-.33,79.39-36.62,79.39-80.9v-3.34a55.88,55.88,0,0,0-11.77-34.27L215,51.26A27.8,27.8,0,0,0,212.24,30ZM97.61,38a12,12,0,0,1,22,2.9l14.77,55.15a28,28,0,0,0-14,4.77,2.26,2.26,0,0,0-.16-.26A27.65,27.65,0,0,0,108,90.35L96.42,47.12A11.94,11.94,0,0,1,97.61,38Zm-33.36,71.6a12,12,0,0,1,14.25-9.34l20.71,4a12,12,0,0,1,9.36,14.16,12,12,0,0,1-14.25,9.34l-20.75-4a12,12,0,0,1-9.32-14.15Zm0,40.72a12,12,0,0,1,14-9.37l10.11,2a12,12,0,0,1,9.36,14.15,12,12,0,0,1-14.2,9.35l-10-2a12,12,0,0,1-9.34-14.16ZM192,159.1c0,35.53-28.49,64.64-63.5,64.9a64.08,64.08,0,0,1-61.56-44.78,30.74,30.74,0,0,0,3.48.95h0l10,2a28.33,28.33,0,0,0,5.61.57,28,28,0,0,0,24.16-42.14c.79-.43,1.57-.89,2.32-1.4l.16.26a27.82,27.82,0,0,0,17.78,12l6.32,1.26a36,36,0,0,0,9.53,32.49A8,8,0,0,0,157.71,174a20,20,0,0,1-3.31-23.51,8,8,0,0,0-5.46-11.66l-15.34-3.07a12,12,0,0,1-9.35-14.15h0a12,12,0,0,1,14.18-9.35l21.41,4.28A40.1,40.1,0,0,1,192,155.76Zm7.59-112-16.62,62a55.55,55.55,0,0,0-20-8.28l-2.5-.5L176.4,40.91a12,12,0,1,1,23.18,6.21Z"/></svg>`,
  'open palm':  `<svg width="22" height="22" viewBox="0 0 256 256" fill="#B0FE76"><path d="M188,88a27.75,27.75,0,0,0-12,2.71V60a28,28,0,0,0-41.36-24.6A28,28,0,0,0,80,44v6.71A27.75,27.75,0,0,0,68,48,28,28,0,0,0,40,76v76a88,88,0,0,0,176,0V116A28,28,0,0,0,188,88Zm12,64a72,72,0,0,1-144,0V76a12,12,0,0,1,24,0v44a8,8,0,0,0,16,0V44a12,12,0,0,1,24,0v68a8,8,0,0,0,16,0V60a12,12,0,0,1,24,0v68.67A48.08,48.08,0,0,0,120,176a8,8,0,0,0,16,0,32,32,0,0,1,32-32,8,8,0,0,0,8-8V116a12,12,0,0,1,24,0Z"/></svg>`,
  'pan':        `<svg width="22" height="22" viewBox="0 0 256 256" fill="#B0FE76"><path d="M90.34,61.66a8,8,0,0,1,0-11.32l32-32a8,8,0,0,1,11.32,0l32,32a8,8,0,0,1-11.32,11.32L136,43.31V96a8,8,0,0,1-16,0V43.31L101.66,61.66A8,8,0,0,1,90.34,61.66Zm64,132.68L136,212.69V160a8,8,0,0,0-16,0v52.69l-18.34-18.35a8,8,0,0,0-11.32,11.32l32,32a8,8,0,0,0,11.32,0l32-32a8,8,0,0,0-11.32-11.32Zm83.32-72-32-32a8,8,0,0,0-11.32,11.32L212.69,120H160a8,8,0,0,0,0,16h52.69l-18.35,18.34a8,8,0,0,0,11.32,11.32l32-32A8,8,0,0,0,237.66,122.34ZM43.31,136H96a8,8,0,0,0,0-16H43.31l18.35-18.34A8,8,0,0,0,50.34,90.34l-32,32a8,8,0,0,0,0,11.32l32,32a8,8,0,0,0,11.32-11.32Z"/></svg>`,
  'zoom':       `<svg width="22" height="22" viewBox="0 0 256 256" fill="#B0FE76"><path d="M160.22,24V8a8,8,0,0,1,16,0V24a8,8,0,0,1-16,0ZM196.1,41a7.91,7.91,0,0,0,4.17,1.17,8,8,0,0,0,6.84-3.83l8-13.11a8,8,0,0,0-13.68-8.33l-8,13.1A8,8,0,0,0,196.1,41Zm47.51,12.59a8,8,0,0,0-10.08-5.16l-15.06,4.85a8,8,0,0,0,2.46,15.62,8.15,8.15,0,0,0,2.46-.39l15.05-4.85A8,8,0,0,0,243.61,53.55ZM217,97.58a80.22,80.22,0,0,1-10.22,94c-.34,1.73-.72,3.46-1.19,5.18A80.17,80.17,0,0,1,58.77,216L23.5,155a26,26,0,0,1,19.24-38.79l-3-5.2a26,26,0,0,1,19.2-38.78L58.24,71A26,26,0,0,1,95.47,36.53,26.06,26.06,0,0,1,140.3,37l12.26,21.2A26.07,26.07,0,0,1,195.81,61ZM109.07,55l0,0h0l25,43.17a26,26,0,0,1,17.33-10L126.42,45a10,10,0,1,0-17.35,10ZM72.12,63l6.46,11.17a26.05,26.05,0,0,1,17.32-10L89.45,53A10,10,0,1,0,72.12,63Zm111.54,81-20.22-35a10,10,0,0,0-17.74,9.25L158.3,140a8,8,0,0,1-13.87,8l-36.5-63A10,10,0,1,0,90.58,95l26.05,45a8,8,0,0,1-13.87,8L71,93h0l0,0a10,10,0,0,0-17.33,10l35.22,61A8,8,0,0,1,75,172L54.72,137a10,10,0,0,0-17.34,10l35.27,61a64.12,64.12,0,0,0,117.42-15.44A63.52,63.52,0,0,0,183.66,144Zm19.41-38.42L181.93,69A10,10,0,0,0,164.55,79l33,57.05A80.2,80.2,0,0,1,207,161.51,64.23,64.23,0,0,0,203.07,105.58Z"/></svg>`,
  'idle':       `<svg width="22" height="22" viewBox="0 0 256 256" fill="#B0FE76"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Z"/></svg>`,
};

function gestureKey(text: string): string {
  if (text.startsWith('pinch')) return 'pinch';
  if (text.startsWith('fist')) return 'fist';
  if (text.startsWith('peace')) return 'peace';
  if (text.startsWith('point')) return 'point';
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
  if (!isExtended(lm,0)&&!isExtended(lm,1)&&!isExtended(lm,2)&&!isExtended(lm,3)) return 'fist';
  if (dist(lm[4], lm[8]) < PINCH_THRESHOLD) return 'pinch';
  if (isExtended(lm,0)&&!isExtended(lm,1)&&!isExtended(lm,2)&&!isExtended(lm,3)) return 'point';
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
        let point = false;

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
          point     = classified === 'point';

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
          gestures: { pinch, position, zoom, rotation, isPanning, fist, peace, openPalm, point },
        };

        ws.send(JSON.stringify(msg));
        updateGesture(
          hands.length === 0 ? 'no hands'
            : pinch ? 'pinch'
            : fist ? 'fist'
            : peace ? 'peace'
            : point ? 'point — select'
            : openPalm ? 'open palm'
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
  { key: 'pinch',  name: 'Pinch',     action: 'Drag node' },
  { key: 'point',  name: 'Point',     action: 'Select node' },
  { key: 'fist',   name: 'Fist',      action: 'Deselect all' },
  { key: 'peace',  name: 'Peace ✌',  action: 'Undo' },
  { key: 'pan',    name: '3 Fingers', action: 'Pan viewport' },
  { key: 'zoom',   name: 'Two Hands', action: 'Zoom + rotate' },
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
