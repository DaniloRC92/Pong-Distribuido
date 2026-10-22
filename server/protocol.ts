// Mensagens trocadas pela rede. JSON.parse devolve any: tudo que chega é
// validado aqui antes de qualquer campo ser usado.

export type PlayerId = 1 | 2;

// ESP32 -> servidor
export type DeviceMsg =
  | { type: "hello"; player: PlayerId; device: string; sampleHz: number; sendHz: number }
  | { type: "input"; seq: number; sample: number; t: number; pos: number }
  | {
      type: "stats";
      reads: number;
      sent: number;
      dropped: number;
      i2cErrors: number;
      reconnects: number;
      rtt: number;
    }
  | { type: "ping"; id: number };

// Navegador -> servidor
export type ViewerMsg =
  | { type: "start" }
  | { type: "restart" }
  | { type: "resume" }
  | { type: "key"; player: PlayerId; dir: -1 | 0 | 1 }
  | { type: "calibrate"; player: PlayerId }
  | { type: "ping"; id: number };

function decode(raw: string | Buffer): any {
  try {
    return JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    return null;
  }
}

const isPlayer = (v: unknown): v is PlayerId => v === 1 || v === 2;
const allFinite = (...v: unknown[]) => v.every(Number.isFinite);

export function parseDevice(raw: string | Buffer): DeviceMsg | null {
  const m = decode(raw);
  switch (m?.type) {
    case "hello":
      if (
        isPlayer(m.player) &&
        typeof m.device === "string" &&
        m.device !== "" &&
        m.device.length <= 32 &&
        allFinite(m.sampleHz, m.sendHz)
      )
        return m;
      return null;
    case "input":
      if (allFinite(m.seq, m.sample, m.t, m.pos) && Math.abs(m.pos) <= 1) return m;
      return null;
    case "stats":
      if (allFinite(m.reads, m.sent, m.dropped, m.i2cErrors, m.reconnects, m.rtt)) return m;
      return null;
    case "ping":
      return Number.isFinite(m.id) ? m : null;
    default:
      return null;
  }
}

export function parseViewer(raw: string | Buffer): ViewerMsg | null {
  const m = decode(raw);
  switch (m?.type) {
    case "start":
    case "restart":
    case "resume":
      return { type: m.type };
    case "key":
      if (isPlayer(m.player) && (m.dir === -1 || m.dir === 0 || m.dir === 1)) return m;
      return null;
    case "calibrate":
      return isPlayer(m.player) ? m : null;
    case "ping":
      return Number.isFinite(m.id) ? m : null;
    default:
      return null;
  }
}
