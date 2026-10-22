// Motor do jogo: estado autoritativo da partida e física.
// Não conhece sockets — main.ts entrega as entradas e chama step() em ritmo fixo.
// Só step() altera posições, bola e placar; as entradas apenas gravam alvos.

import type { PlayerId } from "./protocol.ts";

export const TICK_HZ = 60;
export const WIN_SCORE = 7;

export const ARENA = {
  width: 800,
  height: 500,
  paddleW: 12,
  paddleH: 80,
  paddleMargin: 16, // distância da raquete até a borda
  ball: 12, // diâmetro
};

const PADDLE_SPEED = 6; // px por tick, raquete de teclado
const PADDLE_FOLLOW = 0.6; // fração do caminho até o alvo do ESP32 percorrida por tick
const BALL_SPEED_INIT = 5; // px por tick
const BALL_SPEED_MAX = 12; // < paddleW, para a bola não atravessar a raquete
const SERVE_DELAY_TICKS = TICK_HZ; // 1 s parada no centro antes de cada saque

export type Phase = "waiting" | "playing" | "paused" | "over";

type Paddle = {
  y: number; // topo da raquete
  esp32: boolean; // controlada por ESP32 conectado (senão, teclado)
  target: number | null; // alvo vindo da inclinação; null = sem amostra ainda
  keyDir: -1 | 0 | 1;
};

const PADDLE_TRAVEL = ARENA.height - ARENA.paddleH;
const PADDLE_CENTER = PADDLE_TRAVEL / 2;
const LEFT_FACE = ARENA.paddleMargin + ARENA.paddleW;
const RIGHT_FACE = ARENA.width - ARENA.paddleMargin - ARENA.paddleW;

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

function newPaddle(): Paddle {
  return { y: PADDLE_CENTER, esp32: false, target: null, keyDir: 0 };
}

export class Game {
  phase: Phase = "waiting";
  winner: PlayerId | null = null;
  pausedFor: PlayerId | null = null; // jogador cuja queda pausou a partida
  tick = 0;
  score: Record<PlayerId, number> = { 1: 0, 2: 0 };
  paddles: Record<PlayerId, Paddle> = { 1: newPaddle(), 2: newPaddle() };
  ball = { x: ARENA.width / 2, y: ARENA.height / 2, vx: 0, vy: 0 };
  private serveIn = 0;

  constructor() {
    this.serve(1);
  }

  // ---- entradas (chamadas pelos handlers de rede) ----

  // pos: -1..1, positivo = raquete para cima
  setTilt(p: PlayerId, pos: number) {
    this.paddles[p].target = PADDLE_CENTER - pos * (PADDLE_TRAVEL / 2);
  }

  setKey(p: PlayerId, dir: -1 | 0 | 1) {
    this.paddles[p].keyDir = dir;
  }

  setEsp32(p: PlayerId, connected: boolean) {
    const pad = this.paddles[p];
    pad.esp32 = connected;
    pad.target = null; // raquete fica parada até chegar a primeira amostra
    pad.keyDir = 0;

    if (!connected && this.phase === "playing") {
      this.phase = "paused";
      this.pausedFor = p;
    } else if (connected && this.phase === "paused" && this.pausedFor === p) {
      this.resume();
    }
  }

  start() {
    if (this.phase !== "waiting") return;
    this.phase = "playing";
  }

  restart() {
    this.score = { 1: 0, 2: 0 };
    this.winner = null;
    this.pausedFor = null;
    this.phase = "playing";
    this.serve(Math.random() < 0.5 ? 1 : 2);
  }

  resume() {
    if (this.phase !== "paused") return;
    this.phase = "playing";
    this.pausedFor = null;
  }

  // ---- motor ----

  step() {
    this.tick++;
    this.movePaddles(); // raquetes se movem em qualquer fase, para testar o controle
    if (this.phase !== "playing") return;
    if (this.serveIn > 0) {
      this.serveIn--;
      return;
    }
    this.moveBall();
  }

  private movePaddles() {
    for (const pad of Object.values(this.paddles)) {
      if (pad.esp32) {
        if (pad.target !== null) pad.y += (pad.target - pad.y) * PADDLE_FOLLOW;
      } else {
        pad.y += pad.keyDir * PADDLE_SPEED;
      }
      pad.y = clamp(pad.y, 0, PADDLE_TRAVEL);
    }
  }

  private moveBall() {
    const b = this.ball;
    const r = ARENA.ball / 2;
    b.x += b.vx;
    b.y += b.vy;

    // paredes de cima e de baixo
    if (b.y - r <= 0) {
      b.y = r;
      b.vy = Math.abs(b.vy);
    } else if (b.y + r >= ARENA.height) {
      b.y = ARENA.height - r;
      b.vy = -Math.abs(b.vy);
    }

    // raquetes
    const left = this.paddles[1];
    const right = this.paddles[2];
    if (b.vx < 0 && b.x - r <= LEFT_FACE && b.x - r >= ARENA.paddleMargin && this.hits(left)) {
      this.bounce(left, 1);
      b.x = LEFT_FACE + r;
    }
    if (b.vx > 0 && b.x + r >= RIGHT_FACE && b.x + r <= ARENA.width - ARENA.paddleMargin && this.hits(right)) {
      this.bounce(right, -1);
      b.x = RIGHT_FACE - r;
    }

    // pontos
    if (b.x < 0) this.point(2);
    else if (b.x > ARENA.width) this.point(1);
  }

  private hits(pad: Paddle) {
    return this.ball.y >= pad.y && this.ball.y <= pad.y + ARENA.paddleH;
  }

  // O ângulo de saída depende de onde a bola bateu na raquete
  private bounce(pad: Paddle, dir: 1 | -1) {
    const b = this.ball;
    const hitPos = (b.y - pad.y) / ARENA.paddleH - 0.5; // -0.5..0.5
    const angle = hitPos * (Math.PI / 2.5);
    const speed = Math.min(Math.hypot(b.vx, b.vy) * 1.05, BALL_SPEED_MAX);
    b.vx = dir * Math.abs(Math.cos(angle) * speed);
    b.vy = Math.sin(angle) * speed;
  }

  private point(scorer: PlayerId) {
    this.score[scorer]++;
    if (this.score[scorer] >= WIN_SCORE) {
      this.phase = "over";
      this.winner = scorer;
    }
    // Só raquetes de teclado voltam ao centro; as do ESP32 seguem a placa
    for (const pad of Object.values(this.paddles)) {
      if (!pad.esp32) pad.y = PADDLE_CENTER;
    }
    // Quem sofreu o ponto recebe o saque
    this.serve(scorer === 1 ? 2 : 1);
  }

  private serve(toward: PlayerId) {
    const angle = (Math.random() * 60 - 30) * (Math.PI / 180);
    const dir = toward === 1 ? -1 : 1;
    this.ball = {
      x: ARENA.width / 2,
      y: ARENA.height / 2,
      vx: Math.cos(angle) * BALL_SPEED_INIT * dir,
      vy: Math.sin(angle) * BALL_SPEED_INIT,
    };
    this.serveIn = SERVE_DELAY_TICKS;
  }

  // Estado enviado aos navegadores (arredondado para economizar banda)
  snapshot() {
    return {
      tick: this.tick,
      phase: this.phase,
      winner: this.winner,
      pausedFor: this.pausedFor,
      score: this.score,
      ball: { x: round1(this.ball.x), y: round1(this.ball.y) },
      paddles: {
        1: { y: round1(this.paddles[1].y), control: this.paddles[1].esp32 ? "esp32" : "keyboard" },
        2: { y: round1(this.paddles[2].y), control: this.paddles[2].esp32 ? "esp32" : "keyboard" },
      },
    };
  }
}
