# Pong Distribuído com ESP32 e Processamento Paralelo

Sistema interativo paralelo e distribuído em que dois ESP32, cada um com um acelerômetro
MMA8452, funcionam como controles de um jogo de Pong. A inclinação física de cada protoboard
é convertida em posição de raquete, transmitida por WebSocket a um servidor que mantém o
estado autoritativo da partida e difunde esse estado para navegadores que apenas o desenham.

```
JOGADOR 1                         JOGADOR 2
   |                                 |
ESP32 #1                          ESP32 #2
  Core 0: aquisição MMA8452         Core 0: aquisição MMA8452
      |  fila (mailbox)                 |  fila (mailbox)
  Core 1: comunicação               Core 1: comunicação
      |                                 |
      +------ WebSocket ws:// ----------+
                      |
                  SERVIDOR (Bun, porta 6767)
                  recepção · estado da partida
                  motor do jogo · física e colisões · pontuação
                      |
                   WebSocket /viewer
                      |
                  NAVEGADOR (React + Canvas)
                  interface gráfica · somente desenho
```

---

## 1. Componentes necessários

### Hardware (por jogador — o sistema exige dois conjuntos)

| Qtd | Componente | Observações |
|-----|------------|-------------|
| 1 | ESP32 DevKit (ESP32-WROOM-32) | Dual-core Xtensa LX6 a 240 MHz, Wi-Fi 2.4 GHz integrado |
| 1 | Acelerômetro MMA8452Q | Breakout I²C, 3 eixos, 12 bits, alimentação 3,3 V |
| 1 | Protoboard | O conjunto inteiro é movimentado pelo jogador |
| 4 | Jumpers macho-macho | VCC, GND, SDA, SCL |
| 1 | Cabo USB (micro-USB ou USB-C) | Gravação e alimentação |

### Software

| Item | Versão de referência |
|------|----------------------|
| Arduino IDE ou PlatformIO | Arduino IDE 2.x |
| Core `esp32` (Espressif Systems) | 3.x |
| [Bun](https://bun.sh) | 1.1 ou superior |
| Navegador com suporte a Canvas e WebSocket | Chrome, Edge ou Firefox atuais |

> **Importante:** o MMA8452 opera em **3,3 V**. Alimentá-lo pelo pino de 5 V do ESP32 danifica o
> sensor de forma permanente.

---

## 2. Esquema de montagem

O MMA8452 é ligado ao ESP32 pelo barramento I²C, nos pinos padrão do core ESP32 para Arduino.

| MMA8452 | ESP32 | Função |
|---------|-------|--------|
| `VCC` / `3V3` | `3V3` | Alimentação 3,3 V |
| `GND` | `GND` | Referência comum |
| `SDA` | `GPIO21` | Dados I²C |
| `SCL` | `GPIO22` | Clock I²C |

```
        ESP32 DevKit                     MMA8452Q
      +--------------+               +--------------+
      |          3V3 |---------------| VCC          |
      |          GND |---------------| GND          |
      |       GPIO21 |---------------| SDA          |
      |       GPIO22 |---------------| SCL          |
      |              |               | SA0 -> VCC   |  (endereço 0x1D)
      +--------------+               +--------------+
```

**Endereço I²C.** O firmware usa `0x1D`, que corresponde ao pino `SA0` em nível alto — a
configuração padrão da maioria dos breakouts. Se a placa mantiver `SA0` em GND, altere
`MMA_ADDR` para `0x1C` em `controlador.cpp`.

A maioria dos breakouts já traz os resistores de pull-up de SDA e SCL; não é necessário
acrescentá-los. O ESP32 e o sensor devem ficar firmemente presos à mesma protoboard, porque é a
protoboard inteira que o jogador inclina.

**Orientação física.** O eixo usado para mover a raquete é o **Y** (constante `AXIS` em
`main.ts`). Monte a protoboard de modo que inclinar para cima e para baixo altere o eixo Y do
sensor. Trocar o eixo exige apenas mudar `AXIS` no servidor — nenhuma alteração de firmware.

---

## 3. Bibliotecas utilizadas

### Firmware (ESP32)

| Biblioteca | Origem | Uso |
|------------|--------|-----|
| `Arduino.h` | Core ESP32 | Base do ambiente Arduino |
| `WiFi.h` | Core ESP32 | Conexão à rede sem fio em modo estação |
| `Wire.h` | Core ESP32 | Barramento I²C de leitura do MMA8452 |
| `WebSocketsClient.h` | [links2004/arduinoWebSockets](https://github.com/Links2004/arduinoWebSockets) | Cliente WebSocket sobre TCP |
| FreeRTOS | Embutido no core ESP32 | Tarefas, afinidade de núcleo e fila entre tarefas |

O MMA8452 é acessado por registradores diretamente, sem biblioteca de terceiros — apenas
`Wire`. Isso mantém o controle explícito sobre a taxa de amostragem e a escala do sensor.

**Instalação da biblioteca WebSockets** — Arduino IDE: `Ferramentas → Gerenciar Bibliotecas`,
buscar por `WebSockets` e instalar a de *Markus Sattler*. PlatformIO: acrescentar ao
`platformio.ini`:

```ini
lib_deps = links2004/WebSockets@^2.4.1
```

### Servidor e interface Web

| Pacote | Versão | Uso |
|--------|--------|-----|
| `bun` | 1.1+ | Runtime, servidor HTTP/WebSocket e empacotador do frontend |
| `react` / `react-dom` | 19.x | Interface da página |
| `typescript` | 7.x | Tipagem estrita do servidor |
| `@types/bun`, `@types/react`, `@types/react-dom` | — | Tipos de desenvolvimento |

Não há Vite, Webpack nem qualquer outro empacotador: o próprio Bun processa o import de
`page.html` e monta o bundle de `frontend/`.

---

## 4. Instruções de compilação

### 4.1. Firmware do ESP32

1. Instale o core **esp32** da Espressif Systems no gerenciador de placas.
2. Instale a biblioteca **WebSockets** (seção 3).
3. Abra `controlador.cpp` como sketch do Arduino (o arquivo precisa estar numa pasta de mesmo
   nome, ou pode ser renomeado para `.ino`).
4. Selecione a placa `ESP32 Dev Module` e a porta serial correspondente.
5. Preencha as constantes de configuração (seção 5).
6. Compile e grave.
7. Abra o monitor serial a **115200 baud** para acompanhar a inicialização.

Pelo PlatformIO, o equivalente é:

```bash
pio run --target upload
pio device monitor --baud 115200
```

### 4.2. Servidor e interface Web

```bash
bun install
```

Não existe etapa de build separada para o frontend: o Bun empacota `frontend/` sob demanda
quando a rota `/game` é servida. Para verificar que o frontend compila sem subir o servidor:

```bash
bun build ./page.html --outdir /tmp/pong-build
```

---

## 5. Configuração de rede

Os três elementos do sistema — os dois ESP32, o servidor e o navegador — precisam alcançar-se
pela rede. A configuração mínima é uma rede Wi-Fi **2,4 GHz** compartilhada: o rádio do ESP32
não opera em 5 GHz.

### 5.1. Descobrir o endereço do servidor

Na máquina que executará o servidor:

```bash
ipconfig
```

```bash
ip addr show
```

Anote o endereço IPv4 da interface conectada à mesma rede dos ESP32 (por exemplo
`10.227.166.98`). É esse endereço que vai em `WS_HOST`.

### 5.2. Requisitos da rede

- **Porta 6767/TCP liberada** no firewall da máquina do servidor para conexões de entrada.
  No Windows, a primeira execução costuma abrir o diálogo do Firewall do Windows Defender —
  autorize em redes privadas.
- **Isolamento de clientes desativado** no roteador ou no ponto de acesso. Redes de visitantes
  e muitas redes institucionais bloqueiam tráfego entre dispositivos; nesses casos, use um
  roteador próprio ou um ponto de acesso gerado por celular.
- **Sem proxy nem captive portal** entre os ESP32 e o servidor.

### 5.3. Servidor em nuvem (opcional)

Para executar o servidor numa instância AWS em vez da máquina local:

1. Libere a porta `6767/TCP` no *security group* da instância.
2. Aponte `WS_HOST` para o IP público ou o DNS da instância.
3. Mantenha `WS_PORT = 6767`.

A interface passa a ser acessada em `http://<ip-publico>:6767/game`. Se o servidor ficar atrás
de um proxy HTTPS, o frontend detecta o protocolo e troca `ws://` por `wss://` sozinho
(`frontend/useGame.js`); o firmware, porém, usa `ws://` sem TLS e precisaria de uma porta
direta ou de um túnel.

---

## 6. Configuração dos ESP32

Os dois dispositivos usam **o mesmo firmware**, parametrizado pelo identificador do jogador.
Todas as constantes ficam no topo de `controlador.cpp`:

```cpp
const char*    WIFI_SSID        = "SEU_WIFI";      // preencha antes de gravar
const char*    WIFI_PASS        = "SUA_SENHA";
const char*    WS_HOST          = "10.227.166.98"; // IP do servidor
const uint16_t WS_PORT          = 6767;            // mesma porta do main.ts
const char*    DEVICE_ID        = "esp32-01";      // "esp32-02" na segunda placa
const uint32_t SEND_INTERVAL_MS = 50;              // 20 envios/s
const uint8_t  MMA_ADDR         = 0x1D;            // 0x1C se SA0 estiver em GND
```

| Constante | Placa 1 | Placa 2 |
|-----------|---------|---------|
| `WIFI_SSID` / `WIFI_PASS` | credenciais da rede | idênticas |
| `WS_HOST` / `WS_PORT` | IP do servidor / `6767` | idênticos |
| `DEVICE_ID` | `"esp32-01"` | **`"esp32-02"`** |
| `MMA_ADDR` | `0x1D` (ou `0x1C`) | idem |

> **A única diferença obrigatória entre as duas gravações é `DEVICE_ID`.** Dois dispositivos com
> o mesmo identificador seriam tratados pelo servidor como um único jogador: o segundo
> sobrescreveria as amostras do primeiro e nenhuma raquete receberia o slot da direita.

### 6.1. Atribuição das raquetes

O servidor não exige endpoints distintos por jogador. A atribuição é feita por ordem de
chegada, em `main.ts`:

- o **primeiro** `DEVICE_ID` do qual chega uma mensagem `accel` ocupa o slot `left` → **Jogador 1**, raquete esquerda;
- o **segundo** ocupa o slot `right` → **Jogador 2**, raquete direita.

Para inverter os lados, ligue as placas na ordem oposta ou reinicie o servidor. Quando um
dispositivo se desconecta, seu slot é liberado e fica disponível para a próxima placa que
enviar dados.

### 6.2. Calibração do movimento

Três constantes em `main.ts` ajustam a resposta da raquete à inclinação — nenhuma delas exige
regravar o firmware:

| Constante | Valor | Efeito |
|-----------|-------|--------|
| `AXIS` | `"y"` | Eixo do acelerômetro que move a raquete |
| `FULL_TILT` | `0.6` | Inclinação, em g, que leva a raquete de uma ponta à outra (≈ 37°). Valor menor deixa o controle mais sensível |
| `TILT_SMOOTHING` | `0.3` | Fração do caminho até o alvo percorrida por tick. Valor menor suaviza mais e atrasa mais a resposta |

Inclinação positiva move a raquete para cima. O sensor opera em escala **±2 g** com saída de
12 bits (1024 contagens por g) e taxa interna de amostragem de **100 Hz**.

### 6.3. Verificação

Com o monitor serial aberto a 115200 baud, a sequência esperada na inicialização é:

```
[WiFi] Conectando....
[WiFi] IP: 192.168.0.42
[WS] Conectado
```

Se aparecer `[MMA] Sensor nao encontrado` em repetição, revise a ligação I²C e o valor de
`MMA_ADDR`. Se a conexão Wi-Fi não completar, revise SSID, senha e a banda da rede.

---

## 7. Inicialização do servidor

```bash
bun install
bun run dev
```

Saída esperada:

```
Página:  http://localhost:6767/game
ESP32:   ws://<ip-do-pc>:6767/
```

| Comando | Uso |
|---------|-----|
| `bun run dev` | `bun --hot main.ts` — recarrega o servidor a cada alteração; recomendado em desenvolvimento |
| `bun run start` | `bun main.ts` — execução sem hot reload; recomendado na demonstração |

A partida começa junto com o servidor e **nunca para**: ao atingir 7 pontos, o vencedor é
exibido por 3 segundos e uma nova partida se inicia automaticamente. Não há botão de iniciar.

### 7.1. Rotas expostas

| Rota | Protocolo | Finalidade |
|------|-----------|------------|
| `/` | WebSocket | Conexão dos ESP32 (`role: "device"`). Acesso por navegador comum é redirecionado para `/game` |
| `/viewer` | WebSocket | Conexão das páginas (`role: "viewer"`), inscritas no tópico `viewers` |
| `/game` | HTTP | Serve `page.html` com o bundle de `frontend/` |

---

## 8. Acesso à interface Web

Abra no navegador:

```
http://localhost:6767/game
```

De outra máquina na mesma rede, troque `localhost` pelo IP do servidor:
`http://10.227.166.98:6767/game`.

A interface apresenta a arena, as duas raquetes, a bola, o placar, o status da conexão e a
indicação de quem controla cada lado (`ESP32 esp32-01` ou as teclas correspondentes).

**Quantas abas quiser podem ser abertas ao mesmo tempo** — todas mostram exatamente a mesma
partida, porque nenhuma delas simula nada: todas desenham o estado recebido do servidor.

### 8.1. Controle por teclado

Um lado **sem ESP32 associado** pode ser controlado pelo teclado de qualquer navegador aberto:

| Jogador | Teclas |
|---------|--------|
| Jogador 1 (esquerda) | `W` / `S` |
| Jogador 2 (direita) | `↑` / `↓` |

Assim que um ESP32 ocupa um slot, o servidor passa a **ignorar** as teclas daquele lado — a
decisão é do servidor, não do navegador. Isso permite testar o sistema inteiro sem hardware e
demonstrar a convivência entre as duas fontes de comando.

---

## 9. Protocolo de mensagens

Todas as mensagens são **JSON em texto** sobre WebSocket. O campo `type` identifica o formato.
O servidor valida toda mensagem recebida antes de usar seus campos (`parse()` e `parseViewer()`
em `main.ts`); mensagens malformadas são descartadas e registradas, sem derrubar a conexão.

### 9.1. ESP32 → servidor

Enviada uma vez, na abertura da conexão:

```json
{ "type": "hello", "device": "esp32-01", "scale": 2 }
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `device` | string não vazia | Identificador do dispositivo |
| `scale` | número | Fundo de escala do acelerômetro, em g |

Enviada periodicamente, a cada 50 ms (20 Hz):

```json
{ "type": "accel", "device": "esp32-01", "t": 128450, "x": -0.0137, "y": 0.4219, "z": 0.9043 }
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `device` | string não vazia | Identificador do dispositivo |
| `t` | número finito | `millis()` do ESP32, em ms desde o boot — serve de marca temporal para medir atraso e detectar amostras obsoletas |
| `x`, `y`, `z` | números finitos | Aceleração de cada eixo, em g |

Os três eixos são transmitidos em bruto, sem interpretação local. A conversão de aceleração
em posição de raquete é feita integralmente no servidor, o que permite recalibrar sensibilidade,
eixo e suavização sem regravar nenhum firmware.

### 9.2. Servidor → navegador

Enviada uma única vez, logo após a conexão em `/viewer`:

```json
{
  "type": "config",
  "arena": { "width": 800, "height": 500, "paddleW": 12, "paddleH": 80, "paddleMargin": 16, "ball": 12 },
  "winScore": 7
}
```

Enviada a cada tick do motor do jogo (60 Hz):

```json
{
  "type": "state",
  "left":  { "y": 184.3, "device": "esp32-01" },
  "right": { "y": 210.0, "device": null },
  "ball":  { "x": 412.7, "y": 268.1 },
  "score": { "left": 3, "right": 2 },
  "winner": null
}
```

| Campo | Descrição |
|-------|-----------|
| `left.y` / `right.y` | Coordenada vertical do topo da raquete, em pixels da arena (0 a 420) |
| `left.device` / `right.device` | `DEVICE_ID` que controla o lado, ou `null` se o lado estiver no teclado |
| `ball.x` / `ball.y` | Centro da bola, em pixels da arena |
| `score` | Pontuação de cada lado |
| `winner` | `"left"`, `"right"` ou `null` durante a partida |

As posições são arredondadas a uma casa decimal antes do envio: a precisão adicional não é
percebida na tela e o arredondamento reduz o tamanho da mensagem. A velocidade da bola é
mantida apenas no servidor — o navegador não precisa dela, porque não simula nada.

### 9.3. Navegador → servidor

```json
{ "type": "key", "side": "left", "dir": -1 }
```

| Campo | Valores | Descrição |
|-------|---------|-----------|
| `side` | `"left"` \| `"right"` | Lado a mover |
| `dir` | `-1` \| `0` \| `1` | Cima, parado, baixo |

Enviada apenas na **transição** de estado das teclas, não a cada quadro. O servidor descarta a
mensagem se o lado indicado já estiver ocupado por um ESP32.

---

## 10. Execução completa da aplicação

Roteiro do início ao fim, na ordem.

### Passo 1 — Rede

Ligue os dois ESP32, o servidor e o navegador à mesma rede Wi-Fi de 2,4 GHz. Confirme o IP do
servidor com `ipconfig` / `ip addr` e libere a porta `6767/TCP` no firewall.

### Passo 2 — Montagem

Monte os dois conjuntos conforme a seção 2. Cada conjunto deve ficar rígido na protoboard: é a
protoboard inteira que o jogador inclina.

### Passo 3 — Firmware

Preencha `WIFI_SSID`, `WIFI_PASS` e `WS_HOST` em `controlador.cpp`. Grave a primeira placa com
`DEVICE_ID = "esp32-01"` e a segunda com `DEVICE_ID = "esp32-02"`. Confirme no monitor serial
que cada uma imprime `[WiFi] IP: ...` seguido de `[WS] Conectado`.

### Passo 4 — Servidor

```bash
bun install
bun run start
```

### Passo 5 — Interface

Abra `http://localhost:6767/game`. A arena aparece com a bola já em movimento e o status
`Conectado`.

### Passo 6 — Conferência

Movimente a primeira protoboard: a raquete **esquerda** acompanha e o rodapé passa a indicar
`Jogador 1: ESP32 esp32-01`. Movimente a segunda: a raquete **direita** acompanha e o rodapé
indica `Jogador 2: ESP32 esp32-02`. Com os dois lados atribuídos, o teclado deixa de ter efeito.

### 10.1. Diagnóstico

| Sintoma | Causa provável | Ação |
|---------|----------------|------|
| `[MMA] Sensor nao encontrado` em loop | Ligação I²C ou endereço incorreto | Confira VCC/GND/SDA/SCL; troque `MMA_ADDR` entre `0x1D` e `0x1C` |
| Wi-Fi não conecta | Rede 5 GHz, SSID ou senha incorretos | Use uma rede 2,4 GHz; revise as credenciais |
| Serial mostra `[WS] Desconectado` em repetição | `WS_HOST` incorreto, porta bloqueada ou servidor fora do ar | Confira o IP, o firewall e se o servidor está em execução |
| Página indica `Sem conexão com o servidor` | Servidor parado ou inalcançável | Reinicie o servidor; a página reconecta sozinha a cada 2 s |
| As duas placas controlam a mesma raquete | `DEVICE_ID` repetido | Regrave a segunda placa com `"esp32-02"` |
| Raquete oscila parada na mão | `FULL_TILT` baixo demais | Aumente `FULL_TILT` ou reduza `TILT_SMOOTHING` em `main.ts` |
| Raquete responde devagar | `TILT_SMOOTHING` baixo demais | Aumente `TILT_SMOOTHING` (máximo 1,0, sem suavização) |
| Raquete anda no eixo errado | Protoboard montada em outra orientação | Troque `AXIS` para `"x"` em `main.ts` |

---

## 11. Organização do código

| Caminho | Camada | Conteúdo |
|---------|--------|----------|
| `controlador.cpp` | Sistema embarcado | Firmware do ESP32: aquisição do MMA8452, tarefas FreeRTOS e cliente WebSocket |
| `main.ts` | Servidor | `Bun.serve` na porta 6767, motor do jogo a 60 Hz, estado autoritativo e difusão |
| `page.html` | Interface Web | Shell da página; carrega `frontend/main.jsx` |
| `frontend/App.jsx` | Interface Web | Placar, overlays, status e indicação de controles |
| `frontend/useGame.js` | Interface Web | Conexão `/viewer`, reconexão automática e envio de teclas |
| `frontend/usePong.js` | Interface Web | Desenho do estado no canvas, sem qualquer física |
| `documentation/` | Documentação | Este README e o relatório técnico |

---

## 12. Documentação complementar

O [relatório técnico](RELATORIO-TECNICO.md) detalha a arquitetura, as decisões de paralelismo e
sincronização, os experimentos realizados e os resultados obtidos.
