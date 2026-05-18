/// <reference types="@figma/plugin-typings" />

type PluginCommand =
  | { type: 'MOVE_CURSOR'; x: number; y: number }
  | { type: 'SELECT_AT'; x: number; y: number }
  | { type: 'PAN'; dx: number; dy: number }
  | { type: 'ZOOM'; factor: number }
  | { type: 'ROTATE_NODE'; angleDeg: number }
  | { type: 'MOVE_NODE'; dx: number; dy: number }
  | { type: 'MOVE_NODE_END' }
  | { type: 'UNDO' }
  | { type: 'DESELECT_ALL' }
  | { type: 'OPEN_URL'; url: string };

const CURSOR_NAME = '__hand_cursor__';

let draggingNodes: SceneNode[] = [];
const CURSOR_SIZE = 16;

figma.showUI(__html__, { width: 320, height: 300, title: 'Hand Control' });

// ── Cursor frame ──────────────────────────────────────────────────────────────
function getOrCreateCursor(): FrameNode {
  const existing = figma.currentPage.findChild(n => n.name === CURSOR_NAME) as FrameNode | null;
  if (existing) return existing;

  const f = figma.createFrame();
  f.name = CURSOR_NAME;
  f.resize(CURSOR_SIZE, CURSOR_SIZE);
  f.cornerRadius = CURSOR_SIZE / 2;
  f.fills = [{ type: 'SOLID', color: { r: 1, g: 0.2, b: 0.2 }, opacity: 0.8 }];
  f.strokes = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  f.strokeWeight = 2;
  f.locked = true;
  figma.currentPage.appendChild(f);
  return f;
}

// Convert normalized (0-1) to canvas coords using current viewport
function toCanvas(nx: number, ny: number): { x: number; y: number } {
  const b = figma.viewport.bounds;
  return {
    x: b.x + nx * b.width,
    y: b.y + ny * b.height,
  };
}

function moveCursor(nx: number, ny: number) {
  const cursor = getOrCreateCursor();
  const { x, y } = toCanvas(nx, ny);
  cursor.x = x - CURSOR_SIZE / 2;
  cursor.y = y - CURSOR_SIZE / 2;
  // Keep cursor on top
  figma.currentPage.appendChild(cursor);
}

function selectAt(nx: number, ny: number) {
  const { x, y } = toCanvas(nx, ny);
  const hits = figma.currentPage.findAll(node => {
    if (node.name === CURSOR_NAME) return false;
    const box = (node as any).absoluteBoundingBox as { x: number; y: number; width: number; height: number } | null;
    if (!box) return false;
    return box.x <= x && x <= box.x + box.width && box.y <= y && y <= box.y + box.height;
  });
  if (hits.length > 0) {
    figma.currentPage.selection = [hits[hits.length - 1] as SceneNode];
  }
}

function pan(dx: number, dy: number) {
  const b = figma.viewport.bounds;
  figma.viewport.center = {
    x: figma.viewport.center.x - dx * b.width,
    y: figma.viewport.center.y - dy * b.height,
  };
}

function zoom(factor: number) {
  const selected = figma.currentPage.selection.filter(n => n.name !== CURSOR_NAME);
  if (selected.length > 0) return;
  const clamped = Math.max(0.01, Math.min(256, figma.viewport.zoom * factor));
  figma.viewport.zoom = clamped;
}

function moveNode(dx: number, dy: number) {
  if (draggingNodes.length === 0) {
    draggingNodes = figma.currentPage.selection
      .filter(n => n.name !== CURSOR_NAME) as SceneNode[];
  }
  const b = figma.viewport.bounds;
  for (const node of draggingNodes) {
    if ('x' in node && 'y' in node) {
      (node as any).x += dx * b.width;
      (node as any).y += dy * b.height;
    }
  }
}

function moveNodeEnd() { draggingNodes = []; }

function rotateNode(angleDeg: number) {
  const rad = -angleDeg * Math.PI / 180;
  for (const node of figma.currentPage.selection) {
    if (node.name === CURSOR_NAME) continue;
    if (!('relativeTransform' in node)) continue;
    const n = node as SceneNode & { relativeTransform: Transform; width: number; height: number };
    const t = n.relativeTransform;
    const curAngle = Math.atan2(t[1][0], t[0][0]);
    const newAngle = curAngle + rad;
    const tx = t[0][2], ty = t[1][2];
    const w = n.width, h = n.height;
    // Center in parent space
    const cx = tx + (w / 2) * Math.cos(curAngle) - (h / 2) * Math.sin(curAngle);
    const cy = ty + (w / 2) * Math.sin(curAngle) + (h / 2) * Math.cos(curAngle);
    // New top-left to keep center fixed
    const newTx = cx - (w / 2) * Math.cos(newAngle) + (h / 2) * Math.sin(newAngle);
    const newTy = cy - (w / 2) * Math.sin(newAngle) - (h / 2) * Math.cos(newAngle);
    n.relativeTransform = [
      [Math.cos(newAngle), -Math.sin(newAngle), newTx],
      [Math.sin(newAngle),  Math.cos(newAngle), newTy],
    ];
  }
}

function undo() { figma.history?.undo(); }

function deselectAll() { figma.currentPage.selection = []; }

// ── Message handler ───────────────────────────────────────────────────────────
figma.ui.onmessage = (msg: PluginCommand) => {
  switch (msg.type) {
    case 'MOVE_CURSOR':
      moveCursor(msg.x, msg.y);
      break;
    case 'SELECT_AT':
      selectAt(msg.x, msg.y);
      break;
    case 'PAN':
      pan(msg.dx, msg.dy);
      break;
    case 'ZOOM':
      zoom(msg.factor);
      break;
    case 'MOVE_NODE':
      moveNode(msg.dx, msg.dy);
      break;
    case 'ROTATE_NODE':
      rotateNode(msg.angleDeg);
      break;
    case 'MOVE_NODE_END':
      moveNodeEnd();
      break;
    case 'UNDO':
      undo();
      break;
    case 'DESELECT_ALL':
      deselectAll();
      break;
    case 'OPEN_URL':
      figma.openExternal(msg.url);
      break;
  }
};

figma.on('close', () => {
  draggingNodes = [];
  const cursor = figma.currentPage.findChild(n => n.name === CURSOR_NAME);
  cursor?.remove();
});
