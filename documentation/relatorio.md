# Relatório técnico: Pong distribuído com ESP32 e processamento paralelo

> **Rascunho.** As seções de arquitetura e as respostas conceituais descrevem o que está
> implementado no código. Os valores medidos (marcados com **[medir]**) precisam ser
> preenchidos pelo grupo depois dos experimentos com o hardware.

## 1. Introdução

O sistema transforma movimentos físicos de duas protoboards em comandos de um jogo executado
remotamente. Cada protoboard tem um ESP32 e um acelerômetro MMA8452. Um servidor central
mantém o estado da partida e roda o motor do jogo. Um navegador mostra a partida.
O Pong serve como meio de observar três problemas distintos:

- **paralelismo**: duas tarefas em núcleos diferentes do ESP32;
- **concorrência**: aquisição × comunicação no ESP32, e eventos de dois jogadores no servidor;
- **distribuição**: ESP32, servidor e navegador cooperando pela rede.

## 2. Arquitetura da solução

```
 ESP32 #1 (J1)                     ESP32 #2 (J2)
 ┌─────────────────┐              ┌─────────────────┐
 │ TaskSensor  C1  │              │ TaskSensor  C1  │
 │   ↓ fila[1]     │              │   ↓ fila[1]     │
 │ TaskNetwork C0  │              │ TaskNetwork C0  │
 └───────┬─────────┘              └────────┬────────┘
   ws /ws/player1                    ws /ws/player2
         └──────────────┐   ┌──────────────┘
                   ┌────▼───▼─────┐
                   │   SERVIDOR   │  Bun (TypeScript)
                   │ estado + motor│  tick fixo 60 Hz
                   └──────┬───────┘
                     ws /viewer (60 Hz)
                   ┌──────▼───────┐
                   │  NAVEGADOR   │  React + canvas
                   └──────────────┘
```

| Componente | Tecnologia | Arquivo |
|---|---|---|
| Firmware | Arduino-ESP32 + FreeRTOS, links2004/WebSockets | `esp32/src/main.cpp` |
| Servidor | Bun 1.x, TypeScript estrito | `server/main.ts`, `server/game.ts`, `server/protocol.ts` |
| Interface | React 19 + Canvas 2D | `web/` |

## 3. Sistema embarcado

Cada jogador tem 1 ESP32, 1 MMA8452 ligado por I²C (SDA = GPIO21, SCL = GPIO22, 400 kHz)
e uma protoboard. As duas placas usam o **mesmo firmware**. Só a constante `PLAYER` (1 ou 2)
muda, e ela define o endpoint (`/ws/player1` ou `/ws/player2`) e o campo `player` do `hello`.
O identificador `device` é derivado do MAC (`esp32-xxxxxx`).

## 4. Aquisição do acelerômetro

- O MMA8452 é configurado em **±2 g, 12 bits, ODR de 100 Hz**.
- A **TaskSensor** lê X, Y e Z a cada **10 ms (100 Hz)** com `vTaskDelayUntil`.
  O período é fixo e não depende da rede.
- **Justificativa dos 100 Hz:**
  - É a taxa de dados interna configurada no sensor. Ler mais rápido só devolveria valores repetidos.
  - O movimento voluntário da mão tem componentes até cerca de 10 Hz. Amostrar a 100 Hz fica
    bem acima de Nyquist e dá amostras suficientes para o filtro.
  - O custo é baixo: cerca de 0,2 ms de I²C por leitura a 400 kHz.
- **Pré-processamento** (o ESP32 transmite a posição, não os valores brutos):
  1. **Filtro**: média móvel exponencial no eixo Y com α = 0,25. A constante de tempo é
     τ ≈ 35 ms, e o corte fica em cerca de 4,6 Hz. Isso remove ruído e tremor.
  2. **Calibração**: média de 50 amostras (0,5 s) com a placa parada define o "zero" (repouso).
     Ela é feita no boot e pode ser repetida pela interface (botão "Calibrar repouso").
  3. **Zona morta** de 0,04 g (~2°): pequenas oscilações perto do repouso não movem a raquete.
  4. **Sensibilidade**: 0,6 g (~37°) leva a raquete de uma ponta à outra.
     O resultado é limitado a [-1, 1].
- **Robustez**: falhas de I²C são contadas. Depois de 50 falhas seguidas, o sensor é
  reinicializado.

## 5. Paralelismo e concorrência

| Tarefa | Núcleo | Prioridade | Função |
|---|---|---|---|
| `TaskSensor` | 1 (APP_CPU) | 3 | produtor: lê, filtra e calibra o sensor; publica a amostra |
| `TaskNetwork` | 0 (PRO_CPU) | 2 | consumidor: Wi-Fi, WebSocket, envio, reconexão, estatísticas |

As tarefas são criadas com `xTaskCreatePinnedToCore`, e a tarefa `loop()` do Arduino é
removida. A TaskNetwork fica no núcleo 0 junto com a pilha Wi-Fi/lwIP do ESP-IDF.
Assim, o núcleo 1 fica livre para a aquisição. Como estão em núcleos distintos, as duas
tarefas executam **em paralelo de fato**, e não apenas intercaladas.

## 6. Comunicação entre tarefas

**Mecanismo:** produtor-consumidor com uma **fila FreeRTOS de 1 posição** usada como caixa
de correio:

- o produtor chama `xQueueOverwrite(sampleBox, &s)`, que **nunca bloqueia**: se a amostra
  anterior ainda não foi lida, ela é substituída;
- o consumidor chama `xQueueReceive(sampleBox, &s, 0)` a cada 20 ms e pega **a amostra mais
  recente**, sem esperar.

**Recursos compartilhados e proteção:**

| Recurso | Quem usa | Proteção |
|---|---|---|
| amostra (`seq`, `t`, `pos`) | Sensor escreve, Network lê | fila FreeRTOS: a cópia da struct é atômica (seção crítica interna) |
| contadores `readsTotal`, `i2cErrorsTotal` | Sensor escreve, Network lê | `std::atomic<uint32_t>` |
| porta `Serial` | as duas tarefas registram log | mutex `serialMutex` (`logLine`) |
| pedido de recalibração | Network sinaliza, Sensor consome | notificação de tarefa (`xTaskNotifyGive` / `ulTaskNotifyTake`) |
| barramento I²C (`Wire`) | só a TaskSensor | não é compartilhado (posse exclusiva) |
| socket WebSocket e `wsConnected` | só a TaskNetwork (inclusive o callback) | não é compartilhado |

**Condições de corrida evitadas:** sem a fila, se a amostra fosse uma variável global
comum, a TaskNetwork poderia ler `pos` de uma amostra e `seq`/`t` de outra (**leitura
rasgada**), enquanto a TaskSensor escreve no outro núcleo ao mesmo tempo. Também poderia
ler um valor que o compilador manteve em registrador. Nos logs, duas tarefas escrevendo na
Serial ao mesmo tempo intercalariam caracteres.

**Por que uma fila de 1 posição, e não uma fila longa:** o jogo só precisa da posição
**atual**. Uma FIFO longa, com a rede lenta, guardaria amostras antigas e acrescentaria
atraso: a raquete reproduziria o passado. Ela também poderia encher e bloquear o produtor.
A caixa de correio limita a idade da amostra enviada a no máximo um período de aquisição.

**Produtor mais rápido que o consumidor:** é o caso normal (100 Hz contra 50 Hz). Cerca de
metade das amostras é sobrescrita sem ser enviada, o que aparece no contador
`descartadas/s ≈ 50`. Elas não fazem falta porque já entraram no filtro: a informação delas
está na amostra seguinte.

**Perda temporária da conexão:** a TaskNetwork para de consumir e fica tentando reconectar.
Ela pode ficar bloqueada até alguns segundos dentro de `ws.loop()` tentando abrir o TCP.
A TaskSensor continua a 100 Hz no outro núcleo, sobrescrevendo a caixa (descartadas/s ≈ 100).
Nada se acumula na memória. Ao reconectar, a primeira amostra enviada já é a atual.

## 7. Comunicação em rede

A TaskNetwork:
1. conecta ao Wi-Fi (`WiFi.setAutoReconnect(true)`);
2. abre o WebSocket em `ws://WS_HOST:6767/ws/playerN` e envia `hello`;
3. a cada 20 ms (50 Hz) envia `input` com `seq`, `sample`, `t` e `pos`;
4. a cada 1 s envia `ping` (para medir RTT) e `stats` (leituras/s, envios/s, descartadas/s,
   erros I²C, reconexões e RTT);
5. **detecta desconexão** pelo evento `WStype_DISCONNECTED` e pelo *heartbeat* do WebSocket
   (ping a cada 1 s; 2 pongs perdidos derrubam a conexão);
6. **recupera** com nova tentativa a cada 2 s (`setReconnectInterval(2000)`), reenviando `hello`.

**Por que 50 Hz de envio, e não 100 Hz:** o servidor atualiza o jogo a 60 Hz e o
navegador desenha a 60 Hz. 50 Hz de entradas mantém a espera média na caixa em cerca de 10 ms.
Também reduz pela metade o tráfego e o tempo de rádio, sem perda perceptível de resposta.

O protocolo completo está no `README.md`.

## 8. Servidor

O servidor é um `Bun.serve` na porta 6767, com os endpoints:
- `/ws/player1` e `/ws/player2`: um ESP32 em cada. São **duas conexões independentes e
  simultâneas**. O endpoint identifica o jogador, e o `hello.player` precisa coincidir com ele;
- `/viewer`: navegadores, inscritos no tópico pub/sub `viewers`;
- `/game`: a página.

**Modelo de concorrência:** o Bun executa o JavaScript em uma única thread com event loop.
As mensagens dos dois ESP32, dos navegadores e o tick do jogo são **eventos concorrentes**:
chegam em qualquer ordem e intercalados. Porém cada handler roda até o fim sem ser
interrompido. A I/O de rede é paralela (feita pelo runtime), mas a manipulação do estado é
serializada. Por isso não há corrida de dados no estado e não é necessário lock.

**Tratamento de falhas:**
- **Amostra antiga (`seq` ≤ último):** é descartada (`outOfOrder`).
- **Lacuna de `seq`:** é contada como mensagem perdida (`lost`).
- **Sem amostra há mais de 500 ms:** o jogador aparece como "sem dados" na interface.
- **Sem nenhuma mensagem por 3 s:** o servidor encerra o socket (`terminate()`). Isso cobre o
  caso em que o TCP não percebe a queda.
- **Reconexão antes de o servidor notar a queda:** o novo `hello` substitui a conexão antiga.
- **`hello` com jogador diferente do endpoint:** a conexão é fechada com o código 1008 e
  não derruba o jogador legítimo.
- **Queda de um ESP32 durante a partida:** a fase passa para `paused`. Ela volta sozinha
  quando a mesma placa reconecta. Também é possível continuar com teclado pela interface.

## 9. Motor e estado do jogo

`server/game.ts` contém a classe `Game`, que não conhece sockets. O estado global é formado por:

| Campo | Conteúdo |
|---|---|
| `paddles[1/2].y` | posição de cada raquete |
| `paddles[1/2].target` | alvo derivado da última `pos` recebida |
| `paddles[1/2].esp32`, `keyDir` | quem controla a raquete e a tecla pressionada |
| `ball.x, y, vx, vy` | posição, velocidade e direção da bola |
| `score[1/2]` | placar |
| `phase`, `winner`, `pausedFor` | estado da partida (`waiting` / `playing` / `paused` / `over`) |
| `tick` | número do passo de simulação |

**Laço de jogo:** passo fixo de 1/60 s, com acumulador sobre `performance.now()`.
Cada passo:
1. move as raquetes, percorrendo 60 % do caminho até o alvo, o que suaviza a diferença
   entre 50 Hz de entrada e 60 Hz de simulação;
2. move a bola;
3. trata colisões com as paredes e com as raquetes (o ângulo de saída depende do ponto de
   contato, e a velocidade aumenta 5 % por rebatida até um limite);
4. calcula a pontuação;
5. reinicia a bola no centro, com 1 s de espera antes do saque;
6. encerra a partida em 7 pontos.

**Consistência:** só `step()` altera posições, bola e placar (um único escritor). Os handlers
de rede apenas gravam **entradas** (`target`, `keyDir`) e comandos de fase. Como tick e
handlers nunca executam ao mesmo tempo (event loop), cada passo vê um conjunto coerente de
entradas, e cada snapshot enviado corresponde a um passo completo.

## 10. Interface Web

`web/useGame.js` conecta em `/viewer`, guarda o último `state` e reconecta a cada 2 s.
`web/useRenderer.js` desenha esse estado no canvas a cada `requestAnimationFrame`.
O navegador **não tem física**. Ele só envia comandos: iniciar, continuar, reiniciar,
teclas e calibrar. É o servidor que decide se cada comando vale.
A interface mostra a arena, as duas raquetes, a bola e o placar, além de painéis de
diagnóstico por jogador usados nos experimentos.

## 11. Estratégias de sincronização (resumo)

| Onde | Problema | Solução |
|---|---|---|
| ESP32: Sensor → Network | troca de amostras entre núcleos | fila de 1 posição com `xQueueOverwrite` |
| ESP32: contadores | leitura entre núcleos | `std::atomic` |
| ESP32: Serial | log das duas tarefas | mutex |
| ESP32: recalibrar | sinal Network → Sensor | notificação de tarefa |
| Servidor: 2 ESP32 + N navegadores + tick | eventos concorrentes sobre o mesmo estado | event loop single-thread, um único escritor (`step`) |
| Servidor: amostras atrasadas | estado desatualizado | `seq` monotônico; descarta as antigas |
| Servidor: conexão duplicada | reconexão antes do timeout | o `hello` novo substitui o socket antigo |
| Servidor → navegador | navegador lento ou reconectando | envia só o estado mais recente (sem fila de histórico) |

## 12. Experimentos

### Experimento 1: taxa de aquisição

**Método:** contador `readsTotal` na TaskSensor. A TaskNetwork imprime a diferença a cada
1 s no Serial (`[stats] leituras/s=`). O valor aparece também no painel da interface.

| Placa | leituras/s (média de 30 s) | erros I²C |
|---|---|---|
| J1 | **[medir]** (esperado ≈ 100) | **[medir]** |
| J2 | **[medir]** | **[medir]** |

### Experimento 2: taxa de comunicação

**Método:** `envios/s`, contado no ESP32, e `recebidas/s`, contado no servidor por janela
de 1 s.

| Placa | envios/s (ESP32) | recebidas/s (servidor) | descartadas/s |
|---|---|---|---|
| J1 | **[medir]** (esperado ≈ 50) | **[medir]** | **[medir]** (esperado ≈ 50) |
| J2 | **[medir]** | **[medir]** | **[medir]** |

### Experimento 3: latência fim a fim

**Método 1 (vídeo):** filmar a protoboard e a tela no mesmo quadro, em câmera lenta
(240 fps = 4,2 ms por quadro). Para cada uma de 10 a 20 batidas rápidas, contar os quadros
entre o início do movimento da placa e o início do movimento da raquete na tela.

**Método 2 (decomposição):** somar as parcelas medidas pelo próprio sistema (RTT ESP32 no
painel, RTT do navegador no rodapé) às parcelas conhecidas pelo projeto:

| Etapa | Estimativa | Medido |
|---|---|---|
| amostragem (espera até a próxima leitura) | 0–10 ms | — |
| filtro EMA (constante de tempo) | ~35 ms | — |
| espera na caixa até o próximo envio | 0–20 ms | — |
| ESP32 → servidor (≈ RTT/2) | 2–10 ms (LAN) | **[medir]** |
| espera até o próximo tick + suavização da raquete | 0–17 ms + ~20–40 ms | — |
| servidor → navegador (≈ RTT/2) | < 5 ms (LAN) | **[medir]** |
| espera até o próximo quadro + exibição do monitor | 0–17 ms + ~10–20 ms | — |
| **total estimado** | **≈ 80–150 ms** | **[medir pelo vídeo]** |

**Discussão:** **[preencher]**. A maior parte vem da suavização (filtro + raquete), que é
uma escolha de projeto para tirar o tremido. Reduzir `FILTER_ALPHA` deixa a resposta mais
lenta e mais estável; aumentar deixa mais rápida e mais tremida. Com o servidor na AWS,
acrescentar o RTT até a região (tipicamente 20–150 ms).

### Experimento 4: falha na comunicação

**Método:** durante a partida, cortar a rede de um dos ESP32. Opções:
- ligar essa placa num hotspot de celular e desligar o hotspot;
- envolver a placa em papel-alumínio ou numa caixa metálica.

Depois, restaurar a rede e acompanhar o Serial da placa, o log do servidor e a interface.

| Observação | Resultado esperado | Observado |
|---|---|---|
| Tarefa de comunicação | `[WS] desconectado`, tentativas a cada 2 s, envios/s = 0 | **[preencher]** |
| Tarefa de aquisição | **continua** `leituras/s ≈ 100`, descartadas/s ≈ 100 | **[preencher]** |
| Servidor | "sem dados" após 0,5 s; encerra o socket em ~3 s; fase `paused` | **[preencher]** |
| Outro jogador | continua conectado, a raquete dele segue se movendo | **[preencher]** |
| Interface | painel em vermelho; overlay "Pausado" | **[preencher]** |
| Recuperação | `[WS] conectado`, `hello`, partida retoma sozinha; contador de reconexões +1 | **[preencher]** (tempo até retomar: **[medir]**) |

### Experimento 5: desconexão da interface

**Método:** com a partida em andamento, fechar a aba e esperar 10 s. Em seguida, reabrir
`/game`, inclusive em outro computador.

**Esperado:** o servidor continua simulando (o log segue mostrando estatísticas e os ESP32
continuam enviando). Ao reabrir, a página recebe `welcome` e o `state` atual. O placar e a
posição da bola são os da partida em andamento, não os iniciais. Vários navegadores podem
assistir ao mesmo tempo e mostram o mesmo estado.

**Observado:** **[preencher]**

## 13. Resultados

**[preencher com os dados dos experimentos]**

## 14. Limitações

- O MMA8452 mede aceleração total. Com a placa parada, isso é a inclinação (gravidade).
  Movimentos bruscos somam aceleração linear e causam picos, atenuados pelo filtro.
- A latência na AWS depende da distância até a região.
- `ws://` sem TLS e sem autenticação: qualquer um na rede pode se conectar como jogador
  ou como espectador.
- Não há interpolação no navegador: se a rede até o navegador tiver jitter, a bola pode
  "pular" quadros.
- O relógio do ESP32 (`t`) não é sincronizado com o do servidor, então a latência só de ida
  é estimada como RTT/2.

## 15. Conclusão

**[preencher]**

---

## Respostas às questões do enunciado (seção 18)

**1. Onde existe paralelismo?**
No ESP32: TaskSensor (núcleo 1) e TaskNetwork (núcleo 0) executam simultaneamente em núcleos
físicos distintos. Também há paralelismo entre as máquinas: os dois ESP32, o servidor e o
navegador executam ao mesmo tempo.

**2. Onde existe concorrência?**
- No ESP32: as duas tarefas acessam a mesma amostra, os contadores e a Serial.
- No servidor: as mensagens dos dois jogadores, dos navegadores e o tick do jogo chegam
  intercalados e disputam o mesmo estado da partida.

**3. Onde existe processamento distribuído?**
No sistema como um todo. Cada ESP32 faz aquisição e pré-processamento, o servidor roda o
motor e guarda o estado, e o navegador faz a representação. São processos em máquinas
diferentes que cooperam por WebSocket sobre TCP/IP.

**4. Quais recursos são compartilhados pelas tarefas do ESP32?**
A amostra mais recente (a fila), os contadores de estatística, a porta Serial e o sinal de
recalibração. O barramento I²C e o socket **não** são compartilhados, porque cada um pertence
a uma única tarefa.

**5. Existe possibilidade de condição de corrida? Por quê?**
Sim, se não houvesse sincronização. As tarefas rodam em núcleos diferentes ao mesmo tempo,
então a escrita da struct `Sample` (12 bytes, não atômica) pode ser intercalada com a
leitura, misturando campos de duas amostras. O mesmo vale para os caracteres na Serial.

**6. Qual mecanismo foi escolhido?**
Uma fila FreeRTOS de uma posição com `xQueueOverwrite` (produtor) e `xQueueReceive` sem
espera (consumidor). Complementos: `std::atomic` para os contadores, mutex para a Serial e
notificação de tarefa para recalibrar.

**7. Por que esse mecanismo?**
- A fila do FreeRTOS já é segura entre núcleos: copia a struct inteira dentro de uma seção crítica.
- O produtor nunca bloqueia, o que é essencial para a aquisição não depender da rede.
- O tamanho 1 garante que o consumidor sempre pegue o dado **mais recente**, sem acumular
  atraso nem memória.

**8. E se a aquisição produzir mais rápido do que se transmite?**
É o caso normal (100 Hz contra 50 Hz). As amostras não lidas são sobrescritas, e o contador
`descartadas/s` mostra quantas. Como elas já passaram pelo filtro, a informação é
aproveitada. Nada se acumula e o produtor nunca espera.

**9. O que ocorre quando um ESP32 perde a conexão?**
- No ESP32: a aquisição continua a 100 Hz, e a TaskNetwork tenta reconectar a cada 2 s.
- No servidor: a placa é marcada "sem dados" em 0,5 s e o socket é encerrado em 3 s. A raquete
  para e a partida pausa.
- Na reconexão: o `hello` retoma o controle, a partida continua e a primeira amostra enviada
  já é a atual.

**10. Como o servidor trata eventos dos dois jogadores?**
Cada jogador tem sua conexão e seu endpoint. Os handlers rodam no event loop, um de cada vez.
Cada `input` válido e não desatualizado só atualiza o alvo da raquete daquele jogador.
O tick aplica as entradas de ambos no mesmo passo.

**11. Que informações constituem o estado global?**
Posição das raquetes (e alvos/controle), posição e velocidade da bola, placar, fase da
partida, vencedor e número do tick. Veja a seção 9.

**12. Como é mantida a consistência?**
- Há um único escritor (`Game.step`).
- A execução é serializada no event loop: tick e handlers nunca se sobrepõem.
- Amostras antigas são descartadas por `seq`.
- Snapshots completos são enviados aos navegadores (não deltas).

**13. Por que o estado está no servidor e não no navegador?**
- Há uma única fonte de verdade: vários navegadores mostram a mesma partida.
- Fechar ou recarregar a página não perde nada.
- Os ESP32 precisam de um ponto fixo para se conectar.
- Um cliente não consegue alterar o placar: o servidor valida todos os comandos.

**14. O que ocorre quando o navegador é desconectado?**
Nada na partida. O servidor continua simulando e recebendo dos ESP32. Ao reconectar, o
navegador recebe `welcome` e o `state` atual e volta a representá-la. Se a aba fechar com uma
tecla pressionada, o servidor zera essa tecla.

**15. Qual o impacto da latência sobre a jogabilidade?**
A raquete reage com atraso ao movimento. Em LAN, o total fica em torno de **[medir]** ms e é
dominado pela suavização, não pela rede. Acima de cerca de 150–200 ms, o jogador passa a
"atrasar" a rebatida. Com jitter, a bola deixa de se mover de forma uniforme.

**16. Quais partes têm requisitos temporais mais críticos?**
1. A aquisição: período fixo, para o filtro ser estável.
2. O tick do servidor: passo fixo, para a física ser determinística.
3. O caminho da entrada até a tela, que define a latência percebida.

Estatísticas, logs e reconexão são tolerantes a atraso.

**17. A frequência de aquisição deve ser igual à de transmissão?**
Não. A aquisição precisa ser rápida para filtrar bem (100 Hz). A transmissão só precisa
acompanhar o ritmo do jogo (50 Hz contra 60 Hz de tick). Desacoplar as duas é justamente o
que a caixa de correio permite.

**18. Todos os dados do acelerômetro precisam chegar ao servidor?**
Não. O jogo usa só a posição atual. Amostras intermediárias já contribuíram via filtro, e
retransmitir dados velhos depois de uma queda só mostraria movimentos que já passaram.

**19. Todos os estados intermediários do servidor precisam ir ao navegador?**
Não. O navegador só precisa do estado mais recente para desenhar. Se o servidor atrasar e
fizer vários passos de uma vez, envia apenas o último. Seria possível enviar a 30 Hz e
interpolar no navegador para economizar banda.

**20. Mudanças para 100 ou 1.000 dispositivos?**
- **Salas:** várias partidas independentes, cada uma com seu `Game` e seu tópico pub/sub.
  Um mapa `sala → jogadores` substitui os endpoints fixos.
- **Identificação:** token ou ID por dispositivo no `hello`, com autenticação e TLS (`wss://`).
- **Distribuição de carga:** separar salas entre *workers*, processos ou instâncias, com um
  balanceador que mantenha cada sala no mesmo nó (afinidade), ou um broker de mensagens
  (Redis pub/sub, MQTT) entre os nós.
- **Banda:** protocolo binário, menos casas decimais, envio só quando a posição muda além de
  um limiar, menor taxa para espectadores (com interpolação).
- **Operação:** limites de taxa por conexão, métricas centralizadas e reconexão com
  *backoff* exponencial para evitar avalanche de reconexões após uma queda geral.
