import http from "http";
import express from "express";
import { Server } from "socket.io";
import { Rooms } from "./rooms.js";

const app = express();

// Render runs behind a proxy, so this helps express handle headers correctly
app.set("trust proxy", 1);

// tiny security hygiene
app.disable("x-powered-by");

const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";

// Optional: if you want strict CORS in prod, set this on Render dashboard
// Example: PUBLIC_ORIGIN=https://your-app.onrender.com
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN;

// Socket.io config
// If client is served from the same server (my setup), CORS is not really needed.
// I still keep it safe for dev and optional strict in prod.
const io = new Server(server, {
  cors: isProd
    ? (PUBLIC_ORIGIN ? { origin: PUBLIC_ORIGIN } : undefined)
    : { origin: "*" },

  // These keep WS connections stable under real networks
  pingInterval: 20000,
  pingTimeout: 20000
});

const rooms = new Rooms();

/**
 * Serve static client
 * Notes:
 * - Don't cache index.html (so updates reflect immediately)
 * - Cache static assets more aggressively (css/js/images)
 */
app.use(
  express.static("client", {
    etag: true,
    setHeaders: (res, filePath) => {
      res.setHeader("X-Content-Type-Options", "nosniff");

      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-store");
      } else if (/\.(js|css|png|jpg|jpeg|webp|svg|ico)$/.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "public, max-age=3600");
      }
    }
  })
);

/**
 * Health route for deploy checks (Render will hit this sometimes)
 */
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * Socket protocol:
 * Client -> Server:
 * - room:join { roomId, name }
 * - cursor { roomId, x, y, isDown }
 * - stroke:start { roomId, strokeId, tool, color, width, point }
 * - stroke:points { roomId, strokeId, points: [{x,y}, ...] }
 * - stroke:end { roomId, strokeId }
 * - undo { roomId }
 * - redo { roomId }
 * - ping { t0 }
 *
 * Server -> Client:
 * - room:state { roomId, you, users, strokes, version, undoCount, redoCount }
 * - user:join { user }
 * - user:leave { userId }
 * - cursor { userId, x, y, isDown }
 * - stroke:start { userId, strokeId, tool, color, width, point }
 * - stroke:points { userId, strokeId, points }
 * - stroke:commit { stroke, version, undoCount, redoCount }
 * - history:patch { action: "undo"|"redo", stroke?, strokeId?, version, undoCount, redoCount }
 * - pong { t0, t1 }
 */
io.on("connection", (socket) => {
  let currentRoomId = null;

  socket.on("room:join", ({ roomId, name }) => {
    const safeRoomId = rooms.sanitizeRoomId(roomId);
    const safeName = rooms.sanitizeName(name);

    if (!safeRoomId) {
      socket.emit("room:state", { error: "Invalid room." });
      return;
    }

    currentRoomId = safeRoomId;
    socket.join(currentRoomId);

    const room = rooms.getOrCreate(currentRoomId);
    const user = room.addUser(socket.id, safeName);

    // Send full state to the joining client
    socket.emit("room:state", {
      roomId: currentRoomId,
      you: user,
      users: room.listUsers(),
      strokes: room.state.strokes,
      version: room.state.version,
      undoCount: room.state.strokes.length,
      redoCount: room.state.redo.length
    });

    // Notify others
    socket.to(currentRoomId).emit("user:join", { user });
  });

  socket.on("cursor", (payload) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const { x, y, isDown } = payload || {};
    if (!room.isFiniteNum(x) || !room.isFiniteNum(y)) return;

    socket.to(currentRoomId).emit("cursor", {
      userId: socket.id,
      x,
      y,
      isDown: !!isDown
    });
  });

  socket.on("stroke:start", (payload) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const ok = room.state.startStroke(socket.id, payload);
    if (!ok) return;

    socket.to(currentRoomId).emit("stroke:start", {
      userId: socket.id,
      strokeId: payload.strokeId,
      tool: payload.tool,
      color: payload.color,
      width: payload.width,
      point: payload.point
    });
  });

  socket.on("stroke:points", (payload) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const ok = room.state.addStrokePoints(socket.id, payload);
    if (!ok) return;

    socket.to(currentRoomId).emit("stroke:points", {
      userId: socket.id,
      strokeId: payload.strokeId,
      points: payload.points
    });
  });

  socket.on("stroke:end", (payload) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const commit = room.state.endStroke(socket.id, payload);
    if (!commit) return;

    // Authoritative commit broadcast (server order is the truth)
    io.to(currentRoomId).emit("stroke:commit", {
      stroke: commit.stroke,
      version: room.state.version,
      undoCount: room.state.strokes.length,
      redoCount: room.state.redo.length
    });
  });

  socket.on("undo", ({ roomId }) => {
    const rid = rooms.sanitizeRoomId(roomId);
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;

    const removed = room.state.undo();
    if (!removed) return;

    io.to(rid).emit("history:patch", {
      action: "undo",
      strokeId: removed.id,
      version: room.state.version,
      undoCount: room.state.strokes.length,
      redoCount: room.state.redo.length
    });
  });

  socket.on("redo", ({ roomId }) => {
    const rid = rooms.sanitizeRoomId(roomId);
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;

    const restored = room.state.redoStroke();
    if (!restored) return;

    io.to(rid).emit("history:patch", {
      action: "redo",
      stroke: restored,
      version: room.state.version,
      undoCount: room.state.strokes.length,
      redoCount: room.state.redo.length
    });
  });

  socket.on("ping", ({ t0 }) => {
    socket.emit("pong", { t0, t1: Date.now() });
  });

  socket.on("disconnect", () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const removed = room.removeUser(socket.id);
    if (removed) {
      socket.to(currentRoomId).emit("user:leave", { userId: socket.id });
    }

    // Cleanup: delete empty rooms (keeps memory stable)
    if (room.countUsers() === 0) rooms.delete(currentRoomId);
  });
});

server.listen(PORT, () => {
  // On Render you'll see the live URL in the dashboard logs
  console.log(`Server listening on port ${PORT}`);
});

/**
 * Render can stop/restart the instance.
 * This closes sockets cleanly instead of dropping in the middle of events.
 */
function shutdown(signal) {
  console.log(`Shutting down (${signal})...`);

  io.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });

  // fallback: don't hang forever
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
