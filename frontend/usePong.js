import { useEffect } from 'react';

const COLORS = {
  background: '#ffffff',
  centerLine: '#d4d4d4',
  piece: '#1a1a1a',
};

// Desenha no canvas o último estado recebido do servidor. Sem física aqui.
export function usePong(canvasRef, stateRef, arena) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const { width, height, paddleW, paddleH, paddleMargin, ball } = arena;
    let frame;

    function draw() {
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(0, 0, width, height);

      // Linha central
      ctx.setLineDash([10, 10]);
      ctx.strokeStyle = COLORS.centerLine;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(width / 2, 0);
      ctx.lineTo(width / 2, height);
      ctx.stroke();
      ctx.setLineDash([]);

      const s = stateRef.current;
      if (s) {
        ctx.fillStyle = COLORS.piece;
        ctx.fillRect(paddleMargin, s.left.y, paddleW, paddleH);
        ctx.fillRect(width - paddleMargin - paddleW, s.right.y, paddleW, paddleH);

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
