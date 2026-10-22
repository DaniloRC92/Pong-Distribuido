# CLAUDE.md

Pong em que as raquetes são controladas pela inclinação de ESP32s com acelerômetro.
Textos, comentários e mensagens de UI em português (pt-BR).

## Comandos

- `bun install` — dependências
- `bun run dev` — servidor com hot reload (`bun --hot main.ts`)
- `bun run start` — servidor sem hot reload
- `bun build ./page.html --outdir <tmp>` — checa se o frontend compila (não há testes)

## Arquitetura

Fluxo: `ESP32 --ws /--> main.ts --ws /viewer (pub/sub)--> navegador (React)`

- `controlador.cpp` — firmware Arduino do ESP32 + MMA8452 (I²C, ±2g, envia a cada 50 ms).
  `WS_HOST`/`WS_PORT` precisam apontar para o PC e para a porta do `main.ts`.
  `WIFI_SSID`/`WIFI_PASS` ficam como placeholder no código — preencha só localmente
  antes de gravar e nunca versione credenciais reais.
- `main.ts` — servidor `Bun.serve` na porta **6767**:
  - `/` — upgrade WebSocket do ESP32 (`role: "device"`); navegador comum é redirecionado para `/game`.
  - `/viewer` — WebSocket das páginas (`role: "viewer"`), inscritas no tópico `viewers`.
  - `/game` — `page.html` como HTML import; o Bun empacota `frontend/` (JSX + CSS) sozinho, sem Vite.
- `page.html` — só o shell (`#root` + `frontend/main.jsx`).
- `frontend/`
  - `useDevices.js` — conecta em `/viewer` (reconecta a cada 2 s), guarda a última amostra
    por dispositivo e distribui slots: 1º ESP32 = `left` (J1), 2º = `right` (J2).
    `getTilt(side)` devolve -1..1 ou `null` se o lado não tem placa.
    Calibração: `AXIS` (eixo usado, hoje `y`) e `FULL_TILT` (g para ir de ponta a ponta).
  - `usePong.js` — loop do jogo em canvas (`requestAnimationFrame`). Raquete com ESP32 segue
    a inclinação (suavizada por `TILT_SMOOTHING`); sem ESP32 usa teclado (W/S, ↑/↓).
    Após um ponto só raquetes de teclado voltam ao centro — não resetar as do ESP32.
  - `App.jsx` — placar, overlays (início/vitória), status da conexão e quem controla cada lado.

## Protocolo

ESP32 → servidor (JSON texto):
- `{"type":"hello","device":"esp32-01","scale":2}`
- `{"type":"accel","device":"esp32-01","t":<ms>,"x":<g>,"y":<g>,"z":<g>}`

Servidor → viewers:
- `{"type":"snapshot","users":{<id>:{x,y,z,t,receivedAt}}}` ao conectar
- `{"type":"pos","device":<id>,x,y,z,t,receivedAt}` a cada amostra
- `{"type":"leave","device":<id>}` quando o ESP32 desconecta

`main.ts` valida as mensagens em `parse()` antes de usar; mantenha isso ao adicionar tipos.

## Convenções

- Frontend em JSX puro (sem TypeScript); servidor em TypeScript estrito.
- Não use `innerHTML` com dados do dispositivo — `device` vem da rede.
