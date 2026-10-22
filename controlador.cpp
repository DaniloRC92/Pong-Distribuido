// ESP32 + MMA8452 -> WebSocket (ws://, sem SSL, sem autenticação)
// Dependência: links2004/WebSockets
// Ligação: VCC->3V3, GND->GND, SDA->GPIO21, SCL->GPIO22

#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <WebSocketsClient.h>

const char*    WIFI_SSID        = "SEU_WIFI";   // preencha antes de gravar
const char*    WIFI_PASS        = "SUA_SENHA";
const char*    WS_HOST         = "10.227.166.98";
const uint16_t WS_PORT          = 6767;  // mesma porta do main.ts
const char*    DEVICE_ID        = "esp32-01";
const uint32_t SEND_INTERVAL_MS = 50;    // 20 envios/s

const uint8_t MMA_ADDR = 0x1D;           // 0x1C se o pino SA0 estiver no GND

WebSocketsClient ws;
bool     wsConnected = false;
uint32_t lastSend    = 0;

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
  mmaWrite(0x2A, 0x19);                               // 100 Hz + ativo
  return true;
}

bool mmaRead(float& x, float& y, float& z) {
  Wire.beginTransmission(MMA_ADDR);
  Wire.write(0x01);                                   // OUT_X_MSB
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MMA_ADDR, (uint8_t)6) != 6) return false;

  float g[3];
  for (int i = 0; i < 3; i++) {
    uint8_t msb = Wire.read();
    uint8_t lsb = Wire.read();
    g[i] = ((int16_t)((msb << 8) | lsb) >> 4) / 1024.0f;  // 12 bits, 1024 contagens/g
  }
  x = g[0]; y = g[1]; z = g[2];
  return true;
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  if (type == WStype_CONNECTED) {
    wsConnected = true;
    lastSend = millis();
    Serial.println("[WS] Conectado");

    char msg[80];
    snprintf(msg, sizeof(msg), "{\"type\":\"hello\",\"device\":\"%s\",\"scale\":2}", DEVICE_ID);
    ws.sendTXT(msg);
  } else if (type == WStype_DISCONNECTED) {
    wsConnected = false;
    Serial.println("[WS] Desconectado");
  }
}

void setup() {
  Serial.begin(115200);
  Wire.begin();                                       // SDA 21, SCL 22

  while (!mmaBegin()) {
    Serial.println("[MMA] Sensor nao encontrado");
    delay(1000);
  }

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[WiFi] Conectando");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\n[WiFi] IP: %s\n", WiFi.localIP().toString().c_str());

  ws.begin(WS_HOST, WS_PORT, "/");
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(3000);
}

void loop() {
  ws.loop();

  if (!wsConnected || millis() - lastSend < SEND_INTERVAL_MS) return;
  lastSend += SEND_INTERVAL_MS;

  float x, y, z;
  if (!mmaRead(x, y, z)) return;

  char msg[128];
  snprintf(msg, sizeof(msg),
           "{\"type\":\"accel\",\"device\":\"%s\",\"t\":%lu,\"x\":%.4f,\"y\":%.4f,\"z\":%.4f}",
           DEVICE_ID, (unsigned long)millis(), x, y, z);
  ws.sendTXT(msg);
}