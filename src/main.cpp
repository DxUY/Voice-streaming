#include <WiFi.h>
#include <WiFiUdp.h>
#include <driver/i2s.h>

const char* ssid = "NguyenQuynh";
const char* password = "Quynh@123";
const char* udpAddress = "192.168.68.112";
const int udpPort = 9000;

#define BUTTON_PIN 4

#define I2S_SD  13
#define I2S_WS  11
#define I2S_SCK 12
#define I2S_PORT I2S_NUM_0

#define SAMPLE_RATE 16000
#define UDP_PACKET_SIZE 1024

uint8_t udpBuffer[UDP_PACKET_SIZE];

WiFiUDP udp;

bool isRecording = false;
bool lastButtonState = HIGH;

void init_i2s()
{
    const i2s_config_t i2s_config = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate = SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 8,
        .dma_buf_len = 512,
        .use_apll = false,
        .tx_desc_auto_clear = true,
        .fixed_mclk = 0
    };

    const i2s_pin_config_t pin_config = {
        .bck_io_num = I2S_SCK,
        .ws_io_num = I2S_WS,
        .data_out_num = -1,
        .data_in_num = I2S_SD
    };

    i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
    i2s_set_pin(I2S_PORT, &pin_config);
    i2s_start(I2S_PORT);
}

void setup()
{
    Serial.begin(115200);

    pinMode(BUTTON_PIN, INPUT_PULLUP);

    WiFi.begin(ssid, password);
    while (WiFi.status() != WL_CONNECTED)
    {
        delay(500);
        Serial.print(".");
    }

    init_i2s();

    Serial.println("\n[SYSTEM] LINK READY");
}

void loop()
{
    bool currentButtonState = digitalRead(BUTTON_PIN);

    if (lastButtonState == HIGH && currentButtonState == LOW)
    {
        isRecording = !isRecording;
        Serial.println(isRecording ? "\n[REC START]" : "\n[REC STOP]");
        delay(250); // debounce
    }

    lastButtonState = currentButtonState;

    if (isRecording)
    {
        size_t bytesRead = 0;

        esp_err_t res = i2s_read(
            I2S_PORT,
            udpBuffer,
            UDP_PACKET_SIZE,
            &bytesRead,
            20
        );

        if (res == ESP_OK && bytesRead > 0)
        {
            udp.beginPacket(udpAddress, udpPort);
            udp.write(udpBuffer, bytesRead);
            udp.endPacket();

            static int dotCount = 0;
            if (++dotCount % 50 == 0)
                Serial.print(".");
        }
    }
    else
    {
        size_t discarded = 0;
        i2s_read(I2S_PORT, udpBuffer, UDP_PACKET_SIZE, &discarded, 1);
    }
}