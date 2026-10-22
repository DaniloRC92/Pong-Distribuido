# CLAUDE.md

Pong distribuído (trabalho de Processamento Paralelo): as raquetes são controladas pela
inclinação de ESP32s com acelerômetro, o servidor é a autoridade do jogo e o navegador só desenha.
Textos, comentários e mensagens de UI em português (pt-BR).

## Comandos

- `bun install` — dependências
- `bun run dev` — servidor com hot reload (`bun --hot server/main.ts`)
- `bun run start` — servidor sem hot reload (`PORT=...` muda a porta)
- `bunx tsc --noEmit -p .` — checagem de tipos
- `bun build ./web/index.html --outdir <tmp>` — checa se o frontend compila (não há testes)
- Firmware: `cd esp32 && pio run -t upload` (PlatformIO)

## Arquitetura

Fluxo: `ESP32 --ws /ws/playerN--> server --ws /viewer (pub/sub, 60 Hz)--> navegador`

- `esp32/src/main.cpp` — firmware (mesmo para as duas placas; `PLAYER` = 1 ou 2).
  - `TaskSensor` (núcleo 1): MMA8452 a 100 Hz, EMA + calibração de repouso + zona morta → `pos` -1..1.
  - `TaskNetwork` (núcleo 0): Wi-Fi, WebSocket, envio a 50 Hz, ping/stats a 1 s, reconexão.
  - Comunicação: fila de 1 posição (`xQueueOverwrite`) — o produtor nunca bloqueia.
    Contadores em `std::atomic`, Serial com mutex (`logLine`), recalibração por notificação de tarefa.
  - A aquisição não pode depender da rede: nada na TaskSensor pode esperar a TaskNetwork.
  - `WIFI_SSID`/`WIFI_PASS` ficam como placeholder — preencha só localmente, nunca versione credenciais.
- `server/main.ts` — `Bun.serve` na porta **6767**: conexões, laço de 60 Hz, timeouts, estatísticas.
  - `/ws/player1`, `/ws/player2` — ESP32. A conexão só assume a raquete após `hello` válido
    (com `player` igual ao do endpoint); um novo `hello` substitui a conexão anterior.
  - `/viewer` — navegadores (tópico `viewers`); recebem `welcome` + `state` + `stats` ao conectar.
  - `/game` — `web/index.html` como HTML import (Bun empacota JSX + CSS sozinho). `/` redireciona.
- `server/game.ts` — classe `Game`: estado autoritativo e física. Só `step()` altera posições,
  bola e placar; handlers de rede apenas gravam entradas (alvo, tecla) e comandos de fase.
  Após um ponto só raquetes de teclado voltam ao centro — não resetar as do ESP32.
- `server/protocol.ts` — tipos e validação (`parseDevice`, `parseViewer`); valide todo tipo novo aqui.
- `web/`
  - `useGame.js` — conecta em `/viewer` (reconecta a cada 2 s), guarda o último `state` num ref
    e só re-renderiza React quando fase/placar/controle mudam. `useKeyboard` envia teclas ao servidor.
  - `useRenderer.js` — desenha o estado no canvas a cada `requestAnimationFrame`. Sem física.
  - `App.jsx` — placar, overlays por fase, painéis de diagnóstico por jogador.
- `documentation/relatorio.md` — relatório técnico (valores marcados **[medir]** vêm dos experimentos).

O protocolo completo está no `README.md` — mantenha-o atualizado ao mudar mensagens.

## Convenções

- Frontend em JSX puro (sem TypeScript); servidor em TypeScript estrito.
- O navegador nunca é autoridade: nada de física ou placar no frontend.
- Não use `innerHTML` com dados do dispositivo — `device` vem da rede.
