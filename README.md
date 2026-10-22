# paralela

Pong controlado por acelerômetro: cada ESP32 com um MMA8452 envia a inclinação
por WebSocket para um servidor Bun, que repassa para a página do jogo.

## Rodar

```bash
bun install
bun run dev
```

- Jogo: http://localhost:6767/game
- ESP32: `ws://<ip-do-pc>:6767/` (configure `WS_HOST`/`WS_PORT` em `controlador.cpp`)

O primeiro ESP32 conectado controla o Jogador 1 e o segundo, o Jogador 2.
Sem placa, o jogador usa o teclado (W/S e ↑/↓).
