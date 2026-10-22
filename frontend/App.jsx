import { useRef } from 'react';
import { usePong } from './usePong';
import { useGame, useKeyboard } from './useGame';
import './App.css';

const STATUS_TEXT = {
  connecting: 'Conectando ao servidor…',
  ok: 'Conectado',
  bad: 'Sem conexão com o servidor. Tentando de novo…',
};

const PLAYER_NAME = { left: 'Jogador 1', right: 'Jogador 2' };

function controlLabel(deviceId, keys) {
  return deviceId ? `ESP32 ${deviceId}` : keys;
}

export default function App() {
  const canvasRef = useRef(null);
  const { stateRef, arena, winScore, view, status, send } = useGame();
  usePong(canvasRef, stateRef, arena);
  useKeyboard(send);

  const score = view?.score ?? { left: 0, right: 0 };
  const leftControl = controlLabel(view?.devices.left, 'W / S');
  const rightControl = controlLabel(view?.devices.right, '↑ / ↓');

  return (
    <div className="app">
      <h1 className="title">Pong</h1>
      <p className={`status ${status}`}>{STATUS_TEXT[status]}</p>
      <div className="scoreboard">
        <span>{score.left}</span>
        <span>{score.right}</span>
      </div>
      <div className="canvas-wrapper">
        <canvas ref={canvasRef} width={arena.width} height={arena.height} />

        {status !== 'ok' ? (
          <div className="overlay">
            <h2>Sem servidor</h2>
            <p>A partida continua no servidor; a tela volta quando reconectar.</p>
          </div>
        ) : view?.winner ? (
          <div className="overlay">
            <h2>{PLAYER_NAME[view.winner]} venceu!</h2>
            <p>{score.left} — {score.right}</p>
            <p>Nova partida em instantes…</p>
          </div>
        ) : null}
      </div>
      <p className="controls-hint">
        Jogador 1: {leftControl} &nbsp;·&nbsp; Jogador 2: {rightControl}
        <br />
        Primeiro a {winScore} pontos vence
      </p>
    </div>
  );
}
