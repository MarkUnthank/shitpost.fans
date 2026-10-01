import { DurableObject } from "cloudflare:workers";

// Everyone shares one room: a counter of 100-word units and the open sockets.
// Words are never stored; each unit's words come from its index, so every
// reader draws the same book from the counter alone.

const PRESSES_PER_SECOND = 8;
const MAX_UNITS_PER_PRESS = 25;
const BROADCAST_EVERY_MS = 100;
const CURSOR_EVERY_MS = 60;

// A cursor is [region, offset, x]: region 0 is above the words (offset in px),
// 1 is in the words (block index + fraction through it), 2 is below them (px).
// x is the fraction across the text column. Pinning to the words keeps a cursor
// on the same jibberish on every screen, however the text wraps.
function readCursor(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [r, v, x] = raw;
  if (![0, 1, 2].includes(r) || !Number.isFinite(v) || !Number.isFinite(x)) return null;
  if (v < 0 || v > 1e7) return null;
  return [r, Math.round(v * 1000) / 1000, Math.round(Math.max(-0.5, Math.min(1.5, x)) * 1000) / 1000];
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.n = 0;
    this.flushTimer = null;
    this.leaving = new Set();
    this.cursors = new Map(); // id -> cursor, for newcomers
    this.moved = new Map(); // id -> cursor or 0 (gone), since the last broadcast
    this.lastMove = new Map(); // id -> ms
    ctx.blockConcurrencyWhile(async () => {
      this.n = (await ctx.storage.get("n")) ?? 0;
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ n: this.n, o: this.online() });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const id = crypto.randomUUID().slice(0, 8);
    server.serializeAttachment({ id, tokens: PRESSES_PER_SECOND, at: Date.now() });
    server.send(JSON.stringify({ me: id, n: this.n, o: this.online(), c: Object.fromEntries(this.cursors) }));
    this.scheduleBroadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message === "string" && message[0] === "p" && message.length <= 4) {
      const units = message.length === 1 ? 1 : parseInt(message.slice(1), 10);
      if (Number.isInteger(units) && units >= 1) this.press(ws, Math.min(units, MAX_UNITS_PER_PRESS));
      return;
    }
    if (typeof message !== "string" || message.length > 80 || message[0] !== "[") return;
    const a = ws.deserializeAttachment();
    if (!a) return;
    const now = Date.now();
    if (now - (this.lastMove.get(a.id) ?? 0) < CURSOR_EVERY_MS) return;
    this.lastMove.set(a.id, now);
    let cursor = null;
    try {
      const raw = JSON.parse(message);
      cursor = raw.length === 0 ? 0 : readCursor(raw);
    } catch {}
    if (cursor === null) return;
    if (cursor === 0) this.cursors.delete(a.id);
    else this.cursors.set(a.id, cursor);
    this.moved.set(a.id, cursor);
    this.scheduleBroadcast();
  }

  press(ws, units) {
    const bucket = ws.deserializeAttachment() ?? { tokens: PRESSES_PER_SECOND, at: Date.now() };
    const now = Date.now();
    bucket.tokens = Math.min(PRESSES_PER_SECOND, bucket.tokens + ((now - bucket.at) / 1000) * PRESSES_PER_SECOND);
    bucket.at = now;
    if (bucket.tokens < 1) {
      ws.serializeAttachment(bucket);
      return;
    }
    bucket.tokens -= 1;
    ws.serializeAttachment(bucket);
    this.n += units;
    this.ctx.storage.put("n", this.n);
    this.scheduleBroadcast();
  }

  async webSocketClose(ws) {
    this.leave(ws);
  }

  async webSocketError(ws) {
    this.leave(ws);
  }

  leave(ws) {
    this.leaving.add(ws);
    const id = ws.deserializeAttachment()?.id;
    if (id) {
      this.cursors.delete(id);
      this.lastMove.delete(id);
      this.moved.set(id, 0);
    }
    this.scheduleBroadcast();
  }

  online() {
    return this.ctx.getWebSockets().filter((ws) => !this.leaving.has(ws) && ws.readyState === WebSocket.OPEN).length;
  }

  scheduleBroadcast() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const msg = { n: this.n, o: this.online() };
      if (this.moved.size) msg.c = Object.fromEntries(this.moved);
      this.moved.clear();
      this.leaving.clear();
      const text = JSON.stringify(msg);
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(text);
        } catch {}
      }
    }, BROADCAST_EVERY_MS);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/ws" || url.pathname === "/api/state") {
      return env.ROOM.get(env.ROOM.idFromName("internet")).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
