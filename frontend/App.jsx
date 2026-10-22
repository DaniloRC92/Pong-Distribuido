import { useRef, useState, useCallback, useEffect } from 'react';
import { usePong } from './usePong';
import { useDevices } from './useDevices';
import './App.css';

const WIN_SCORE = 7;

const STATUS_TEXT = {
  connecting: 'Conectando ao servidor…',
  ok: 'Conectado',
  bad: 'Sem conexão com o servidor. Tentando de novo…',
};

function controlLabel(deviceId, keys) {
  return deviceId ? `ESP32 ${deviceId}` : keys;
}

export default function App() {
  const canvasRef = useRef(null);
  const [score, setScore] = useState({ left: 0, right: 0 });
  const [phase, setPhase] = useState('idle'); // idle | playing | won
  const { slots, status, getTilt } = useDevices();

  const handleScore = useCallback((s) => {
    setScore({ ...s });
    if (s.left >= WIN_SCORE || s.right >= WIN_SCORE) {
      setPhase('won');
    }
  }, []);

  const { getState, start, restart, WIDTH, HEIGHT } = usePong(canvasRef, handleScore, getTilt);

  const handleStart = () => {
    start();
    setPhase('playing');
  };

  const handleRestart = () => {
    setScore({ left: 0, right: 0 });
    restart();
    setPhase('playing');
  };

  const winnerLabel = () => {
    const s = getState();
    if (!s) return '';
    return s.winner === 'left' ? 'Jogador 1' : 'Jogador 2';
  };

  // Prevent arrow keys from scrolling the page during play
  useEffect(() => {
    const prevent = (e) => {
      if (['ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
    };
    window.addEventListener('keydown', prevent, { passive: false });
    return () => window.removeEventListener('keydown', prevent);
  }, []);

  const leftControl = controlLabel(slots.left, 'W / S');
  const rightControl = controlLabel(slots.right, '↑ / ↓');

  return (
    <div className="app">
      <h1 className="title">Pong</h1>
      <p className={`status ${status}`}>{STATUS_TEXT[status]}</p>
      <div className="scoreboard">
        <span>{score.left}</span>
        <span>{score.right}</span>
      </div>
      <div className="canvas-wrapper">
        <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} />

        {phase === 'idle' && (
          <div className="overlay">
            <h2>Pong</h2>
            <p>Primeiro a {WIN_SCORE} pontos vence</p>
            <button onClick={handleStart}>Iniciar</button>
            <p className="controls-hint">
              J1: {leftControl} &nbsp;|&nbsp; J2: {rightControl}
            </p>
          </div>
        )}

        {phase === 'won' && (
          <div className="overlay">
            <h2>{winnerLabel()} venceu!</h2>
            <p>{score.left} — {score.right}</p>
            <button onClick={handleRestart}>Jogar novamente</button>
          </div>
        )}
      </div>
      <p className="controls-hint">
        Jogador 1: {leftControl} &nbsp;·&nbsp; Jogador 2: {rightControl}
      </p>
    </div>
  );
}
