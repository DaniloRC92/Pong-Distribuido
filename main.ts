import type { ServerWebSocket } from "bun";
import page from "./page.html";

const PORT = 6767; // mesma porta configurada no ESP32
const VIEWERS = "viewers"; // tópico pub/sub das páginas abertas

type WsData = { role: "device" | "viewer"; deviceId?: string };

type Pos = { x: number; y: number; z: number; t: number; receivedAt: number };

type DeviceMsg =
  | { type: "hello"; device: string; scale: number }
  | { type: "accel"; device: string; t: number; x: number; y: number; z: number };

const users = new Map<string, Pos>();

// JSON.parse devolve any: valida o formato antes de confiar nos campos
function parse(raw: string | Buffer): DeviceMsg | null {
  let m: any;
  try {
    m = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    return null;
  }
  if (typeof m?.device !== "string" || m.device === "") return null;
  if (m.type === "hello" && typeof m.scale === "number") return m;
  if (m.type === "accel" && [m.t, m.x, m.y, m.z].every(Number.isFinite)) return m;
  return null;
}

Bun.serve({
  port: PORT,

  routes: {
    "/game": page,
  },

  // Upgrades ficam no fetch: depois de server.upgrade() não se retorna Response
  fetch(req, server) {
    const { pathname } = new URL(req.url);

    if (pathname === "/") {
      // ESP32 conecta aqui; navegador comum vai para a página
      if (server.upgrade(req, { data: { role: "device" } })) return;
      return new Response(null, { status: 302, headers: { Location: "/game" } });
    }

    if (pathname === "/viewer") {
      if (server.upgrade(req, { data: { role: "viewer" } })) return;
      return new Response("Esperado WebSocket", { status: 426 });
    }

    return new Response("Não encontrado", { status: 404 });
  },

  websocket: {
    open(ws: ServerWebSocket<WsData>) {
      if (ws.data.role === "viewer") {
        ws.subscribe(VIEWERS);
        ws.send(JSON.stringify({ type: "snapshot", users: Object.fromEntries(users) }));
      }
    },

    message(ws: ServerWebSocket<WsData>, raw) {
      if (ws.data.role !== "device") return;

      const msg = parse(raw);
      if (!msg) {
        console.warn("Mensagem inválida:", String(raw));
        return;
      }

      ws.data.deviceId = msg.device;

      if (msg.type === "hello") {
        console.log(`[device] ${msg.device} conectado (±${msg.scale}g)`);
        return;
      }

      const pos: Pos = { x: msg.x, y: msg.y, z: msg.z, t: msg.t, receivedAt: Date.now() };
      users.set(msg.device, pos);
      ws.publish(VIEWERS, JSON.stringify({ type: "pos", device: msg.device, ...pos }));
    },

    close(ws: ServerWebSocket<WsData>) {
      const id = ws.data.deviceId;
      if (ws.data.role !== "device" || !id) return;

      users.delete(id);
      ws.publish(VIEWERS, JSON.stringify({ type: "leave", device: id }));
      console.log(`[device] ${id} desconectado`);
    },
  },
});

console.log(`Página:  http://localhost:${PORT}/game`);
console.log(`ESP32:   ws://<ip-do-pc>:${PORT}/`);