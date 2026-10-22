import { useEffect } from 'react';

// Desenha no canvas o último estado recebido do servidor.
// Não há física aqui: só representação.
export function useRenderer(canvasRef, stateRef, arena) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const { width, height, paddleW, paddleH, paddleMargin, ball } = arena;
    let frame;

    function draw() {
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, width, height);

      // Linha central
      ctx.setLineDash([10, 10]);
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(width / 2, 0);
      ctx.lineTo(width / 2, height);
      ctx.stroke();
      ctx.setLineDash([]);

      const s = stateRef.current;
      if (s) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(paddleMargin, s.paddles[1].y, paddleW, paddleH);
        ctx.fillRect(width - paddleMargin - paddleW, s.paddles[2].y, paddleW, paddleH);

        ctx.beginPath();
        ctx.arc(s.ball.x, s.ball.y, ball / 2, 0, Math.PI * 2);
        ctx.fill();
      }

      frame = requestAnimationFrame(draw);
    }

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [canvasRef, stateRef, arena]);
}
