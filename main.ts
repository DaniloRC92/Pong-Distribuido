import type { ServerWebSocket } from "bun";
import page from "./page.html";

const PORT = 6767; // mesma porta configurada no ESP32
const VIEWERS = "viewers"; // tópico pub/sub das páginas abertas

// ---- jogo: o servidor é a autoridade; as páginas só desenham o que recebem ----
const TICK_HZ = 60;
const ARENA = { width: 800, height: 500, paddleW: 12, paddleH: 80, paddleMargin: 16, ball: 12 };
const PADDLE_SPEED = 5; // px por tick, raquete de teclado
const BALL_SPEED_INIT = 3.5; // px por tick
const BALL_SPEED_MAX = 8;
const WIN_SCORE = 7;
const WIN_PAUSE_TICKS = 3 * TICK_HZ; // vencedor fica na tela 3 s e começa outra partida

// Eixo do acelerômetro que move a raquete (em g, -1..1 ≈ -90°..90°)
const AXIS = "y";
// Inclinação (em g) que leva a raquete de uma ponta à outra
const FULL_TILT = 0.6;
const TILT_SMOOTHING = 0.3; // fração do caminho até o alvo percorrida por tick

type Side = "left" | "right";
type Dir = -1 | 0 | 1;

type WsData = { role: "device" | "viewer"; deviceId?: string };
type Ws = ServerWebSocket<WsData>;

type DeviceMsg =
  | { type: "hello"; device: string; scale: number }
  | { type: "accel"; device: string; t: number; x: number; y: number; z: number };

type ViewerMsg = { type: "key"; side: Side; dir: Dir };

// JSON.parse devolve any: valida o formato antes de confiar nos campos
function decode(raw: string | Buffer): any {
  try {
    return JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    return null;
  }
}

function parse(raw: string | Buffer): DeviceMsg | null {
  const m = decode(raw);
  if (typeof m?.device !== "string" || m.device === "") return null;
  if (m.type === "hello" && typeof m.scale === "number") return m;
  if (m.type === "accel" && [m.t, m.x, m.y, m.z].every(Number.isFinite)) return m;
  return null;
}

function parseViewer(raw: string | Buffer): ViewerMsg | null {
  const m = decode(raw);
  if (m?.type === "key" && (m.side === "left" || m.side === "right") && [-1, 0, 1].includes(m.dir)) return m;
  return null;
}

// ---- estado autoritativo ----

const samples = new Map<string, DeviceMsg & { type: "accel" }>(); // última amostra por ESP32
// 1º ESP32 que aparece = J1 (left), 2º = J2 (right)
const slots: Record<Side, string | null> = { left: null, right: null };
const keys: Record<Side, Dir> = { left: 0, right: 0 };
const keyOwner: Record<Side, Ws | null> = { left: null, right: null };

const PADDLE_TRAVEL = ARENA.height - ARENA.paddleH;
const PADDLE_CENTER = PADDLE_TRAVEL / 2;

const game = {
  leftY: PADDLE_CENTER,
  rightY: PADDLE_CENTER,
  ball: newBall(1),
  score: { left: 0, right: 0 },
  winner: null as Side | null,
  winTicks: 0,
};

function assign(id: string) {
  if (slots.left === id || slots.right === id) return;
  if (!slots.left) slots.left = id;
  else if (!slots.right) slots.right = id;
}

function release(id: string) {
  if (slots.left === id) slots.left = null;
  if (slots.right === id) slots.right = null;
}

// Inclinação normalizada (-1..1) do jogador, ou null se não houver ESP32 nele
function tiltOf(side: Side): number | null {
  const id = slots[side];
  const p = id ? samples.get(id) : undefined;
  if (!p) return null;
  return Math.max(-1, Math.min(1, p[AXIS] / FULL_TILT));
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function newBall(direction: 1 | -1) {
  const angle = (Math.random() * 60 - 30) * (Math.PI / 180);
  return {
    x: ARENA.width / 2,
    y: ARENA.height / 2,
    vx: Math.cos(angle) * BALL_SPEED_INIT * direction,
    vy: Math.sin(angle) * BALL_SPEED_INIT,
  };
}

// Inclinação positiva = raquete para cima
function movePaddle(y: number, tilt: number | null, dir: Dir) {
  if (tilt !== null) {
    const target = PADDLE_CENTER - tilt * PADDLE_CENTER;
    y += (target - y) * TILT_SMOOTHING;
  } else {
    y += dir * PADDLE_SPEED;
  }
  return clamp(y, 0, PADDLE_TRAVEL);
}

function point(scorer: Side, leftTilt: number | null, rightTilt: number | null) {
  game.score[scorer]++;
  if (game.score[scorer] >= WIN_SCORE) {
    game.winner = scorer;
    game.winTicks = WIN_PAUSE_TICKS;
  }
  game.ball = newBall(scorer === "left" ? 1 : -1);
  // Depois de um ponto só a raquete de teclado volta ao centro;
  // a do ESP32 continua seguindo a inclinação da placa
  if (leftTilt === null) game.leftY = PADDLE_CENTER;
  if (rightTilt === null) game.rightY = PADDLE_CENTER;
}

function step() {
  const leftTilt = tiltOf("left");
  const rightTilt = tiltOf("right");
  game.leftY = movePaddle(game.leftY, leftTilt, keys.left);
  game.rightY = movePaddle(game.rightY, rightTilt, keys.right);

  // Fim de partida: mostra o vencedor por alguns segundos e recomeça sozinho
  if (game.winner) {
    if (--game.winTicks <= 0) {
      game.winner = null;
      game.score = { left: 0, right: 0 };
      game.ball = newBall(Math.random() < 0.5 ? 1 : -1);
    }
    return;
  }

  const b = game.ball;
  const r = ARENA.ball / 2;
  b.x += b.vx;
  b.y += b.vy;

  // Paredes de cima e de baixo
  if (b.y - r <= 0) {
    b.y = r;
    b.vy = Math.abs(b.vy);
  } else if (b.y + r >= ARENA.height) {
    b.y = ARENA.height - r;
    b.vy = -Math.abs(b.vy);
  }

  // Raquetes: o ângulo de saída depende de onde a bola bateu
  const bounce = (paddleY: number, dir: 1 | -1) => {
    const hitPos = (b.y - paddleY) / ARENA.paddleH - 0.5; // -0.5..0.5
    const angle = hitPos * (Math.PI / 2.5);
    const speed = Math.min(Math.hypot(b.vx, b.vy) * 1.05, BALL_SPEED_MAX);
    b.vx = dir * Math.abs(Math.cos(angle) * speed);
    b.vy = Math.sin(angle) * speed;
  };
  const hits = (paddleY: number) => b.y >= paddleY && b.y <= paddleY + ARENA.paddleH;

  const leftX = ARENA.paddleMargin + ARENA.paddleW;
  if (b.vx < 0 && b.x - r <= leftX && b.x - r >= ARENA.paddleMargin && hits(game.leftY)) {
    bounce(game.leftY, 1);
    b.x = leftX + r;
  }
  const rightX = ARENA.width - ARENA.paddleMargin - ARENA.paddleW;
  if (b.vx > 0 && b.x + r >= rightX && b.x + r <= ARENA.width - ARENA.paddleMargin && hits(game.rightY)) {
    bounce(game.rightY, -1);
    b.x = rightX - r;
  }

  if (b.x < 0) point("right", leftTilt, rightTilt);
  else if (b.x > ARENA.width) point("left", leftTilt, rightTilt);
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function stateMsg() {
  return JSON.stringify({
    type: "state",
    left: { y: round1(game.leftY), device: slots.left },
    right: { y: round1(game.rightY), device: slots.right },
    ball: { x: round1(game.ball.x), y: round1(game.ball.y) },
    score: game.score,
    winner: game.winner,
  });
}

// ---- rede ----

const server = Bun.serve<WsData>({
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
    open(ws) {
      if (ws.data.role !== "viewer") return;
      ws.subscribe(VIEWERS);
      ws.send(JSON.stringify({ type: "config", arena: ARENA, winScore: WIN_SCORE }));
      ws.send(stateMsg());
    },

    message(ws, raw) {
      if (ws.data.role === "viewer") {
        const msg = parseViewer(raw);
        if (!msg || slots[msg.side]) return; // lado com ESP32 ignora o teclado
        keys[msg.side] = msg.dir;
        keyOwner[msg.side] = msg.dir === 0 ? null : ws;
        return;
      }

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

      samples.set(msg.device, msg);
      assign(msg.device);
    },

    close(ws) {
      if (ws.data.role === "viewer") {
        // Tecla "presa" de quem fechou a aba
        for (const side of ["left", "right"] as const) {
          if (keyOwner[side] === ws) {
            keyOwner[side] = null;
            keys[side] = 0;
          }
        }
        return;
      }

      const id = ws.data.deviceId;
      if (!id) return;
      samples.delete(id);
      release(id);
      console.log(`[device] ${id} desconectado`);
    },
  },
});

// Passo fixo de 1/60 s. Handlers e tick rodam no mesmo event loop, nunca ao mesmo tempo.
const STEP_MS = 1000 / TICK_HZ;
let lastTime = performance.now();
let acc = 0;

function gameLoop() {
  const now = performance.now();
  acc += now - lastTime;
  lastTime = now;

  let steps = 0;
  while (acc >= STEP_MS && steps < 5) {
    step();
    acc -= STEP_MS;
    steps++;
  }
  if (steps === 5) acc = 0; // servidor travou: não tenta recuperar o atraso inteiro
  if (steps > 0) server.publish(VIEWERS, stateMsg());
}

// Com `bun --hot` o módulo é reexecutado; limpa o timer da versão anterior
declare global {
  var __pongTimer: Timer | undefined;
}
clearInterval(globalThis.__pongTimer);
globalThis.__pongTimer = setInterval(gameLoop, 4);

console.log(`Página:  http://localhost:${PORT}/game`);
console.log(`ESP32:   ws://<ip-do-pc>:${PORT}/`);
