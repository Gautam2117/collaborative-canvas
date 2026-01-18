import { createSocketClient } from "./websocket.js";
import { CanvasEngine } from "./canvas.js";

const qs = new URLSearchParams(location.search);
const roomId = qs.get("room") || "lobby";
document.getElementById("roomLabel").textContent = `Room: ${roomId}`;

const els = {
  nameInput: document.getElementById("nameInput"),
  brushBtn: document.getElementById("brushBtn"),
  eraserBtn: document.getElementById("eraserBtn"),
  colorInput: document.getElementById("colorInput"),
  widthInput: document.getElementById("widthInput"),
  widthHint: document.getElementById("widthHint"),
  undoBtn: document.getElementById("undoBtn"),
  redoBtn: document.getElementById("redoBtn"),
  connPill: document.getElementById("connPill"),
  latPill: document.getElementById("latPill"),
  userList: document.getElementById("userList"),
  onlineCount: document.getElementById("onlineCount"),
  baseCanvas: document.getElementById("baseCanvas"),
  liveCanvas: document.getElementById("liveCanvas"),
  stage: document.getElementById("stage")
};

// Persist name locally so it feels real
els.nameInput.value = localStorage.getItem("cc_name") || "";
els.nameInput.addEventListener("input", () => {
  localStorage.setItem("cc_name", els.nameInput.value.trim());
});

// Tool state
let tool = "brush";
els.brushBtn.onclick = () => setTool("brush");
els.eraserBtn.onclick = () => setTool("eraser");

function setTool(next) {
  tool = next;
  els.brushBtn.classList.toggle("active", tool === "brush");
  els.eraserBtn.classList.toggle("active", tool === "eraser");
}

els.widthHint.textContent = els.widthInput.value;
els.widthInput.addEventListener("input", () => {
  els.widthHint.textContent = els.widthInput.value;
});

const socketClient = createSocketClient();
const engine = new CanvasEngine({
  baseCanvas: els.baseCanvas,
  liveCanvas: els.liveCanvas,
  stage: els.stage
});

engine.setGetLocalTool(() => ({
  tool,
  color: els.colorInput.value,
  width: Number(els.widthInput.value)
}));

// Wire UI buttons
els.undoBtn.onclick = () => socketClient.undo(roomId);
els.redoBtn.onclick = () => socketClient.redo(roomId);

// Connect
socketClient.onConnect(() => {
  els.connPill.textContent = "Connected";
  els.connPill.style.color = "#a7f3d0";
});
socketClient.onDisconnect(() => {
  els.connPill.textContent = "Disconnected";
  els.connPill.style.color = "";
});

socketClient.onLatency((rttMs) => {
  els.latPill.textContent = `RTT: ${Math.round(rttMs)}ms`;
});

socketClient.joinRoom({
  roomId,
  name: els.nameInput.value.trim()
});

// If user changes name later, rejoin on blur (simple)
els.nameInput.addEventListener("blur", () => {
  socketClient.joinRoom({ roomId, name: els.nameInput.value.trim() });
});

// Room state
socketClient.onRoomState((state) => {
  if (state.error) return;

  engine.setMe(state.you);
  engine.setCommittedStrokes(state.strokes || []);
  renderUsers(state.users || [], state.you?.id);

  els.onlineCount.textContent = String((state.users || []).length);
  engine.setHistoryCounts(state.undoCount || 0, state.redoCount || 0);
});

socketClient.onUserJoin((user) => {
  engine.addUser(user);
  renderUsers(engine.getUsers(), engine.getMeId());
  els.onlineCount.textContent = String(engine.getUsers().length);
});

socketClient.onUserLeave((userId) => {
  engine.removeUser(userId);
  renderUsers(engine.getUsers(), engine.getMeId());
  els.onlineCount.textContent = String(engine.getUsers().length);
});

// Cursors
socketClient.onCursor((data) => engine.updateCursor(data));

// Live strokes and commits
socketClient.onRemoteStrokeStart((data) => engine.remoteStrokeStart(data));
socketClient.onRemoteStrokePoints((data) => engine.remoteStrokePoints(data));
socketClient.onStrokeCommit((data) => engine.commitStroke(data));

socketClient.onHistoryPatch((data) => engine.applyHistoryPatch(data));

// Engine to socket: local drawing and cursor streaming
engine.onCursor((cursor) => socketClient.sendCursor({ roomId, ...cursor }));
engine.onStrokeStart((evt) => socketClient.strokeStart({ roomId, ...evt }));
engine.onStrokePoints((evt) => socketClient.strokePoints({ roomId, ...evt }));
engine.onStrokeEnd((evt) => socketClient.strokeEnd({ roomId, ...evt }));

function renderUsers(users, meId) {
  els.userList.innerHTML = "";

  for (const u of users) {
    const item = document.createElement("div");
    item.className = "userItem";

    const left = document.createElement("div");
    left.className = "userLeft";

    const dot = document.createElement("div");
    dot.className = "dot";
    dot.style.background = u.color;

    const name = document.createElement("div");
    name.className = "userName";
    name.textContent = u.name;

    left.appendChild(dot);
    left.appendChild(name);

    const right = document.createElement("div");
    right.className = "youTag";
    right.textContent = u.id === meId ? "you" : "";

    item.appendChild(left);
    item.appendChild(right);
    els.userList.appendChild(item);
  }
}
