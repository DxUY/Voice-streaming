#include <WiFi.h>
#include <WiFiUdp.h>
#include <driver/i2s.h>

const char* ssid = "PTIT.HCM_SV";
const char* password = "";
const char* udpAddress = "10.241.0.194";
const int udpPort = 9000;

#define BUTTON_PIN 4
#define I2S_SD 13
#define I2S_WS 11
#define I2S_SCK 12
#define I2S_PORT I2S_NUM_0

#define SAMPLE_RATE 16000
#define BUFFER_SAMPLES 256
#define BUFFER_BYTES (BUFFER_SAMPLES * 2)
int16_t audioBuffer[BUFFER_SAMPLES];

WiFiUDP udp;
bool isRecording = false;
bool lastButtonState = HIGH;

void i2s_install() {
  const i2s_config_t i2s_config = {
    .mode = i2s_mode_t(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = BUFFER_SAMPLES,
    .use_apll = false,
  };
  i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
}

void i2s_setpin() {
  const i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = -1,
    .data_in_num = I2S_SD
  };
  i2s_set_pin(I2S_PORT, &pin_config);
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  
  i2s_install();
  i2s_setpin();
  i2s_start(I2S_PORT);
  udp.begin(udpPort);
  Serial.println("\n✅ Ready! Press button to Start/Stop recording.");
}

void loop() {
  bool currentButtonState = digitalRead(BUTTON_PIN);
  if (lastButtonState == HIGH && currentButtonState == LOW) { // Button Pressed
    isRecording = !isRecording;
    if (isRecording) {
      Serial.println("🎙️ Recording ON...");
    } else {
      Serial.println("🛑 Recording OFF. Waiting for ClearSpeech...");
    }
    delay(200); 
  }
  lastButtonState = currentButtonState;

  if (isRecording) {
    size_t bytesRead = 0;
    i2s_read(I2S_PORT, audioBuffer, BUFFER_BYTES, &bytesRead, portMAX_DELAY);
    
    if (bytesRead > 0) {
      udp.beginPacket(udpAddress, udpPort);
      udp.write((uint8_t*)audioBuffer, BUFFER_BYTES);
      udp.endPacket();
    }
  }
}