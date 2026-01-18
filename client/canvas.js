function uuid() {
  // Browser-safe unique id
  return (crypto.randomUUID && crypto.randomUUID()) || `id_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export class CanvasEngine {
  constructor({ baseCanvas, liveCanvas, stage }) {
    this.baseCanvas = baseCanvas;
    this.liveCanvas = liveCanvas;
    this.stage = stage;

    this.baseCtx = baseCanvas.getContext("2d");
    this.liveCtx = liveCanvas.getContext("2d");

    // World transform (CSS pixels)
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;

    // State
    this.me = null;
    this.users = new Map(); // id -> user
    this.cursors = new Map(); // id -> {x,y,isDown,ts}

    this.committed = [];
    this.remoteLive = new Map(); // strokeId -> strokeLike
    this.localLive = null;

    this.undoCount = 0;
    this.redoCount = 0;

    // Checkpoint cache for fast redraw
    this.checkpoints = []; // { count, imageData }
    this.checkpointEvery = 30;
    this.maxCheckpoints = 10;

    // Emission hooks
    this._onCursor = null;
    this._onStrokeStart = null;
    this._onStrokePoints = null;
    this._onStrokeEnd = null;
    this._getLocalTool = () => ({ tool: "brush", color: "#3b82f6", width: 8 });

    // Pointer tracking
    this.isPointerDown = false;
    this.isPanning = false;
    this.lastPan = null;

    // Batched outgoing points
    this.outgoingPoints = [];
    this.lastSentAt = 0;

    this._bind();
    this._resizeToStage();
    this._loop();
  }

  setGetLocalTool(fn) {
    this._getLocalTool = fn;
  }

  setMe(user) {
    this.me = user;
    if (user) this.users.set(user.id, user);
  }

  getMeId() {
    return this.me?.id || null;
  }

  getUsers() {
    return Array.from(this.users.values());
  }

  addUser(user) {
    this.users.set(user.id, user);
  }

  removeUser(userId) {
    this.users.delete(userId);
    this.cursors.delete(userId);
    // removes any remote live strokes belonging to that user
    for (const [sid, s] of this.remoteLive.entries()) {
      if (s.userId === userId) this.remoteLive.delete(sid);
    }
  }

  setHistoryCounts(undoCount, redoCount) {
    this.undoCount = undoCount;
    this.redoCount = redoCount;
  }

  setCommittedStrokes(strokes) {
    this.committed = Array.isArray(strokes) ? strokes : [];
    this._resetCheckpoints();
    this._redrawBaseFromScratch();
  }

  setGetLocalColorFromMe() {
    // optional helper
  }

  onCursor(fn) { this._onCursor = fn; }
  onStrokeStart(fn) { this._onStrokeStart = fn; }
  onStrokePoints(fn) { this._onStrokePoints = fn; }
  onStrokeEnd(fn) { this._onStrokeEnd = fn; }

  updateCursor({ userId, x, y, isDown }) {
    this.cursors.set(userId, { x, y, isDown: !!isDown, ts: Date.now() });
  }

  remoteStrokeStart({ userId, strokeId, tool, color, width, point }) {
    this.remoteLive.set(strokeId, {
      id: strokeId,
      userId,
      tool,
      color,
      width,
      points: [point]
    });
  }

  remoteStrokePoints({ userId, strokeId, points }) {
    const s = this.remoteLive.get(strokeId);
    if (!s) return;
    if (s.userId !== userId) return;
    if (!Array.isArray(points)) return;

    for (const pt of points) {
      if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
      s.points.push(pt);
    }
  }

  commitStroke({ stroke, version, undoCount, redoCount }) {
    if (!stroke) return;

    // Removes from live overlay if it exists
    this.remoteLive.delete(stroke.id);
    if (this.localLive && this.localLive.id === stroke.id) this.localLive = null;

    // Adds to the committed list
    this.committed.push(stroke);

    this.undoCount = undoCount ?? this.committed.length;
    this.redoCount = redoCount ?? 0;

    this._drawStrokeToBase(stroke);

    // Snapshot occasionally
    this._maybeCheckpoint();
  }

  applyHistoryPatch({ action, strokeId, stroke, undoCount, redoCount }) {
    if (action === "undo" && strokeId) {
      // remove stroke and redraw from cache
      const idx = this.committed.findIndex((s) => s.id === strokeId);
      if (idx !== -1) this.committed.splice(idx, 1);
      this.undoCount = undoCount ?? this.committed.length;
      this.redoCount = redoCount ?? this.redoCount + 1;
      this._redrawBaseWithCheckpoints();
    }

    if (action === "redo" && stroke) {
      this.committed.push(stroke);
      this.undoCount = undoCount ?? this.committed.length;
      this.redoCount = redoCount ?? Math.max(0, this.redoCount - 1);
      this._drawStrokeToBase(stroke);
      this._maybeCheckpoint();
    }
  }

  _bind() {
    window.addEventListener("resize", () => this._resizeToStage());

    // Prevents scroll zoom on stage to keep control consistent
    this.stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = -e.deltaY;
      const zoomFactor = delta > 0 ? 1.06 : 0.94;

      const rect = this.stage.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // zoom around mouse position
      const worldBefore = this._screenToWorld(mx, my);

      this.scale = Math.max(0.25, Math.min(4, this.scale * zoomFactor));

      const worldAfter = this._screenToWorld(mx, my);
      this.offsetX += (worldAfter.x - worldBefore.x) * this.scale;
      this.offsetY += (worldAfter.y - worldBefore.y) * this.scale;

      this._redrawBaseWithCheckpoints();
    }, { passive: false });

    // Space for panning
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space") {
        this.liveCanvas.style.cursor = "grab";
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") {
        this.liveCanvas.style.cursor = "crosshair";
        this.isPanning = false;
        this.lastPan = null;
      }
    });

    // Pointer events
    this.liveCanvas.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    this.liveCanvas.addEventListener("pointermove", (e) => this._onPointerMove(e));
    this.liveCanvas.addEventListener("pointerup", (e) => this._onPointerUp(e));
    this.liveCanvas.addEventListener("pointercancel", (e) => this._onPointerUp(e));
  }

  _onPointerDown(e) {
    this.liveCanvas.setPointerCapture(e.pointerId);

    const rect = this.stage.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const spaceDown = e.buttons === 4 || e.button === 1 || e.getModifierState?.("Space");
    const isSpacePressed = window.__spacePressed || false;

    // checks key state via keyboard events not stored
    const shouldPan = (e.buttons === 4) || (e.button === 1) || (e.ctrlKey && e.button === 0) || this._isSpaceCurrentlyDown();

    if (shouldPan) {
      this.isPanning = true;
      this.lastPan = { x: sx, y: sy };
      this.liveCanvas.style.cursor = "grabbing";
      return;
    }

    this.isPointerDown = true;

    const world = this._screenToWorld(sx, sy);

    const t = this._getLocalTool();
    const strokeId = uuid();

    this.localLive = {
      id: strokeId,
      userId: this.me?.id || "me",
      tool: t.tool,
      color: t.color,
      width: t.width,
      points: [world]
    };

    this.outgoingPoints = [];
    this.lastSentAt = 0;

    if (this._onStrokeStart) {
      this._onStrokeStart({
        strokeId,
        tool: t.tool,
        color: t.color,
        width: t.width,
        point: world
      });
    }

    if (this._onCursor) this._onCursor({ x: world.x, y: world.y, isDown: true });
  }

  _onPointerMove(e) {
    const rect = this.stage.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = this._screenToWorld(sx, sy);

    // Cursor broadcast
    if (this._onCursor) this._onCursor({ x: world.x, y: world.y, isDown: this.isPointerDown });

    if (this.isPanning && this.lastPan) {
      const dx = sx - this.lastPan.x;
      const dy = sy - this.lastPan.y;
      this.offsetX += dx;
      this.offsetY += dy;
      this.lastPan = { x: sx, y: sy };
      this._redrawBaseWithCheckpoints();
      return;
    }

    if (!this.isPointerDown || !this.localLive) return;

    const pts = this.localLive.points;
    const last = pts[pts.length - 1];
    if (!last) return;

    // Point thinning (avoids huge point lists under high-frequency move)
    const minDist = 1.5 / this.scale;
    if (dist2(last, world) < minDist * minDist) return;

    pts.push(world);

    // Batch points to send at about 60fps
    this.outgoingPoints.push(world);
  }

  _onPointerUp(e) {
    if (this.isPanning) {
      this.isPanning = false;
      this.lastPan = null;
      this.liveCanvas.style.cursor = "grab";
      return;
    }

    if (!this.isPointerDown) return;
    this.isPointerDown = false;

    if (this.localLive) {
      // flush remaining points
      this._flushOutgoingPoints(true);

      if (this._onStrokeEnd) {
        this._onStrokeEnd({ strokeId: this.localLive.id });
      }
    }

    if (this._onCursor && this.localLive) {
      const last = this.localLive.points[this.localLive.points.length - 1];
      if (last) this._onCursor({ x: last.x, y: last.y, isDown: false });
    }

  }

  _isSpaceCurrentlyDown() {
    // tracks space in a global
    // This avoids adding complex state managers.
    return window.__cc_space_down === true;
  }

  _resizeToStage() {
    const rect = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    for (const c of [this.baseCanvas, this.liveCanvas]) {
      c.width = Math.floor(rect.width * dpr);
      c.height = Math.floor(rect.height * dpr);
    }

    this._redrawBaseWithCheckpoints();
  }

  _applyTransform(ctx) {
    const rect = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // Transform maps world coords to device pixels:
    // deviceX = (worldX * scale + offsetX) * dpr
    ctx.setTransform(
      dpr * this.scale, 0,
      0, dpr * this.scale,
      dpr * this.offsetX, dpr * this.offsetY
    );
  }

  _screenToWorld(sx, sy) {
    // sx, sy are in CSS pixels relative to stage
    return {
      x: (sx - this.offsetX) / this.scale,
      y: (sy - this.offsetY) / this.scale
    };
  }

  _loop() {
    // main render loop for live overlay and point flushing
    const step = () => {
      this._flushOutgoingPoints(false);
      this._renderLiveOverlay();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _flushOutgoingPoints(force) {
    if (!this.localLive) return;
    if (!this._onStrokePoints) return;

    const now = performance.now();
    const shouldSend = force || (now - this.lastSentAt) >= 16;

    if (!shouldSend) return;
    if (this.outgoingPoints.length === 0) return;

    const batch = this.outgoingPoints.slice(0, 64);
    this.outgoingPoints = this.outgoingPoints.slice(batch.length);

    this._onStrokePoints({
      strokeId: this.localLive.id,
      points: batch
    });

    this.lastSentAt = now;
  }

  _renderLiveOverlay() {
    const ctx = this.liveCtx;
    const rect = this.stage.getBoundingClientRect();

    // Clear in device pixels without breaking transform
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, rect.width * dpr, rect.height * dpr);

    // Now draw overlay with world transform
    this._applyTransform(ctx);

    // Remote live strokes
    for (const s of this.remoteLive.values()) {
      this._drawStroke(ctx, s);
    }

    // Local live stroke (client-side prediction)
    if (this.localLive) this._drawStroke(ctx, this.localLive);

    // Cursors
    this._drawCursors(ctx);
  }

  _drawCursors(ctx) {
    const now = Date.now();

    for (const [userId, c] of this.cursors.entries()) {
      // Fade out stale cursors
      if (now - c.ts > 4000) continue;

      const user = this.users.get(userId);
      const color = user?.color || "#94a3b8";

      ctx.save();
      ctx.globalCompositeOperation = "source-over";

      // Cursor ring
      ctx.lineWidth = 2 / this.scale;
      ctx.strokeStyle = color;
      ctx.fillStyle = "rgba(255,255,255,0.05)";
      ctx.beginPath();
      ctx.arc(c.x, c.y, 8 / this.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Name tag
      if (user?.name) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const screen = this._worldToScreen(c.x, c.y);
        const dpr = window.devicePixelRatio || 1;
        const x = screen.x * dpr + 12;
        const y = screen.y * dpr + 12;

        ctx.font = `${12 * dpr}px ui-sans-serif`;
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        const text = user.name;
        const w = ctx.measureText(text).width + 10 * dpr;

        ctx.fillRect(x, y, w, 22 * dpr);
        ctx.fillStyle = "white";
        ctx.fillText(text, x + 5 * dpr, y + 15 * dpr);
      }

      ctx.restore();
      this._applyTransform(ctx);
    }
  }

  _worldToScreen(wx, wy) {
    return {
      x: wx * this.scale + this.offsetX,
      y: wy * this.scale + this.offsetY
    };
  }

  _drawStrokeToBase(stroke) {
    const ctx = this.baseCtx;

    // We draw onto base using current transform
    this._applyTransform(ctx);
    this._drawStroke(ctx, stroke);
  }

  _drawStroke(ctx, stroke) {
    const pts = stroke.points || [];
    if (pts.length === 0) return;

    ctx.save();

    // Tool handling
    if (stroke.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = stroke.color || "#111827";
    }

    ctx.lineWidth = (stroke.width || 8) / this.scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.beginPath();

    if (pts.length === 1) {
      const p = pts[0];
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + 0.01, p.y + 0.01);
    } else if (pts.length === 2) {
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
    } else {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 2; i++) {
        const p = pts[i];
        const n = pts[i + 1];
        const mx = (p.x + n.x) / 2;
        const my = (p.y + n.y) / 2;
        ctx.quadraticCurveTo(p.x, p.y, mx, my);
      }
      const p1 = pts[pts.length - 2];
      const p2 = pts[pts.length - 1];
      ctx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
    }

    ctx.stroke();
    ctx.restore();
  }

  _resetCheckpoints() {
    this.checkpoints = [];
  }

  _maybeCheckpoint() {
    if (this.committed.length % this.checkpointEvery !== 0) return;

    const rect = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // Snapshot base canvas in device pixels (fast restore)
    this.baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    const img = this.baseCtx.getImageData(0, 0, rect.width * dpr, rect.height * dpr);

    this.checkpoints.push({ count: this.committed.length, imageData: img });
    if (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints.shift();
    }
  }

  _redrawBaseFromScratch() {
    const ctx = this.baseCtx;
    const rect = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, rect.width * dpr, rect.height * dpr);

    this._applyTransform(ctx);

    for (const s of this.committed) this._drawStroke(ctx, s);

    this._resetCheckpoints();
    this._maybeCheckpoint();
  }

  _redrawBaseWithCheckpoints() {
    // Finds nearest checkpoint <= committed.length
    const target = this.committed.length;
    let best = null;

    for (const cp of this.checkpoints) {
      if (cp.count <= target) best = cp;
    }

    const ctx = this.baseCtx;
    const rect = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    if (best) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(best.imageData, 0, 0);

      this._applyTransform(ctx);

      for (let i = best.count; i < this.committed.length; i++) {
        this._drawStroke(ctx, this.committed[i]);
      }
    } else {
      this._redrawBaseFromScratch();
    }
  }
}

// Tracks Space globally so pan works reliably
window.__cc_space_down = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") window.__cc_space_down = true;
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") window.__cc_space_down = false;
});
