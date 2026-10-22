import { useEffect, useRef, useState, useCallback } from 'react';

const DEFAULT_ARENA = {
  width: 800, height: 500, paddleW: 12, paddleH: 80, paddleMargin: 16, ball: 12,
};
const RECONNECT_MS = 2000;
const PING_MS = 1000;

// O navegador não é autoridade sobre nada: conecta em /viewer, guarda o último
// estado que o servidor mandou e envia comandos (iniciar, teclas, calibrar).
export function useGame() {
  const stateRef = useRef(null); // último estado; o canvas lê daqui a cada quadro
  const wsRef = useRef(null);
  const [arena, setArena] = useState(DEFAULT_ARENA);
  const [winScore, setWinScore] = useState(7);
  const [view, setView] = useState(null); // parte do estado que a UI em React mostra
  const [stats, setStats] = useState(null);
  const [status, setStatus] = useState('connecting'); // connecting | ok | bad
  const [net, setNet] = useState({ rtt: null, statesPerSec: 0 });

  useEffect(() => {
    let ws;
    let retry;
    let closed = false;
    let pingId = 0;
    const pings = new Map(); // id -> instante do envio
    let statesInWindow = 0;
    let lastRtt = null;
    let lastViewKey = '';

    // Re-renderiza o React só quando fase, placar ou controles mudam (não a 60 Hz)
    const updateView = (s) => {
      const v = {
        phase: s.phase,
        winner: s.winner,
        pausedFor: s.pausedFor,
        score: s.score,
        control: { 1: s.paddles[1].control, 2: s.paddles[2].control },
      };
      const key = JSON.stringify(v);
      if (key !== lastViewKey) {
        lastViewKey = key;
        setView(v);
      }
    };

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/viewer`);
      wsRef.current = ws;

      ws.onopen = () => setStatus('ok');
      ws.onclose = () => {
        if (closed) return;
        setStatus('bad');
        retry = setTimeout(connect, RECONNECT_MS);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case 'welcome':
            setArena(msg.arena);
            setWinScore(msg.winScore);
            break;
          case 'state':
            stateRef.current = msg;
            statesInWindow++;
            updateView(msg);
            break;
          case 'stats':
            setStats(msg);
            break;
          case 'pong': {
            const sentAt = pings.get(msg.id);
            pings.delete(msg.id);
            if (sentAt !== undefined) lastRtt = performance.now() - sentAt;
            break;
          }
        }
      };
    }

    const tick = setInterval(() => {
      setNet({ rtt: lastRtt, statesPerSec: statesInWindow });
      statesInWindow = 0;
      if (ws?.readyState === WebSocket.OPEN) {
        pings.clear(); // pong que não voltou em 1 s não conta
        pings.set(++pingId, performance.now());
        ws.send(JSON.stringify({ type: 'ping', id: pingId }));
      }
    }, PING_MS);

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(tick);
      ws.close();
    };
  }, []);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { stateRef, arena, winScore, view, stats, status, net, send };
}

// Teclado só move raquetes sem ESP32 — quem decide isso é o servidor
const KEYS = {
  KeyW: [1, -1], KeyS: [1, 1],
  ArrowUp: [2, -1], ArrowDown: [2, 1],
};

export function useKeyboard(send) {
  useEffect(() => {
    const pressed = new Set();
    const lastDir = { 1: 0, 2: 0 };

    const dirOf = (player) => {
      let dir = 0;
      for (const code of pressed) {
        const k = KEYS[code];
        if (k && k[0] === player) dir += k[1];
      }
      return Math.sign(dir);
    };

    const sync = () => {
      for (const p of [1, 2]) {
        const dir = dirOf(p);
        if (dir !== lastDir[p]) {
          lastDir[p] = dir;
          send({ type: 'key', player: p, dir });
        }
      }
    };

    const onKey = (e) => {
      if (!KEYS[e.code]) return;
      e.preventDefault(); // setas não rolam a página
      if (e.type === 'keydown') pressed.add(e.code);
      else pressed.delete(e.code);
      sync();
    };
    const onBlur = () => {
      pressed.clear();
      sync();
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [send]);
}
