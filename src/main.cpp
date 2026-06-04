#include <WiFi.h>
#include <WiFiUdp.h>
#include <driver/i2s.h>
#include "esp_vad.h"

const char* ssid = "PTIT.HCM_SV";
const char* password = "";
const char* udpAddress = "10.241.9.158";
const int udpPort = 9000;

#define BUTTON_PIN 20
#define I2S_SD 46
#define I2S_WS 39
#define I2S_SCK 40
#define I2S_PORT I2S_NUM_0
#define SAMPLE_RATE 16000
#define UDP_PACKET_SIZE 1024

WiFiUDP udp;
QueueHandle_t audioQueue;
volatile bool systemActive = false; 

struct AudioPacket {
    uint8_t data[UDP_PACKET_SIZE + 1];
    size_t length;
};

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

void networkTask(void *pvParameters) {
    AudioPacket packet;
    unsigned long lastHeartbeat = 0;
    while (1) {
        if (WiFi.status() == WL_CONNECTED) {
            if (xQueueReceive(audioQueue, &packet, 5 / portTICK_PERIOD_MS) == pdPASS) {
                udp.beginPacket(udpAddress, udpPort);
                udp.write(packet.data, packet.length);
                udp.endPacket();
            }
            if (!systemActive && (millis() - lastHeartbeat > 2000)) {
                udp.beginPacket(udpAddress, udpPort);
                udp.write(9); // HEARTBEAT
                udp.endPacket();
                lastHeartbeat = millis();
            }
        }
        vTaskDelay(1);
    }
}

void audioTask(void *pvParameters) {
    AudioPacket currentPacket;
    vad_handle_t vad_inst = vad_create(VAD_MODE_3); 
    bool was_speaking = false;

    while (1) {
        if (systemActive) {
            size_t bytesRead = 0;
            i2s_read(I2S_PORT, &currentPacket.data[1], 320, &bytesRead, portMAX_DELAY);
            
            if (bytesRead > 0) {
                vad_state_t state = vad_process(vad_inst, (int16_t*)&currentPacket.data[1], SAMPLE_RATE, 10);
                
                if (state == VAD_SPEECH) {
                    if (!was_speaking) {
                        udp.beginPacket(udpAddress, udpPort);
                        udp.write(1); 
                        udp.endPacket();
                        was_speaking = true;
                    }
                    
                    currentPacket.data[0] = 0; // Audio Header
                    currentPacket.length = bytesRead + 1;
                    xQueueSend(audioQueue, &currentPacket, 0);
                } else {
                    if (was_speaking) {
                        udp.beginPacket(udpAddress, udpPort);
                        udp.write(2); 
                        udp.endPacket();
                        was_speaking = false;
                    }
                }
            }
        } else {
            vTaskDelay(50 / portTICK_PERIOD_MS);
        }
    }
}

void setup() {
    Serial.begin(115200);
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    WiFi.begin(ssid, password);
    init_i2s();
    audioQueue = xQueueCreate(20, sizeof(AudioPacket));
    xTaskCreate(networkTask, "Network", 4096, NULL, 2, NULL);
    xTaskCreate(audioTask, "Audio", 4096, NULL, 1, NULL); 
}

void loop() {
    static bool lastButtonState = HIGH;
    bool btn = digitalRead(BUTTON_PIN);
    if (lastButtonState == HIGH && btn == LOW) {
        systemActive = !systemActive; // Toggle "Listen" mode
        Serial.printf("System %s\n", systemActive ? "Active" : "Idle");
        vTaskDelay(200 / portTICK_PERIOD_MS);
    }
    lastButtonState = btn;
    vTaskDelay(10);
}