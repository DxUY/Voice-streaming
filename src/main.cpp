#include <WiFi.h>
#include <WiFiUdp.h>
#include <driver/i2s.h>

const char* ssid = "NguyenQuynh";
const char* password = "Quynh@123";
const char* udpAddress = "192.168.68.112";
const int udpPort = 9000;

#define BUTTON_PIN 4
#define I2S_SD 13
#define I2S_WS 11
#define I2S_SCK 12
#define I2S_PORT I2S_NUM_0
#define SAMPLE_RATE 16000
#define UDP_PACKET_SIZE 1024

uint8_t udpBuffer[UDP_PACKET_SIZE + 1]; 
WiFiUDP udp;
bool isRecording = false;
bool lastButtonState = HIGH;
unsigned long lastHeartbeat = 0;

void sendControl(uint8_t cmd) {
    udp.beginPacket(udpAddress, udpPort);
    udp.write(cmd); 
    udp.endPacket();
}

void init_i2s() {
    i2s_config_t i2s_config = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate = SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 8,
        .dma_buf_len = 512
    };
    i2s_pin_config_t pin_config = {
        .bck_io_num = I2S_SCK, .ws_io_num = I2S_WS, .data_out_num = -1, .data_in_num = I2S_SD
    };
    i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
    i2s_set_pin(I2S_PORT, &pin_config);
}

void setup() {
    Serial.begin(115200);
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    WiFi.begin(ssid, password);
    init_i2s();
}

void loop() {
    if (WiFi.status() != WL_CONNECTED) return;

    bool btn = digitalRead(BUTTON_PIN);
    if (lastButtonState == HIGH && btn == LOW) {
        isRecording = !isRecording;
        sendControl(isRecording ? 1 : 2);
        delay(200);
    }
    lastButtonState = btn;

    if (!isRecording && (millis() - lastHeartbeat > 2000)) {
        sendControl(9);
        lastHeartbeat = millis();
    }

    if (isRecording) {
        size_t read = 0;
        i2s_read(I2S_PORT, &udpBuffer[1], UDP_PACKET_SIZE, &read, 0);
        if (read > 0) {
            // Simple Hardware VAD: Only send if audio is above noise floor
            int16_t* samples = (int16_t*)&udpBuffer[1];
            int num_samples = read / 2;
            int16_t max_val = 0;
            for(int i=0; i<num_samples; i++) {
                if(abs(samples[i]) > max_val) max_val = abs(samples[i]);
            }

            if (max_val > 500) { // Threshold for INMP441
                udpBuffer[0] = 0;
                udp.beginPacket(udpAddress, udpPort);
                udp.write(udpBuffer, read + 1);
                udp.endPacket();
            }
        }
    }
}