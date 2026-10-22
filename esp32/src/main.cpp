// Controle do Pong: ESP32 + MMA8452 -> WebSocket (ws://, sem SSL, sem autenticação)
//
// Duas tarefas FreeRTOS fixadas em núcleos distintos:
//   TaskSensor  (núcleo 1) — produtor: lê o MMA8452 a 100 Hz, filtra, calibra e
//                            converte a inclinação em posição -1..1
//   TaskNetwork (núcleo 0) — consumidor: Wi-Fi, WebSocket, envio a 50 Hz, reconexão
//
// Comunicação entre as tarefas: fila FreeRTOS de 1 posição usada como "caixa de
// correio" (xQueueOverwrite). O produtor nunca bloqueia; o consumidor sempre pega
// a amostra mais recente. Amostras que não chegaram a ser lidas são descartadas.
//
// Dependência: links2004/WebSockets
// Ligação: VCC->3V3, GND->GND, SDA->GPIO21, SCL->GPIO22

#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <WebSocketsClient.h>
#include <atomic>
#include <stdarg.h>

// ---------- configuração ----------
#define PLAYER 1  // 1 = raquete esquerda, 2 = raquete direita (mesmo firmware nas duas placas)

const char*    WIFI_SSID = "SEU_WIFI";   // preencha antes de gravar; não versione
const char*    WIFI_PASS = "SUA_SENHA";
const char*    WS_HOST   = "10.227.166.98";  // IP do PC ou do servidor AWS
const uint16_t WS_PORT   = 6767;             // mesma porta do server/main.ts

const uint32_t SAMPLE_PERIOD_MS = 10;    // 100 Hz, igual ao ODR configurado no sensor
const uint32_t SEND_PERIOD_MS   = 20;    // 50 Hz
const uint32_t STATS_PERIOD_MS  = 1000;
const uint32_t PING_PERIOD_MS   = 1000;

// Conversão inclinação -> posição
const int   AXIS          = 1;      // eixo usado: 0 = x, 1 = y, 2 = z
const float FILTER_ALPHA  = 0.25f;  // média móvel exponencial: τ ≈ 35 ms, corte ≈ 4,6 Hz a 100 Hz
const float DEADZONE_G    = 0.04f;  // |inclinação| abaixo disso conta como repouso (~2°)
const float FULL_TILT_G   = 0.6f;   // inclinação que leva a raquete de ponta a ponta (~37°)
const int   CALIB_SAMPLES = 50;     // 0,5 s parado para medir a posição de repouso
const int   I2C_ERRORS_TO_REINIT = 50;

const uint8_t MMA_ADDR = 0x1D;      // 0x1C se o pino SA0 estiver no GND

// ---------- recursos compartilhados entre as tarefas ----------
struct Sample {
  uint32_t seq;  // número da amostra (contado pelo produtor)
  uint32_t t;    // millis() da leitura
  float    pos;  // -1..1, positivo = raquete para cima
};

QueueHandle_t     sampleBox;    // fila de 1 posição: a amostra mais recente
SemaphoreHandle_t serialMutex;  // Serial é usada pelas duas tarefas
TaskHandle_t      sensorTask;   // recebe notificação de "recalibrar" da TaskNetwork

// Escritos por uma tarefa e lidos pela outra; atomic evita leitura rasgada/otimizada
std::atomic<uint32_t> readsTotal{0};
std::atomic<uint32_t> i2cErrorsTotal{0};

char deviceId[20];

void logLine(const char* fmt, ...) {
  char buf[200];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  xSemaphoreTake(serialMutex, portMAX_DELAY);
  Serial.println(buf);
  xSemaphoreGive(serialMutex);
}

// ---------- MMA8452 (usado só pela TaskSensor) ----------
void mmaWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MMA_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

bool mmaBegin() {
  Wire.beginTransmission(MMA_ADDR);
  Wire.write(0x0D);                                   // WHO_AM_I
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MMA_ADDR, (uint8_t)1) != 1) return false;
  if (Wire.read() != 0x2A) return false;

  mmaWrite(0x2A, 0x00);                               // standby
  mmaWrite(0x0E, 0x00);                               // escala ±2g
  mmaWrite(0x2A, 0x19);                               // ODR 100 Hz + ativo
  return true;
}

bool mmaRead(float g[3]) {
  Wire.beginTransmission(MMA_ADDR);
  Wire.write(0x01);                                   // OUT_X_MSB
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MMA_ADDR, (uint8_t)6) != 6) return false;

  for (int i = 0; i < 3; i++) {
    uint8_t msb = Wire.read();
    uint8_t lsb = Wire.read();
    g[i] = ((int16_t)((msb << 8) | lsb) >> 4) / 1024.0f;  // 12 bits, 1024 contagens/g
  }
  return true;
}

// ---------- Task 1: aquisição (produtor) ----------
void taskSensor(void*) {
  Wire.begin();                                       // SDA 21, SCL 22
  Wire.setClock(400000);
  while (!mmaBegin()) {
    logLine("[MMA] sensor nao encontrado; tentando de novo");
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
  logLine("[MMA] ok; mantenha a placa parada para calibrar");

  float    filtered   = 0;
  bool     first      = true;
  float    offset     = 0;
  float    calibSum   = 0;
  int      calibLeft  = CALIB_SAMPLES;
  int      errorsRow  = 0;
  uint32_t seq        = 0;
  TickType_t wake = xTaskGetTickCount();

  for (;;) {
    // Período fixo, independente de quanto a rede demora
    vTaskDelayUntil(&wake, pdMS_TO_TICKS(SAMPLE_PERIOD_MS));

    // Pedido de recalibração (notificação enviada pela TaskNetwork)
    if (ulTaskNotifyTake(pdTRUE, 0) > 0) {
      calibLeft = CALIB_SAMPLES;
      calibSum  = 0;
      logLine("[MMA] recalibrando; mantenha a placa parada");
    }

    float g[3];
    if (!mmaRead(g)) {
      i2cErrorsTotal++;
      if (++errorsRow >= I2C_ERRORS_TO_REINIT) {
        errorsRow = 0;
        logLine("[MMA] muitas falhas de leitura; reiniciando sensor");
        mmaBegin();
      }
      continue;
    }
    errorsRow = 0;
    readsTotal++;

    // Filtragem: remove ruído e tremores pequenos da mão
    float raw = g[AXIS];
    filtered = first ? raw : filtered + FILTER_ALPHA * (raw - filtered);
    first = false;

    // Calibração: a média em repouso vira o "zero"
    if (calibLeft > 0) {
      calibSum += raw;
      if (--calibLeft == 0) {
        offset = calibSum / CALIB_SAMPLES;
        logLine("[MMA] repouso calibrado em %.3f g", offset);
      }
    }

    // Zona morta + escala: pequenas oscilações perto do repouso não movem a raquete
    float d = filtered - offset;
    if (fabsf(d) < DEADZONE_G) d = 0;
    else d -= copysignf(DEADZONE_G, d);
    float pos = constrain(d / (FULL_TILT_G - DEADZONE_G), -1.0f, 1.0f);

    Sample s = { seq++, millis(), pos };
    xQueueOverwrite(sampleBox, &s);  // nunca bloqueia: substitui a amostra não lida
  }
}

// ---------- Task 2: comunicação (consumidor) ----------
WebSocketsClient ws;      // usados só dentro da TaskNetwork
bool     wsConnected = false;
uint32_t connections = 0;
uint32_t pingId      = 0;
uint32_t pingSentAt  = 0;
int32_t  rttMs       = -1;

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      wsConnected = true;
      connections++;
      logLine("[WS] conectado a %s:%u", WS_HOST, WS_PORT);
      char msg[128];
      snprintf(msg, sizeof(msg),
               "{\"type\":\"hello\",\"player\":%d,\"device\":\"%s\",\"sampleHz\":%lu,\"sendHz\":%lu}",
               PLAYER, deviceId, 1000UL / SAMPLE_PERIOD_MS, 1000UL / SEND_PERIOD_MS);
      ws.sendTXT(msg);
      break;
    }
    case WStype_DISCONNECTED:
      if (wsConnected) logLine("[WS] desconectado; tentando reconectar");
      wsConnected = false;
      break;
    case WStype_TEXT: {
      char buf[96];
      size_t n = length < sizeof(buf) - 1 ? length : sizeof(buf) - 1;
      memcpy(buf, payload, n);
      buf[n] = '\0';
      if (strstr(buf, "\"calibrate\"")) {
        xTaskNotifyGive(sensorTask);
      } else if (strstr(buf, "\"pong\"")) {
        const char* p = strstr(buf, "\"id\":");
        if (p && strtoul(p + 5, nullptr, 10) == pingId) rttMs = millis() - pingSentAt;
      }
      break;
    }
    default:
      break;
  }
}

void taskNetwork(void*) {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  logLine("[WiFi] conectando a %s", WIFI_SSID);

  char path[16];
  snprintf(path, sizeof(path), "/ws/player%d", PLAYER);
  ws.begin(WS_HOST, WS_PORT, path);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);
  ws.enableHeartbeat(1000, 1000, 2);  // ping a cada 1 s; 2 pongs perdidos = conexão caída

  bool     wifiUp    = false;
  uint32_t msgSeq    = 0;
  uint32_t lastSend  = millis();
  uint32_t lastPing  = millis();
  uint32_t lastStats = millis();
  uint32_t prevReads = 0;
  uint32_t sentWin   = 0;
  uint32_t takenWin  = 0;

  for (;;) {
    bool up = WiFi.status() == WL_CONNECTED;
    if (up != wifiUp) {
      wifiUp = up;
      if (up) logLine("[WiFi] conectado, IP %s", WiFi.localIP().toString().c_str());
      else    logLine("[WiFi] sem conexao; tentando reconectar");
    }
    // ws.loop() pode bloquear alguns segundos tentando abrir o TCP;
    // isso trava só esta tarefa — a TaskSensor continua no outro núcleo
    if (up) ws.loop();

    uint32_t now = millis();

    if (now - lastSend >= SEND_PERIOD_MS) {
      lastSend = (now - lastSend > 5 * SEND_PERIOD_MS) ? now : lastSend + SEND_PERIOD_MS;
      Sample s;
      // Sem conexão a amostra fica na caixa e é sobrescrita: nada se acumula
      if (wsConnected && xQueueReceive(sampleBox, &s, 0) == pdTRUE) {
        takenWin++;
        char msg[112];
        snprintf(msg, sizeof(msg),
                 "{\"type\":\"input\",\"seq\":%lu,\"sample\":%lu,\"t\":%lu,\"pos\":%.3f}",
                 (unsigned long)msgSeq, (unsigned long)s.seq, (unsigned long)s.t, s.pos);
        if (ws.sendTXT(msg)) {
          msgSeq++;
          sentWin++;
        }
      }
    }

    if (wsConnected && now - lastPing >= PING_PERIOD_MS) {
      lastPing   = now;
      pingSentAt = now;
      char msg[48];
      snprintf(msg, sizeof(msg), "{\"type\":\"ping\",\"id\":%lu}", (unsigned long)++pingId);
      ws.sendTXT(msg);
    }

    if (now - lastStats >= STATS_PERIOD_MS) {
      lastStats = now;
      uint32_t reads   = readsTotal.load();
      uint32_t readWin = reads - prevReads;
      prevReads = reads;
      uint32_t dropped = readWin > takenWin ? readWin - takenWin : 0;
      uint32_t reconnects = connections > 0 ? connections - 1 : 0;

      logLine("[stats] leituras/s=%lu envios/s=%lu descartadas/s=%lu erros_i2c=%lu ws=%s rtt=%ld ms",
              (unsigned long)readWin, (unsigned long)sentWin, (unsigned long)dropped,
              (unsigned long)i2cErrorsTotal.load(), wsConnected ? "on" : "off", (long)rttMs);

      if (wsConnected) {
        char msg[160];
        snprintf(msg, sizeof(msg),
                 "{\"type\":\"stats\",\"reads\":%lu,\"sent\":%lu,\"dropped\":%lu,"
                 "\"i2cErrors\":%lu,\"reconnects\":%lu,\"rtt\":%ld}",
                 (unsigned long)readWin, (unsigned long)sentWin, (unsigned long)dropped,
                 (unsigned long)i2cErrorsTotal.load(), (unsigned long)reconnects, (long)rttMs);
        ws.sendTXT(msg);
      }
      sentWin  = 0;
      takenWin = 0;
    }

    vTaskDelay(1);  // cede a CPU (watchdog do núcleo 0 e tarefas do Wi-Fi)
  }
}

void setup() {
  Serial.begin(115200);
  snprintf(deviceId, sizeof(deviceId), "esp32-%06lx",
           (unsigned long)((ESP.getEfuseMac() >> 24) & 0xFFFFFF));

  serialMutex = xSemaphoreCreateMutex();
  sampleBox   = xQueueCreate(1, sizeof(Sample));

  // Aquisição com prioridade maior, no núcleo 1 (o Wi-Fi do ESP-IDF roda no núcleo 0)
  xTaskCreatePinnedToCore(taskSensor,  "sensor",  4096, nullptr, 3, &sensorTask, 1);
  xTaskCreatePinnedToCore(taskNetwork, "network", 8192, nullptr, 2, nullptr,     0);

  logLine("[boot] %s jogador %d", deviceId, PLAYER);
}

void loop() {
  vTaskDelete(nullptr);  // tudo roda nas duas tarefas acima
}
