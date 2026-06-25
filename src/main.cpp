#include <WiFi.h>
#include <WiFiUdp.h>
#include <driver/i2s.h>

const char* ssid = "PTIT.HCM_SV";
const char* password = "";
const char* udpAddress = "10.241.7.167";
const int udpPort = 9000;

#define BUTTON_PIN 20
#define I2S_SD 46
#define I2S_WS 39
#define I2S_SCK 40
#define I2S_PORT I2S_NUM_0
#define SAMPLE_RATE 16000
#define UDP_PACKET_SIZE 1024
#define ENERGY_THRESHOLD 500 

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
    if (i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL) != ESP_OK) Serial.println("I2S Driver ERR");
    if (i2s_set_pin(I2S_PORT, &pin_config) != ESP_OK) Serial.println("I2S Pins ERR");
    else Serial.println("I2S Initialized.");
}

void networkTask(void *pvParameters) {
    AudioPacket packet;
    unsigned long lastHeartbeat = 0;
    
    while (1) {
        if (WiFi.status() == WL_CONNECTED) {
            // --- HEARTBEAT LOGIC: Re-announce every 2000ms ---
            if (millis() - lastHeartbeat > 2000) {
                udp.beginPacket(udpAddress, udpPort);
                udp.write(9); // Handshake signal
                udp.endPacket();
                lastHeartbeat = millis();
            }

            // Process audio packets from the queue
            if (xQueueReceive(audioQueue, &packet, 5 / portTICK_PERIOD_MS) == pdPASS) {
                if (udp.beginPacket(udpAddress, udpPort)) {
                    udp.write(packet.data, packet.length);
                    udp.endPacket();
                }
            }
        } else {
            static unsigned long last_warn = 0;
            if (millis() - last_warn > 3000) {
                Serial.printf("WiFi Status: %d\n", WiFi.status());
                last_warn = millis();
                WiFi.disconnect();
                WiFi.begin(ssid, password);
            }
        }
        vTaskDelay(1);
    }
}

void audioTask(void *pvParameters) {
    AudioPacket currentPacket;
    bool was_speaking = false;
    while (1) {
        if (systemActive) {
            size_t bytesRead = 0;
            i2s_read(I2S_PORT, &currentPacket.data[1], 320, &bytesRead, portMAX_DELAY);
            if (bytesRead > 0) {
                int16_t *samples = (int16_t*)&currentPacket.data[1];
                long sum = 0;
                for (int i = 0; i < (bytesRead/2); i++) sum += abs(samples[i]);
                int avg = sum / (bytesRead/2);
                
                if (avg > ENERGY_THRESHOLD) {
                    if (!was_speaking) { udp.beginPacket(udpAddress, udpPort); udp.write(1); udp.endPacket(); was_speaking = true; }
                    currentPacket.data[0] = 0; currentPacket.length = bytesRead + 1;
                    xQueueSend(audioQueue, &currentPacket, 0);
                } else if (was_speaking) { udp.beginPacket(udpAddress, udpPort); udp.write(2); udp.endPacket(); was_speaking = false; }
            }
        }
        vTaskDelay(1);
    }
}

void setup() {
    Serial.begin(115200);
    delay(2000);
    Serial.println("\n--- STARTING DIAGNOSTIC BOOT ---");
    
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, password);
    
    int timeout = 0;
    while (WiFi.status() != WL_CONNECTED && timeout < 30) {
        delay(500); Serial.print("."); timeout++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\nWiFi Connected Successfully!");
    } else {
        Serial.println("\nWiFi FAILED.");
    }

    init_i2s();
    audioQueue = xQueueCreate(20, sizeof(AudioPacket));
    xTaskCreate(networkTask, "Network", 8192, NULL, 2, NULL);
    xTaskCreate(audioTask, "Audio", 8192, NULL, 1, NULL); 
}

void loop() {
    static bool lastBtn = HIGH;
    bool btn = digitalRead(BUTTON_PIN);
    if (lastBtn == HIGH && btn == LOW) {
        systemActive = !systemActive;
        Serial.printf("System Toggled: %s\n", systemActive ? "Active" : "Idle");
        delay(200);
    }
    lastBtn = btn;
    delay(10);
}