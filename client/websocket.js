export function createSocketClient() {
  const socket = io();

  const handlers = {
    connect: [],
    disconnect: [],
    latency: [],
    roomState: [],
    userJoin: [],
    userLeave: [],
    cursor: [],
    remoteStrokeStart: [],
    remoteStrokePoints: [],
    strokeCommit: [],
    historyPatch: []
  };

  socket.on("connect", () => handlers.connect.forEach((f) => f()));
  socket.on("disconnect", () => handlers.disconnect.forEach((f) => f()));

  socket.on("room:state", (state) => handlers.roomState.forEach((f) => f(state)));
  socket.on("user:join", ({ user }) => handlers.userJoin.forEach((f) => f(user)));
  socket.on("user:leave", ({ userId }) => handlers.userLeave.forEach((f) => f(userId)));

  socket.on("cursor", (data) => handlers.cursor.forEach((f) => f(data)));

  socket.on("stroke:start", (data) => handlers.remoteStrokeStart.forEach((f) => f(data)));
  socket.on("stroke:points", (data) => handlers.remoteStrokePoints.forEach((f) => f(data)));
  socket.on("stroke:commit", (data) => handlers.strokeCommit.forEach((f) => f(data)));
  socket.on("history:patch", (data) => handlers.historyPatch.forEach((f) => f(data)));

  // RTT measurement
  let lastPingAt = 0;
  function tickPing() {
    lastPingAt = Date.now();
    socket.emit("ping", { t0: lastPingAt });
  }
  socket.on("pong", ({ t0, t1 }) => {
    const now = Date.now();
    const rtt = now - t0;
    handlers.latency.forEach((f) => f(rtt));
  });
  setInterval(tickPing, 1500);
  tickPing();

  return {
    onConnect: (fn) => handlers.connect.push(fn),
    onDisconnect: (fn) => handlers.disconnect.push(fn),
    onLatency: (fn) => handlers.latency.push(fn),

    onRoomState: (fn) => handlers.roomState.push(fn),
    onUserJoin: (fn) => handlers.userJoin.push(fn),
    onUserLeave: (fn) => handlers.userLeave.push(fn),

    onCursor: (fn) => handlers.cursor.push(fn),
    onRemoteStrokeStart: (fn) => handlers.remoteStrokeStart.push(fn),
    onRemoteStrokePoints: (fn) => handlers.remoteStrokePoints.push(fn),
    onStrokeCommit: (fn) => handlers.strokeCommit.push(fn),
    onHistoryPatch: (fn) => handlers.historyPatch.push(fn),

    joinRoom: ({ roomId, name }) => socket.emit("room:join", { roomId, name }),

    sendCursor: ({ roomId, x, y, isDown }) => socket.emit("cursor", { roomId, x, y, isDown }),

    strokeStart: (payload) => socket.emit("stroke:start", payload),
    strokePoints: (payload) => socket.emit("stroke:points", payload),
    strokeEnd: (payload) => socket.emit("stroke:end", payload),

    undo: (roomId) => socket.emit("undo", { roomId }),
    redo: (roomId) => socket.emit("redo", { roomId })
  };
}
