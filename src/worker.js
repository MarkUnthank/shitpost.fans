import { DurableObject } from "cloudflare:workers";

// Everyone shares one room: a press counter and the open sockets.
// Words are never stored; each press's 100 words come from its index, so every
// viewer draws the same jibberish from the counter alone.

const PRESSES_PER_SECOND = 8;
const BROADCAST_EVERY_MS = 80;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.n = 0;
    this.flushTimer = null;
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
    server.serializeAttachment({ tokens: PRESSES_PER_SECOND, at: Date.now() });
    server.send(JSON.stringify({ n: this.n, o: this.online() }));
    this.scheduleBroadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (message !== "p") return;
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
    this.n += 1;
    this.ctx.storage.put("n", this.n);
    this.scheduleBroadcast();
  }

  async webSocketClose(ws) {
    this.scheduleBroadcast(ws);
  }

  async webSocketError(ws) {
    this.scheduleBroadcast(ws);
  }

  online(leaving) {
    return this.ctx.getWebSockets().filter((ws) => ws !== leaving && ws.readyState === WebSocket.OPEN).length;
  }

  scheduleBroadcast(leaving) {
    if (leaving) this.leaving = leaving;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const msg = JSON.stringify({ n: this.n, o: this.online(this.leaving) });
      this.leaving = null;
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(msg);
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
