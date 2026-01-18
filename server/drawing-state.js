/**
 * Authoritative stroke history for a room.
 * Global undo/redo is managed here (server is source of truth).
 *
 * Stroke shape:
 * {
 *  id, userId, tool, color, width,
 *  points: [{x,y}, ...],
 *  createdAt, seq
 * }
 */
export class DrawingState {
  constructor() {
    this.strokes = [];
    this.redo = [];
    this.version = 0;
    this.seq = 0;

    // In-progress strokes keyed by strokeId
    this.live = new Map();
  }

  startStroke(userId, payload) {
    const p = payload || {};
    if (!p.strokeId || typeof p.strokeId !== "string") return false;
    if (!p.point || !this.isPoint(p.point)) return false;

    const tool = p.tool === "eraser" ? "eraser" : "brush";
    const width = this.clampNum(p.width, 1, 80);
    const color = this.sanitizeColor(p.color);

    this.live.set(p.strokeId, {
      id: p.strokeId,
      userId,
      tool,
      color,
      width,
      points: [p.point],
      createdAt: Date.now()
    });
    return true;
  }

  addStrokePoints(userId, payload) {
    const p = payload || {};
    if (!p.strokeId || typeof p.strokeId !== "string") return false;

    const stroke = this.live.get(p.strokeId);
    if (!stroke) return false;
    if (stroke.userId !== userId) return false;

    if (!Array.isArray(p.points)) return false;
    if (p.points.length > 128) return false; // anti-abuse

    for (const pt of p.points) {
      if (!this.isPoint(pt)) continue;
      stroke.points.push(pt);
      if (stroke.points.length > 20000) return false; // hard cap
    }

    return true;
  }

  endStroke(userId, payload) {
    const p = payload || {};
    if (!p.strokeId || typeof p.strokeId !== "string") return null;

    const stroke = this.live.get(p.strokeId);
    if (!stroke) return null;
    if (stroke.userId !== userId) return null;

    this.live.delete(p.strokeId);

    // Commits
    this.seq += 1;
    const committed = {
      ...stroke,
      seq: this.seq
    };

    this.strokes.push(committed);
    this.redo = []; // new action clears redo

    this.version += 1;

    return { stroke: committed };
  }

  undo() {
    if (this.strokes.length === 0) return null;
    const removed = this.strokes.pop();
    this.redo.push(removed);
    this.version += 1;
    return removed;
  }

  redoStroke() {
    if (this.redo.length === 0) return null;
    const restored = this.redo.pop();
    this.strokes.push(restored);
    this.version += 1;
    return restored;
  }

  isPoint(pt) {
    return pt && Number.isFinite(pt.x) && Number.isFinite(pt.y);
  }

  clampNum(n, min, max) {
    const v = Number(n);
    if (!Number.isFinite(v)) return min;
    return Math.max(min, Math.min(max, v));
  }

  sanitizeColor(c) {
    if (typeof c !== "string") return "#111827";
    const s = c.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
    return "#111827";
  }
}
