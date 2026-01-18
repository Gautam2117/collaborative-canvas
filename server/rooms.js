import { DrawingState } from "./drawing-state.js";

/**
 * Room wrapper that includes users + drawing state.
 */
class Room {
  constructor(roomId) {
    this.roomId = roomId;
    this.users = new Map(); // socketId -> user
    this.state = new DrawingState();
    this.palette = [
      "#ef4444", "#f97316", "#f59e0b", "#84cc16", "#22c55e",
      "#06b6d4", "#3b82f6", "#6366f1", "#a855f7", "#ec4899"
    ];
    this.nextColorIdx = 0;
  }

  addUser(socketId, name) {
    const color = this.palette[this.nextColorIdx % this.palette.length];
    this.nextColorIdx += 1;

    const user = {
      id: socketId,
      name: name || `User-${socketId.slice(0, 4)}`,
      color,
      joinedAt: Date.now()
    };

    this.users.set(socketId, user);
    return user;
  }

  removeUser(socketId) {
    const user = this.users.get(socketId);
    this.users.delete(socketId);
    return user || null;
  }

  countUsers() {
    return this.users.size;
  }

  listUsers() {
    return Array.from(this.users.values());
  }

  isFiniteNum(n) {
    return Number.isFinite(n) && !Number.isNaN(n);
  }
}

export class Rooms {
  constructor() {
    this.map = new Map(); // roomId -> Room
  }

  getOrCreate(roomId) {
    if (!this.map.has(roomId)) this.map.set(roomId, new Room(roomId));
    return this.map.get(roomId);
  }

  get(roomId) {
    return this.map.get(roomId) || null;
  }

  delete(roomId) {
    this.map.delete(roomId);
  }

  sanitizeRoomId(roomId) {
    if (typeof roomId !== "string") return "lobby";
    const trimmed = roomId.trim();
    if (!trimmed) return "lobby";
    const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
    return safe || "lobby";
  }

  sanitizeName(name) {
    if (typeof name !== "string") return "";
    const trimmed = name.trim().slice(0, 20);
    // allows letters, digits, space, underscore
    const safe = trimmed.replace(/[^\w\s]/g, "");
    return safe;
  }
}
