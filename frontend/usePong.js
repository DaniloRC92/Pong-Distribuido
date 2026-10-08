import { useEffect, useRef, useCallback } from 'react';

const WIDTH = 800;
const HEIGHT = 500;
const PADDLE_W = 12;
const PADDLE_H = 80;
const BALL_SIZE = 12;
const PADDLE_SPEED = 5;
const BALL_SPEED_INIT = 5;
const BALL_SPEED_MAX = 12;
const WIN_SCORE = 7;
const TILT_SMOOTHING = 0.3; // fração do caminho até o alvo percorrida por quadro

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// Inclinação -1..1 vira a posição da raquete (positivo = para cima)
function paddleFromTilt(currentY, tilt) {
  const target = (HEIGHT - PADDLE_H) / 2 - tilt * (HEIGHT - PADDLE_H) / 2;
  return currentY + (target - currentY) * TILT_SMOOTHING;
}

// Depois de um ponto, só a raquete de teclado volta ao centro;
// a do ESP32 continua seguindo a inclinação da placa
function centerKeyboardPaddles(s, leftTilt, rightTilt) {
  const center = HEIGHT / 2 - PADDLE_H / 2;
  if (leftTilt === null) s.leftY = center;
  if (rightTilt === null) s.rightY = center;
}

function newBall(direction = 1) {
  const angle = (Math.random() * 60 - 30) * (Math.PI / 180);
  return {
    x: WIDTH / 2,
    y: HEIGHT / 2,
    vx: Math.cos(angle) * BALL_SPEED_INIT * direction,
    vy: Math.sin(angle) * BALL_SPEED_INIT,
  };
}

// getTilt(side) devolve a inclinação do ESP32 daquele lado ou null (usa teclado)
export function usePong(canvasRef, onScore, getTilt) {
  const stateRef = useRef(null);
  const keysRef = useRef({});
  const animRef = useRef(null);
  const onScoreRef = useRef(onScore);
  onScoreRef.current = onScore;
  const getTiltRef = useRef(getTilt);
  getTiltRef.current = getTilt;

  const getState = useCallback(() => stateRef.current, []);

  const resetGame = useCallback(() => {
    stateRef.current = {
      leftY: HEIGHT / 2 - PADDLE_H / 2,
      rightY: HEIGHT / 2 - PADDLE_H / 2,
      ball: newBall(1),
      scoreLeft: 0,
      scoreRight: 0,
      running: false,
      winner: null,
    };
  }, []);

  const start = useCallback(() => {
    if (!stateRef.current) resetGame();
    stateRef.current.running = true;
    stateRef.current.winner = null;
  }, [resetGame]);

  const restart = useCallback(() => {
    resetGame();
    stateRef.current.running = true;
  }, [resetGame]);

  useEffect(() => {
    resetGame();
  }, [resetGame]);

  useEffect(() => {
    const onKey = (e) => { keysRef.current[e.code] = e.type === 'keydown'; };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    function draw(s) {
      // Background
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      // Center dashed line
      ctx.setLineDash([10, 10]);
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(WIDTH / 2, 0);
      ctx.lineTo(WIDTH / 2, HEIGHT);
      ctx.stroke();
      ctx.setLineDash([]);

      // Paddles
      ctx.fillStyle = '#fff';
      ctx.fillRect(16, s.leftY, PADDLE_W, PADDLE_H);
      ctx.fillRect(WIDTH - 16 - PADDLE_W, s.rightY, PADDLE_W, PADDLE_H);

      // Ball
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(s.ball.x, s.ball.y, BALL_SIZE / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    function update(s) {
      if (!s.running) return;

      const keys = keysRef.current;
      const leftTilt = getTiltRef.current('left');
      const rightTilt = getTiltRef.current('right');

      // Left paddle: ESP32 do J1, ou W/S
      if (leftTilt !== null) {
        s.leftY = paddleFromTilt(s.leftY, leftTilt);
      } else {
        if (keys['KeyW']) s.leftY -= PADDLE_SPEED;
        if (keys['KeyS']) s.leftY += PADDLE_SPEED;
      }
      s.leftY = clamp(s.leftY, 0, HEIGHT - PADDLE_H);

      // Right paddle: ESP32 do J2, ou ArrowUp/ArrowDown
      if (rightTilt !== null) {
        s.rightY = paddleFromTilt(s.rightY, rightTilt);
      } else {
        if (keys['ArrowUp']) s.rightY -= PADDLE_SPEED;
        if (keys['ArrowDown']) s.rightY += PADDLE_SPEED;
      }
      s.rightY = clamp(s.rightY, 0, HEIGHT - PADDLE_H);

      // Move ball
      s.ball.x += s.ball.vx;
      s.ball.y += s.ball.vy;

      // Top/bottom wall bounce
      if (s.ball.y - BALL_SIZE / 2 <= 0) {
        s.ball.y = BALL_SIZE / 2;
        s.ball.vy *= -1;
      }
      if (s.ball.y + BALL_SIZE / 2 >= HEIGHT) {
        s.ball.y = HEIGHT - BALL_SIZE / 2;
        s.ball.vy *= -1;
      }

      // Left paddle collision
      const leftX = 16 + PADDLE_W;
      if (
        s.ball.vx < 0 &&
        s.ball.x - BALL_SIZE / 2 <= leftX &&
        s.ball.x - BALL_SIZE / 2 >= 16 &&
        s.ball.y >= s.leftY &&
        s.ball.y <= s.leftY + PADDLE_H
      ) {
        const hitPos = (s.ball.y - s.leftY) / PADDLE_H - 0.5; // -0.5 to 0.5
        const angle = hitPos * (Math.PI / 2.5);
        const speed = Math.min(Math.hypot(s.ball.vx, s.ball.vy) * 1.05, BALL_SPEED_MAX);
        s.ball.vx = Math.abs(Math.cos(angle) * speed);
        s.ball.vy = Math.sin(angle) * speed;
        s.ball.x = leftX + BALL_SIZE / 2;
      }

      // Right paddle collision
      const rightX = WIDTH - 16 - PADDLE_W;
      if (
        s.ball.vx > 0 &&
        s.ball.x + BALL_SIZE / 2 >= rightX &&
        s.ball.x + BALL_SIZE / 2 <= WIDTH - 16 &&
        s.ball.y >= s.rightY &&
        s.ball.y <= s.rightY + PADDLE_H
      ) {
        const hitPos = (s.ball.y - s.rightY) / PADDLE_H - 0.5;
        const angle = hitPos * (Math.PI / 2.5);
        const speed = Math.min(Math.hypot(s.ball.vx, s.ball.vy) * 1.05, BALL_SPEED_MAX);
        s.ball.vx = -Math.abs(Math.cos(angle) * speed);
        s.ball.vy = Math.sin(angle) * speed;
        s.ball.x = rightX - BALL_SIZE / 2;
      }

      // Score
      if (s.ball.x < 0) {
        s.scoreRight += 1;
        onScoreRef.current({ left: s.scoreLeft, right: s.scoreRight });
        if (s.scoreRight >= WIN_SCORE) {
          s.running = false;
          s.winner = 'right';
        } else {
          s.ball = newBall(1);
          centerKeyboardPaddles(s, leftTilt, rightTilt);
        }
      }
      if (s.ball.x > WIDTH) {
        s.scoreLeft += 1;
        onScoreRef.current({ left: s.scoreLeft, right: s.scoreRight });
        if (s.scoreLeft >= WIN_SCORE) {
          s.running = false;
          s.winner = 'left';
        } else {
          s.ball = newBall(-1);
          centerKeyboardPaddles(s, leftTilt, rightTilt);
        }
      }
    }

    function loop() {
      const s = stateRef.current;
      if (s) {
        update(s);
        draw(s);
      }
      animRef.current = requestAnimationFrame(loop);
    }

    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [canvasRef]);

  return { getState, start, restart, WIDTH, HEIGHT };
}
