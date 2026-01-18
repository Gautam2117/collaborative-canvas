# Architecture

This document explains how the app synchronizes drawing in real time, how global undo/redo works across users, and what I did to keep canvas rendering smooth.

## High-level idea
Each drawing action becomes a stroke operation:
- tool + style (brush/eraser, color, width)
- a sequence of points (x, y) in world coordinates

Clients stream the stroke points while drawing. The server commits strokes and broadcasts an authoritative history so all clients stay consistent.

## Data flow diagram (text)
```
User pointer events
      |
      v
Client (local draw + batch points)
  |         |
  |         +--> emits stroke:start / stroke:points / stroke:end
  |
  +--> renders immediately (client-side prediction)
                |
                v
          Socket.io server
                |
                +--> broadcasts live stroke events to other clients
                |
                +--> commits stroke on stroke:end (authoritative order)
                |
                v
      All clients receive stroke:commit
      and apply it in the same order
```

## Rooms
Rooms are separate canvases identified by URL:
- `/` defaults to `lobby`
- `/?room=demo` uses room `demo`

Room state contains:
- `users[]`
- `strokes[]` committed history
- `redo[]` stack for redo
- `version` monotonic counter

## WebSocket protocol

### Join room
Client -> Server
```json
{ "roomId": "demo", "name": "Gautam" }
```

Server -> Client (room:state)
```json
{
  "roomId": "demo",
  "you": { "id": "<socketId>", "name": "Gautam", "color": "#3b82f6" },
  "users": [ ... ],
  "strokes": [ ... ],
  "version": 12,
  "undoCount": 42,
  "redoCount": 0
}
```

### Cursor presence
Client -> Server (cursor)
```json
{ "roomId": "demo", "x": 120.5, "y": 90.2, "isDown": true }
```

Server -> Others (cursor)
```json
{ "userId": "<socketId>", "x": 120.5, "y": 90.2, "isDown": true }
```

### Real-time drawing events
Strokes are streamed in 3 phases.

Client -> Server (stroke:start)
```json
{
  "roomId": "demo",
  "strokeId": "uuid",
  "tool": "brush",
  "color": "#3b82f6",
  "width": 8,
  "point": { "x": 10.2, "y": 5.1 }
}
```

Client -> Server (stroke:points) batched
```json
{
  "roomId": "demo",
  "strokeId": "uuid",
  "points": [
    { "x": 10.3, "y": 5.2 },
    { "x": 10.4, "y": 5.3 }
  ]
}
```

Client -> Server (stroke:end)
```json
{ "roomId": "demo", "strokeId": "uuid" }
```

Server -> Others (live mirror)
- stroke:start
- stroke:points

Server -> All (stroke:commit)
```json
{
  "stroke": {
    "id": "uuid",
    "userId": "<socketId>",
    "tool": "brush",
    "color": "#3b82f6",
    "width": 8,
    "points": [ ... ],
    "createdAt": 1730000000000,
    "seq": 91
  },
  "version": 13,
  "undoCount": 43,
  "redoCount": 0
}
```

## Why commits are server-authoritative
Two clients can draw at the same time and strokes can overlap. If clients commit locally, the final ordering can differ due to network timing.

To avoid divergence:
- the server is the single place that commits strokes
- it assigns a commit order (seq)
- all clients apply commits in that same order

That makes the canvas deterministic.

## Undo/Redo strategy (global)

### Goal
Undo/redo must apply to the same shared history for all users.

### Server state
- strokes[] committed history (ordered)
- redo[] redo stack
- version increments on any history change

### Undo
1. Pop the last stroke from strokes[]
2. Push it into redo[]
3. Broadcast a history patch

Server -> All (history:patch)
```json
{
  "action": "undo",
  "strokeId": "uuid",
  "version": 14,
  "undoCount": 42,
  "redoCount": 1
}
```

### Redo
1. Pop from redo[]
2. Push back into strokes[]
3. Broadcast a history patch with the full stroke

Server -> All (history:patch)
```json
{
  "action": "redo",
  "stroke": { "...": "..." },
  "version": 15,
  "undoCount": 43,
  "redoCount": 0
}
```

### Client behavior
- On undo: remove the stroke from local committed[] and redraw base canvas
- On redo: add the stroke back and draw it to base canvas

All clients end up with the same committed stroke list.

## Canvas rendering decisions

### Two-layer canvas
Two stacked canvases:
- Base canvas: committed strokes only
- Live canvas: in-progress strokes + cursors

This avoids re-rendering the full history on every pointer move.

### Smoothing + point thinning
- Points are sampled at high frequency but thinned by a distance threshold to avoid huge arrays.
- Strokes are rendered with quadratic curve smoothing for a clean look.

### Redraw strategy with checkpoints
Undo removes a stroke, so the base canvas must be rebuilt.

To keep that fast:
- cache a base-canvas snapshot every N strokes (checkpoint)
- on undo, restore the nearest checkpoint and replay only the remaining strokes

This keeps undo/redo responsive even with a longer history.

## Conflict resolution
Overlapping strokes are handled by committed ordering:
- the server commit sequence defines a single consistent order
- everyone replays the same order, so final pixels match across clients

## Network / latency handling
- Drawing feels instant locally because the client draws immediately.
- Remote clients see strokes as a stream of point batches, not only after completion.
- RTT is shown via a ping/pong message to verify connection health.

## Scaling discussion (how I’d handle 1000 users)
- Keep rooms isolated and cap room size.
- Run multiple Node instances behind a load balancer.
- Use a Socket.io adapter (Redis) so broadcasts work across instances.
- Store room history in Redis or a DB for persistence.
- Rate-limit cursor and point events per socket to prevent abuse.
