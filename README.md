# Pong distribuído com ESP32

Dois ESP32 com acelerômetro MMA8452 controlam as raquetes de um Pong.
O servidor (Bun/TypeScript) guarda o estado da partida e roda a física.
O navegador só desenha o estado que recebe.

```
ESP32 #1 ──ws /ws/player1──┐
                           ├─> servidor (estado + motor do jogo, 60 Hz) ──ws /viewer──> navegador
ESP32 #2 ──ws /ws/player2──┘
```

## Estrutura

```
esp32/                firmware (PlatformIO; o mesmo para as duas placas)
  platformio.ini
  src/main.cpp        TaskSensor (núcleo 1) + TaskNetwork (núcleo 0) + fila
server/
  main.ts             Bun.serve: WebSockets, laço do jogo, timeouts, estatísticas
  game.ts             estado autoritativo e física (bola, colisões, placar)
  protocol.ts         tipos e validação das mensagens
web/                  interface (React + canvas), só representação
  index.html, main.jsx, App.jsx, useGame.js, useRenderer.js
documentation/
  relatorio.md        relatório técnico
```

## Componentes (por jogador)

- 1 ESP32 DevKit (ESP32-WROOM-32)
- 1 módulo MMA8452Q (breakout I²C)
- 1 protoboard e 4 jumpers
- cabo USB ou power bank (alimentação 5 V pelo USB do ESP32)

## Montagem

| MMA8452 | ESP32  |
|---------|--------|
| VCC/3V3 | 3V3    |
| GND     | GND    |
| SDA     | GPIO21 |
| SCL     | GPIO22 |

O firmware usa o endereço I²C `0x1D` (SA0 em nível alto, padrão da maioria dos módulos).
Se o pino SA0 estiver no GND, troque `MMA_ADDR` para `0x1C`.

O eixo usado é o **Y** (`AXIS` em `esp32/src/main.cpp`): inclinar a protoboard para
frente e para trás move a raquete. Se o módulo estiver montado em outra orientação,
troque `AXIS`.

## Bibliotecas

- Firmware: framework Arduino para ESP32 e [links2004/WebSockets](https://github.com/Links2004/arduinoWebSockets).
  FreeRTOS, `Wire` e `WiFi` já vêm no core do ESP32.
- Servidor: [Bun](https://bun.sh) ≥ 1.2 (sem dependências de runtime além do próprio Bun).
- Web: React 19, empacotado pelo próprio Bun (sem Vite).

## Configuração do ESP32

Em `esp32/src/main.cpp`:

| Constante | O que é |
|---|---|
| `PLAYER` | `1` para a placa da raquete esquerda, `2` para a da direita |
| `WIFI_SSID` / `WIFI_PASS` | rede Wi-Fi. Preencha só localmente e **não versione** |
| `WS_HOST` / `WS_PORT` | IP e porta do servidor (padrão `6767`) |
| `SAMPLE_PERIOD_MS` | período de aquisição (10 ms = 100 Hz) |
| `SEND_PERIOD_MS` | período de envio (20 ms = 50 Hz) |
| `FILTER_ALPHA`, `DEADZONE_G`, `FULL_TILT_G` | filtro, zona morta e sensibilidade |

### Compilar e gravar

Com PlatformIO (VS Code ou CLI):

```bash
cd esp32
pio run -t upload        # grava
pio device monitor       # Serial a 115200
```

Com Arduino IDE:
1. Crie a pasta `controlador/` e copie `esp32/src/main.cpp` como `controlador/controlador.ino`.
2. Instale o core "esp32" (Espressif) e a biblioteca "WebSockets" (Markus Sattler).
3. Escolha a placa "ESP32 Dev Module" e grave.

Grave uma placa com `PLAYER 1` e outra com `PLAYER 2`.

Ao ligar, a placa precisa ficar **parada por cerca de 0,5 s** para calibrar a posição de repouso.
Depois é possível recalibrar pelo botão "Calibrar repouso" na interface.

## Servidor

```bash
bun install
bun run dev      # com hot reload
bun run start    # sem hot reload
```

A porta padrão é `6767`; para mudar, use `PORT=8080 bun run start`.

### Configuração de rede

- **Rede local:** o PC e os ESP32 na mesma rede. `WS_HOST` recebe o IP do PC (`ipconfig` / `ip a`).
  Libere a porta 6767 no firewall do PC.
- **AWS (EC2):** instale o Bun na instância, rode `bun run start` e libere a porta TCP 6767
  no Security Group. Use o IP público em `WS_HOST`. Para manter o servidor rodando
  depois de sair do SSH, use `nohup bun run start &`, `tmux` ou um serviço `systemd`.

## Interface web

Abra `http://<ip-do-servidor>:6767/game`. O endereço `/` redireciona para essa página.

- **Iniciar / Continuar / Jogar novamente** enviam comandos ao servidor, que é quem decide.
- Raquete sem ESP32 conectado pode ser movida pelo teclado (J1: W/S; J2: ↑/↓).
  Isso serve para testar sem hardware. O servidor ignora o teclado quando há ESP32 naquele lado.
- Os painéis mostram, por jogador:
  - leituras/s, envios/s e descartadas/s, informadas pelo ESP32;
  - mensagens recebidas/s, medidas no servidor;
  - RTT entre ESP32 e servidor, idade da última amostra, mensagens perdidas e reconexões.
- O rodapé mostra os ticks/s do servidor, os estados recebidos/s e o RTT entre navegador e servidor.

## Protocolo

Todas as mensagens são JSON em quadros de texto WebSocket. O servidor valida cada
mensagem (`server/protocol.ts`) e descarta as inválidas.

### ESP32 → servidor (`/ws/player1` ou `/ws/player2`)

| Mensagem | Quando | Exemplo |
|---|---|---|
| `hello` | ao conectar | `{"type":"hello","player":1,"device":"esp32-a1b2c3","sampleHz":100,"sendHz":50}` |
| `input` | a cada 20 ms | `{"type":"input","seq":1502,"sample":3004,"t":2738192,"pos":-0.730}` |
| `stats` | a cada 1 s | `{"type":"stats","reads":100,"sent":50,"dropped":50,"i2cErrors":0,"reconnects":1,"rtt":12}` |
| `ping` | a cada 1 s | `{"type":"ping","id":42}` |

- O jogador é identificado pelo **endpoint**, e o `hello.player` precisa coincidir com ele.
  Se não coincidir, o servidor fecha a conexão com o código 1008.
  A conexão só controla a raquete depois de um `hello` válido.
  Um novo `hello` no mesmo endpoint substitui a conexão anterior, o que cobre a reconexão
  depois de uma queda de Wi-Fi.
- `pos`: posição normalizada de -1 a 1 (positivo = raquete para cima), já filtrada e calibrada no ESP32.
- `seq`: número da mensagem enviada. Uma lacuna indica mensagem perdida, e um `seq` repetido ou antigo é descartado.
- `sample`: número da amostra do sensor. A diferença entre valores consecutivos mostra quantas amostras
  foram lidas e não transmitidas.
- `t`: `millis()` do ESP32 no momento da leitura.
- `stats`: contagens no último segundo. `rtt` é medido com `ping`/`pong` (-1 enquanto desconhecido).

### Servidor → ESP32

- `{"type":"pong","id":42}`: resposta ao `ping`.
- `{"type":"calibrate"}`: pede nova calibração do repouso.

### Navegador → servidor (`/viewer`)

`{"type":"start"}`, `{"type":"restart"}`, `{"type":"resume"}`,
`{"type":"key","player":1,"dir":-1|0|1}`, `{"type":"calibrate","player":2}`,
`{"type":"ping","id":7}`

### Servidor → navegador

- `welcome`, ao conectar: `{"type":"welcome","arena":{"width":800,"height":500,...},"winScore":7,"tickHz":60}`
- `state`, a cada tick (60 Hz):
  ```json
  {"type":"state","tick":1234,"phase":"playing","winner":null,"pausedFor":null,
   "score":{"1":3,"2":2},"ball":{"x":488.2,"y":220.0},
   "paddles":{"1":{"y":210.4,"control":"esp32"},"2":{"y":96.0,"control":"esp32"}}}
  ```
  `phase` pode ser `waiting`, `playing`, `paused` ou `over`.
- `stats`, a cada 1 s: estatísticas de conexão por jogador (veja o painel da interface).
- `pong`: resposta ao `ping` do navegador.

## Execução completa

1. Inicie o servidor (`bun run start`) e anote o IP da máquina.
2. Configure `WS_HOST`, Wi-Fi e `PLAYER` e grave as duas placas.
3. Ligue as placas paradas sobre a mesa (calibração) e confira no Serial:
   - `[WS] conectado`;
   - linhas `[stats] leituras/s=100 envios/s=50 ...`.
4. Abra `http://<ip>:6767/game`. Os painéis devem mostrar "ESP32 conectado" nos dois jogadores.
5. Clique em **Iniciar**. Inclinar a protoboard move a raquete.

O servidor também imprime as estatísticas de cada placa a cada segundo, o que ajuda nos experimentos.

## Comportamento em falhas

- **ESP32 perde a rede:** a TaskSensor continua lendo a 100 Hz (veja `leituras/s` no Serial).
  A TaskNetwork tenta reconectar a cada 2 s.
  O servidor marca "sem dados" após 500 ms e encerra o socket após 3 s de silêncio.
  A partida **pausa** e volta sozinha quando a placa reconecta.
- **Navegador fecha:** nada muda no servidor. Ao reabrir, a página recebe `welcome` e o
  `state` atual, e a partida continua de onde está.
