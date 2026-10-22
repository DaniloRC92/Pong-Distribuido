# paralela

Pong controlado por acelerômetro: cada ESP32 com um MMA8452 envia a inclinação
por WebSocket para um servidor Bun. O servidor roda a partida (bola, colisões, placar)
e envia o estado para todas as páginas abertas, que só desenham — todas mostram a mesma partida.

## Rodar

```bash
bun install
bun run dev
```

- Jogo: http://localhost:6767/game
- ESP32: `ws://<ip-do-pc>:6767/` (configure `WS_HOST`/`WS_PORT` em `controlador.cpp`)

O primeiro ESP32 conectado controla o Jogador 1 e o segundo, o Jogador 2.
Sem placa, o jogador usa o teclado (W/S e ↑/↓).
A partida está sempre rodando: ao chegar a 7 pontos, o vencedor aparece por 3 s e outra começa.
