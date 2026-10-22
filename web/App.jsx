import { useRef } from 'react';
import { useGame, useKeyboard } from './useGame';
import { useRenderer } from './useRenderer';
import './App.css';

const STATUS_TEXT = {
  connecting: 'Conectando ao servidor…',
  ok: 'Conectado ao servidor',
  bad: 'Sem conexão com o servidor. Tentando de novo…',
};

const KEYS_LABEL = { 1: 'W / S', 2: '↑ / ↓' };

const fmt = (v, unit = '') => (v === null || v === undefined ? '—' : `${Math.round(v)}${unit}`);

function PlayerPanel({ player, control, info, onCalibrate }) {
  const online = info?.online;
  const d = info?.deviceStats;

  let badge = 'offline';
  let badgeText = 'ESP32 desconectado';
  if (online && info.stale) {
    badge = 'stale';
    badgeText = 'ESP32 conectado, sem dados';
  } else if (online) {
    badge = 'online';
    badgeText = 'ESP32 conectado';
  }

  return (
    <div className="panel">
      <h3>Jogador {player}</h3>
      <p className={`badge ${badge}`}>{badgeText}</p>
      <p className="control">
        Controle: {control === 'esp32' ? `ESP32 ${info?.device ?? ''}` : `teclado (${KEYS_LABEL[player]})`}
      </p>
      <dl>
        <dt>leituras/s (ESP32)</dt><dd>{fmt(d?.reads)}</dd>
        <dt>envios/s (ESP32)</dt><dd>{fmt(d?.sent)}</dd>
        <dt>descartadas/s</dt><dd>{fmt(d?.dropped)}</dd>
        <dt>recebidas/s (servidor)</dt><dd>{fmt(info?.inputsPerSec)}</dd>
        <dt>RTT ESP32↔servidor</dt><dd>{fmt(d && d.rtt >= 0 ? d.rtt : null, ' ms')}</dd>
        <dt>idade da amostra</dt><dd>{fmt(info?.ageMs, ' ms')}</dd>
        <dt>perdidas / fora de ordem</dt><dd>{fmt(info?.lost)} / {fmt(info?.outOfOrder)}</dd>
        <dt>reconexões (ESP32)</dt><dd>{fmt(d?.reconnects)}</dd>
        <dt>erros I²C</dt><dd>{fmt(d?.i2cErrors)}</dd>
      </dl>
      <button disabled={!online} onClick={onCalibrate}>Calibrar repouso</button>
    </div>
  );
}

export default function App() {
  const canvasRef = useRef(null);
  const { stateRef, arena, winScore, view, stats, status, net, send } = useGame();
  useRenderer(canvasRef, stateRef, arena);
  useKeyboard(send);

  const phase = view?.phase;
  const score = view?.score ?? { 1: 0, 2: 0 };
  const control = view?.control ?? { 1: 'keyboard', 2: 'keyboard' };

  return (
    <div className="app">
      <h1 className="title">Pong</h1>
      <p className={`status ${status}`}>{STATUS_TEXT[status]}</p>
      <div className="scoreboard">
        <span>{score[1]}</span>
        <span>{score[2]}</span>
      </div>

      <div className="canvas-wrapper">
        <canvas ref={canvasRef} width={arena.width} height={arena.height} />

        {status !== 'ok' ? (
          <div className="overlay">
            <h2>Sem servidor</h2>
            <p>A partida continua no servidor; a tela volta quando reconectar.</p>
          </div>
        ) : phase === 'waiting' ? (
          <div className="overlay">
            <h2>Pong</h2>
            <p>Primeiro a {winScore} pontos vence</p>
            <button onClick={() => send({ type: 'start' })}>Iniciar</button>
          </div>
        ) : phase === 'paused' ? (
          <div className="overlay">
            <h2>Pausado</h2>
            <p>ESP32 do Jogador {view.pausedFor} desconectou.</p>
            <p>A partida volta sozinha quando ele reconectar.</p>
            <button onClick={() => send({ type: 'resume' })}>Continuar com teclado</button>
          </div>
        ) : phase === 'over' ? (
          <div className="overlay">
            <h2>Jogador {view.winner} venceu!</h2>
            <p>{score[1]} — {score[2]}</p>
            <button onClick={() => send({ type: 'restart' })}>Jogar novamente</button>
          </div>
        ) : null}
      </div>

      <div className="panels">
        {[1, 2].map((p) => (
          <PlayerPanel
            key={p}
            player={p}
            control={control[p]}
            info={stats?.players?.[p]}
            onCalibrate={() => send({ type: 'calibrate', player: p })}
          />
        ))}
      </div>

      <p className="controls-hint">
        servidor: {fmt(stats?.tickRate)} ticks/s &nbsp;·&nbsp; estados recebidos: {net.statesPerSec}/s
        &nbsp;·&nbsp; RTT navegador↔servidor: {net.rtt === null ? '—' : `${net.rtt.toFixed(1)} ms`}
      </p>
    </div>
  );
}
