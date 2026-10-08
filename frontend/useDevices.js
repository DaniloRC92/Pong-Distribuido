import { useEffect, useRef, useState, useCallback } from 'react';

// Eixo do acelerômetro que move a raquete (em g, -1..1 ≈ -90°..90°)
const AXIS = 'y';
// Inclinação (em g) que leva a raquete de uma ponta à outra
const FULL_TILT = 0.6;

const EMPTY_SLOTS = { left: null, right: null };

// Conecta em /viewer e distribui os ESP32 entre os dois jogadores:
// o primeiro que chega é o J1, o segundo é o J2.
export function useDevices() {
  const samplesRef = useRef(new Map()); // id -> { x, y, z }
  const slotsRef = useRef({ ...EMPTY_SLOTS });
  const [slots, setSlots] = useState(EMPTY_SLOTS);
  const [status, setStatus] = useState('connecting'); // connecting | ok | bad

  useEffect(() => {
    let ws;
    let retry;
    let closed = false;

    const publishSlots = () => setSlots({ ...slotsRef.current });

    const assign = (id) => {
      const s = slotsRef.current;
      if (s.left === id || s.right === id) return;
      if (!s.left) s.left = id;
      else if (!s.right) s.right = id;
      else return; // já tem dois jogadores
      publishSlots();
    };

    const release = (id) => {
      const s = slotsRef.current;
      if (s.left === id) s.left = null;
      if (s.right === id) s.right = null;
      publishSlots();
    };

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/viewer`);

      ws.onopen = () => setStatus('ok');
      ws.onclose = () => {
        if (closed) return;
        setStatus('bad');
        retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'snapshot') {
          samplesRef.current.clear();
          slotsRef.current = { ...EMPTY_SLOTS };
          for (const [id, p] of Object.entries(msg.users)) {
            samplesRef.current.set(id, p);
            assign(id);
          }
          publishSlots();
        } else if (msg.type === 'pos') {
          samplesRef.current.set(msg.device, msg);
          assign(msg.device);
        } else if (msg.type === 'leave') {
          samplesRef.current.delete(msg.device);
          release(msg.device);
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

  // Inclinação normalizada (-1..1) do jogador, ou null se não houver ESP32 nele
  const getTilt = useCallback((side) => {
    const id = slotsRef.current[side];
    const p = id && samplesRef.current.get(id);
    if (!p) return null;
    return Math.max(-1, Math.min(1, p[AXIS] / FULL_TILT));
  }, []);

  return { slots, status, getTilt };
}
