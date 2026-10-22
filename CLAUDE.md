# CLAUDE.md

Pong em que as raquetes são controladas pela inclinação de ESP32s com acelerômetro.
Textos, comentários e mensagens de UI em português (pt-BR).

## Comandos

- `bun install` — dependências
- `bun run dev` — servidor com hot reload (`bun --hot main.ts`)
- `bun run start` — servidor sem hot reload
- `bun build ./page.html --outdir <tmp>` — checa se o frontend compila (não há testes)

## Arquitetura

Fluxo: `ESP32 --ws /--> main.ts (motor do jogo, 60 Hz) --ws /viewer (pub/sub)--> navegador (React)`

O servidor é a autoridade da partida; o navegador só desenha o estado recebido e envia teclas.

- `controlador.cpp` — firmware Arduino do ESP32 + MMA8452 (I²C, ±2g, envia a cada 50 ms).
  `WS_HOST`/`WS_PORT` precisam apontar para o PC e para a porta do `main.ts`.
  `WIFI_SSID`/`WIFI_PASS` ficam como placeholder no código — preencha só localmente
  antes de gravar e nunca versione credenciais reais.
- `main.ts` — servidor `Bun.serve` na porta **6767** e motor do jogo:
  - laço de passo fixo a 60 Hz (`step()`): raquetes, bola, colisões, placar; publica `state` a cada tick.
  - 1º ESP32 = `left` (J1), 2º = `right` (J2). Calibração: `AXIS` (hoje `y`), `FULL_TILT`, `TILT_SMOOTHING`.
  - Raquete sem ESP32 usa teclado (mensagens `key` dos navegadores); lado com ESP32 ignora o teclado.
  - Após um ponto só raquetes de teclado voltam ao centro — não resetar as do ESP32.
  - Partida sempre rodando (sem botão de iniciar): em `WIN_SCORE` mostra o vencedor 3 s e recomeça.
  - `/` — upgrade WebSocket do ESP32 (`role: "device"`); navegador comum é redirecionado para `/game`.
  - `/viewer` — WebSocket das páginas (`role: "viewer"`), inscritas no tópico `viewers`.
  - `/game` — `page.html` como HTML import; o Bun empacota `frontend/` (JSX + CSS) sozinho, sem Vite.
- `page.html` — só o shell (`#root` + `frontend/main.jsx`).
- `frontend/` — tema claro, responsivo (o canvas 800x500 escala pela largura da tela)
  - `useGame.js` — conecta em `/viewer` (reconecta a cada 2 s), guarda o último `state` num ref
    e só re-renderiza o React quando placar/vencedor/controles mudam. `useKeyboard` envia teclas.
  - `usePong.js` — desenha o estado no canvas a cada `requestAnimationFrame`. Sem física.
  - `App.jsx` — placar, overlays (vencedor/sem servidor), status da conexão e quem controla cada lado.

## Protocolo

ESP32 → servidor (JSON texto):
- `{"type":"hello","device":"esp32-01","scale":2}`
- `{"type":"accel","device":"esp32-01","t":<ms>,"x":<g>,"y":<g>,"z":<g>}`

Servidor → viewers:
- `{"type":"config","arena":{width,height,paddleW,paddleH,paddleMargin,ball},"winScore":7}` ao conectar
- `{"type":"state","left":{y,device},"right":{y,device},"ball":{x,y},"score":{left,right},"winner"}`
  a cada tick (60 Hz); `device` é `null` no lado sem ESP32, `winner` é `null` ou o lado vencedor

Viewers → servidor:
- `{"type":"key","side":"left"|"right","dir":-1|0|1}`

`main.ts` valida as mensagens em `parse()`/`parseViewer()` antes de usar; mantenha isso ao adicionar tipos.

## Convenções

- Frontend em JSX puro (sem TypeScript); servidor em TypeScript estrito.
- O navegador nunca é autoridade: nada de física ou placar no frontend.
- Não use `innerHTML` com dados do dispositivo — `device` vem da rede.
