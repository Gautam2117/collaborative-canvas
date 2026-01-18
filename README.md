# Real-Time Collaborative Drawing Canvas

A multi-user drawing app where multiple people can draw on the same canvas at the same time. Drawings sync live while users are still drawing (not only after they finish), and everyone shares a global undo/redo history.

## What I built
- Brush + eraser
- Color picker + stroke width control
- Real-time drawing sync (streamed points)
- Live user cursors (see where others are drawing)
- Online user list with per-user colors
- Rooms (separate canvases) using `?room=<id>`
- Global undo/redo (server-authoritative)
- Smooth strokes + basic performance optimizations

## Tech
- Backend: Node.js + Express + Socket.io
- Frontend: HTML + CSS + Vanilla JS
- Canvas: raw Canvas API (no drawing libraries)

## Quick start
Requirements: Node.js 18+

```bash
npm install
npm start
```

Open:
- http://localhost:3000
- Room example: http://localhost:3000?room=demo

For development auto-reload:
```bash
npm run dev
```

## How to test with multiple users (important)
1. Open the same room in two windows:
   - Window 1: http://localhost:3000?room=test
   - Window 2 (Incognito): http://localhost:3000?room=test
2. Draw in both windows at the same time.
3. You should see:
   - strokes appear while the other user is drawing
   - cursor markers moving for the other user
4. Click **Undo** in either window:
   - the most recently committed stroke is removed for everyone (global undo)
5. Click **Redo**:
   - the stroke comes back for everyone (global redo)

## Controls
- Draw: pointer drag on canvas
- Pan: hold Space and drag
- Zoom: mouse wheel / trackpad

## Notes on behavior

### Real-time drawing
While you draw, your client:
- draws locally immediately (feels instant)
- sends stroke points in small batches (roughly per frame)
Other clients render those points as they arrive.

### Conflict handling
If multiple users draw over the same area at the same time, the final result stays consistent because:
- the server is the source of truth for the committed stroke order
- everyone applies the same ordered stroke history

### Global undo/redo
Undo/redo is global and stack-based:
- Undo removes the most recently committed stroke (regardless of who drew it)
- Redo restores the last undone stroke
This keeps behavior predictable and avoids divergent canvases.

## Known limitations / edge cases
- No persistence: restarting the server clears room history.
- Undo is global stack-based (not per-user). This is intentional for consistency.
- Cursor events are lightweight, but can be throttled further if you want to reduce network chatter under heavy load.

## Time spent (rough)
- Core real-time drawing + protocol: 4-6 hours
- Global undo/redo + redraw strategy: 3-4 hours
- UI polish + docs + testing: 2-3 hours
