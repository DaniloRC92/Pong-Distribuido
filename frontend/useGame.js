import { useEffect, useRef, useState, useCallback } from 'react';

const DEFAULT_ARENA = {
  width: 800, height: 500, paddleW: 12, paddleH: 80, paddleMargin: 16, ball: 12,
};

// Conecta em /viewer e guarda o último estado enviado pelo servidor.
// A página não simula nada: todas as abas mostram a mesma partida.
export function useGame() {
  const stateRef = useRef(null); // último estado; o canvas lê daqui a cada quadro
  const wsRef = useRef(null);
  const [arena, setArena] = useState(DEFAULT_ARENA);
  const [winScore, setWinScore] = useState(7);
  const [view, setView] = useState(null); // placar, vencedor e quem controla cada lado
  const [status, setStatus] = useState('connecting'); // connecting | ok | bad

  useEffect(() => {
    let ws;
    let retry;
    let closed = false;
    let lastViewKey = '';

    // Re-renderiza o React só quando o placar ou os controles mudam (não a 60 Hz)
    const updateView = (s) => {
      const v = {
        score: s.score,
        winner: s.winner,
        devices: { left: s.left.device, right: s.right.device },
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
        retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'config') {
          setArena(msg.arena);
          setWinScore(msg.winScore);
        } else if (msg.type === 'state') {
          stateRef.current = msg;
          updateView(msg);
        }
      };
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws.close();
    };
  }, []);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { stateRef, arena, winScore, view, status, send };
}

// Teclado só move raquetes sem ESP32 — quem decide isso é o servidor
const KEYS = {
  KeyW: ['left', -1], KeyS: ['left', 1],
  ArrowUp: ['right', -1], ArrowDown: ['right', 1],
};

export function useKeyboard(send) {
  useEffect(() => {
    const pressed = new Set();
    const lastDir = { left: 0, right: 0 };

    const sync = () => {
      for (const side of ['left', 'right']) {
        let dir = 0;
        for (const code of pressed) {
          if (KEYS[code][0] === side) dir += KEYS[code][1];
        }
        dir = Math.sign(dir);
        if (dir !== lastDir[side]) {
          lastDir[side] = dir;
          send({ type: 'key', side, dir });
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
