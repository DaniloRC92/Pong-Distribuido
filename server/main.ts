import type { ServerWebSocket } from "bun";
import page from "../web/index.html";
import { ARENA, Game, TICK_HZ, WIN_SCORE } from "./game.ts";
import { parseDevice, parseViewer, type DeviceMsg, type PlayerId } from "./protocol.ts";

const PORT = Number(process.env.PORT ?? 6767); // mesma porta configurada no ESP32
const VIEWERS = "viewers"; // tópico pub/sub dos navegadores abertos
const STALE_MS = 500; // sem amostra há mais que isso: aviso na interface
const DEVICE_TIMEOUT_MS = 3000; // sem nenhuma mensagem: servidor derruba a conexão

type WsData = { role: "device"; player: PlayerId } | { role: "viewer" };
type Ws = ServerWebSocket<WsData>;

type DeviceStats = Omit<Extract<DeviceMsg, { type: "stats" }>, "type">;

// Conexão de cada jogador. O endpoint (/ws/player1 ou /ws/player2) define o jogador.
type Slot = {
  ws: Ws | null;
  device: string | null;
  lastSeq: number; // último seq aceito nesta conexão (-1 = nenhum)
  lastMsgAt: number;
  lastInputAt: number;
  inputsInWindow: number; // contador da janela de 1 s
  inputsPerSec: number;
  lost: number; // lacunas na sequência
  outOfOrder: number; // mensagens com seq antigo, descartadas
  connections: number;
  deviceStats: DeviceStats | null;
  keyOwner: Ws | null; // navegador que está usando o teclado para este jogador
};

function newSlot(): Slot {
  return {
    ws: null,
    device: null,
    lastSeq: -1,
    lastMsgAt: 0,
    lastInputAt: 0,
    inputsInWindow: 0,
    inputsPerSec: 0,
    lost: 0,
    outOfOrder: 0,
    connections: 0,
    deviceStats: null,
    keyOwner: null,
  };
}

const game = new Game();
const slots: Record<PlayerId, Slot> = { 1: newSlot(), 2: newSlot() };
const PLAYERS: PlayerId[] = [1, 2];

const DEVICE_PATHS: Record<string, PlayerId> = { "/ws/player1": 1, "/ws/player2": 2 };

function stateMsg() {
  return JSON.stringify({ type: "state", ...game.snapshot() });
}

let ticksInWindow = 0;
let tickRate = 0;

function statsMsg() {
  const now = Date.now();
  const players = Object.fromEntries(
    PLAYERS.map((p) => {
      const s = slots[p];
      return [
        p,
        {
          online: s.ws !== null,
          device: s.device,
          inputsPerSec: s.inputsPerSec,
          ageMs: s.ws && s.lastInputAt ? now - s.lastInputAt : null,
          stale: s.ws !== null && now - s.lastInputAt > STALE_MS,
          lost: s.lost,
          outOfOrder: s.outOfOrder,
          connections: s.connections,
          deviceStats: s.deviceStats,
        },
      ];
    }),
  );
  return JSON.stringify({ type: "stats", tickRate, players });
}

// ---- conexões dos ESP32 ----

// A conexão só assume a raquete depois de um hello válido
function deviceOpen(ws: Ws, p: PlayerId) {
  setTimeout(() => {
    if (slots[p].ws !== ws && ws.readyState === 1) ws.close(1008, "hello não recebido");
  }, DEVICE_TIMEOUT_MS);
}

function claimSlot(ws: Ws, p: PlayerId, device: string) {
  const slot = slots[p];
  const old = slot.ws;
  // Uma nova conexão substitui a anterior: após uma queda de Wi-Fi o ESP32
  // reconecta antes de o servidor perceber que o socket antigo morreu.
  slot.ws = ws;
  if (old && old !== ws) old.terminate();

  slot.device = device;
  slot.lastSeq = -1;
  slot.lastMsgAt = Date.now();
  slot.lastInputAt = 0;
  slot.connections++;
  slot.keyOwner = null;
  game.setEsp32(p, true);
}

function deviceMessage(ws: Ws, p: PlayerId, raw: string | Buffer) {
  const msg = parseDevice(raw);
  if (!msg) {
    console.warn(`[J${p}] mensagem inválida:`, String(raw).slice(0, 200));
    return;
  }

  const slot = slots[p];
  if (msg.type === "hello") {
    if (msg.player !== p) {
      console.warn(`[J${p}] ${msg.device} se identificou como J${msg.player}; conexão recusada`);
      ws.close(1008, "jogador não corresponde ao endpoint");
      return;
    }
    claimSlot(ws, p, msg.device);
    console.log(`[J${p}] ${msg.device} conectado: aquisição ${msg.sampleHz} Hz, envio ${msg.sendHz} Hz`);
    return;
  }
  if (slot.ws !== ws) return; // sem hello ou conexão já substituída

  const now = Date.now();
  slot.lastMsgAt = now;

  switch (msg.type) {

    case "input":
      // TCP entrega em ordem; isto protege contra amostras antigas de qualquer forma
      if (msg.seq <= slot.lastSeq) {
        slot.outOfOrder++;
        return;
      }
      if (slot.lastSeq >= 0 && msg.seq > slot.lastSeq + 1) slot.lost += msg.seq - slot.lastSeq - 1;
      slot.lastSeq = msg.seq;
      slot.lastInputAt = now;
      slot.inputsInWindow++;
      game.setTilt(p, msg.pos);
      return;

    case "stats": {
      const { type, ...stats } = msg;
      slot.deviceStats = stats;
      console.log(
        `[J${p}] leituras/s=${stats.reads} envios/s=${stats.sent} descartadas/s=${stats.dropped} ` +
          `erros_i2c=${stats.i2cErrors} reconexões=${stats.reconnects} rtt=${stats.rtt}ms ` +
          `| recebidas/s=${slot.inputsPerSec} perdidas=${slot.lost}`,
      );
      return;
    }

    case "ping":
      ws.send(JSON.stringify({ type: "pong", id: msg.id }));
      return;
  }
}

function deviceClose(ws: Ws, p: PlayerId) {
  const slot = slots[p];
  if (slot.ws !== ws) return; // era uma conexão antiga, já substituída
  slot.ws = null;
  game.setEsp32(p, false);
  console.log(`[J${p}] ${slot.device ?? "ESP32"} desconectado`);
}

// ---- conexões dos navegadores ----

function viewerMessage(ws: Ws, raw: string | Buffer) {
  const msg = parseViewer(raw);
  if (!msg) return;

  switch (msg.type) {
    case "start":
      game.start();
      return;
    case "restart":
      game.restart();
      return;
    case "resume":
      game.resume();
      return;
    case "key": {
      const slot = slots[msg.player];
      if (slot.ws) return; // ESP32 conectado: teclado não manda nessa raquete
      slot.keyOwner = msg.dir === 0 ? null : ws;
      game.setKey(msg.player, msg.dir);
      return;
    }
    case "calibrate":
      slots[msg.player].ws?.send(JSON.stringify({ type: "calibrate" }));
      return;
    case "ping":
      ws.send(JSON.stringify({ type: "pong", id: msg.id }));
      return;
  }
}

function viewerClose(ws: Ws) {
  // Tecla "presa" de quem fechou a aba
  for (const p of PLAYERS) {
    if (slots[p].keyOwner === ws) {
      slots[p].keyOwner = null;
      game.setKey(p, 0);
    }
  }
}

const server = Bun.serve<WsData>({
  port: PORT,

  routes: {
    "/game": page,
  },

  // Upgrades ficam no fetch: depois de server.upgrade() não se retorna Response
  fetch(req, server) {
    const { pathname } = new URL(req.url);

    const player = DEVICE_PATHS[pathname];
    if (player) {
      if (server.upgrade(req, { data: { role: "device", player } })) return;
      return new Response("Esperado WebSocket", { status: 426 });
    }

    if (pathname === "/viewer") {
      if (server.upgrade(req, { data: { role: "viewer" } })) return;
      return new Response("Esperado WebSocket", { status: 426 });
    }

    if (pathname === "/") return new Response(null, { status: 302, headers: { Location: "/game" } });

    return new Response("Não encontrado", { status: 404 });
  },

  websocket: {
    open(ws) {
      if (ws.data.role === "device") return deviceOpen(ws, ws.data.player);

      ws.subscribe(VIEWERS);
      ws.send(JSON.stringify({ type: "welcome", arena: ARENA, winScore: WIN_SCORE, tickHz: TICK_HZ }));
      ws.send(stateMsg());
      ws.send(statsMsg());
    },

    message(ws, raw) {
      if (ws.data.role === "device") deviceMessage(ws, ws.data.player, raw);
      else viewerMessage(ws, raw);
    },

    close(ws) {
      if (ws.data.role === "device") deviceClose(ws, ws.data.player);
      else viewerClose(ws);
    },
  },
});

// ---- laços periódicos ----
// O Bun roda tudo numa única thread (event loop): handlers de mensagem e o tick
// nunca executam ao mesmo tempo, então o estado da partida não precisa de lock.

const STEP_MS = 1000 / TICK_HZ;
let lastTime = performance.now();
let acc = 0;

function gameLoop() {
  const now = performance.now();
  acc += now - lastTime;
  lastTime = now;

  let steps = 0;
  while (acc >= STEP_MS && steps < 5) {
    game.step();
    acc -= STEP_MS;
    steps++;
  }
  if (steps === 5) acc = 0; // servidor travou: não tenta recuperar o atraso inteiro
  if (steps === 0) return;

  ticksInWindow += steps;
  // Só o estado mais recente é enviado; estados intermediários de um atraso são pulados
  server.publish(VIEWERS, stateMsg());
}

function everySecond() {
  tickRate = ticksInWindow;
  ticksInWindow = 0;
  for (const p of PLAYERS) {
    slots[p].inputsPerSec = slots[p].inputsInWindow;
    slots[p].inputsInWindow = 0;
  }
  server.publish(VIEWERS, statsMsg());
}

function checkTimeouts() {
  const now = Date.now();
  for (const p of PLAYERS) {
    const s = slots[p];
    if (s.ws && now - s.lastMsgAt > DEVICE_TIMEOUT_MS) {
      console.warn(`[J${p}] sem mensagens há ${now - s.lastMsgAt} ms; encerrando conexão`);
      s.ws.terminate(); // dispara close() -> deviceClose
    }
  }
}

// Com `bun --hot` o módulo é reexecutado; limpa os timers da versão anterior
declare global {
  var __pongTimers: Timer[] | undefined;
}
globalThis.__pongTimers?.forEach(clearInterval);
globalThis.__pongTimers = [
  setInterval(gameLoop, 4),
  setInterval(everySecond, 1000),
  setInterval(checkTimeouts, 250),
];

console.log(`Página:    http://localhost:${server.port}/game`);
console.log(`ESP32 J1:  ws://<ip-do-servidor>:${server.port}/ws/player1`);
console.log(`ESP32 J2:  ws://<ip-do-servidor>:${server.port}/ws/player2`);
