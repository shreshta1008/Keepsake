/*
  Keepsake Bag firmware: ESP32-S3 + DRV2605L haptic driver + ERM motor, over Bluetooth LE.

  Commands (plain text, over Bluetooth or typed into the Serial Monitor at 115200):
    tap        double pulse      (a memory opened)
    single     one pulse         (sealed, passed down, replied, paired)
    strong     two long pulses
    alert      repeats until "stop", a new command, or ALERT_MAX_MS (a memory waits here)
    alert:<s>  same, but stops by itself after <s> seconds (1 to 600)
    stop       stops whatever is playing, right away
    fx:<n>     DRV2605L library effect n (1 to 123), once
    power:<n>  pulse strength from 1 to 127 (127 = full drive), until the bag restarts

  Why it's stronger than before: short "click" effects are a few tens of milliseconds long and get lost
  in leather. Pulses here drive the motor at full strength in real-time mode for ~0.4 s, which the
  body feels far more easily. DRIVE_MILLIVOLTS sets how hard "full" is (see the warning there).

  Nothing here blocks: patterns are timed with millis(), so "stop" works mid-pulse.
*/

#include <Wire.h>
#include <Adafruit_DRV2605.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

// ---------- Settings ----------

// ESP32-S3 I2C pins (match your wiring)
#define SDA_PIN 1
#define SCL_PIN 2

// Name the phone sees when it scans. Keep it in step with keepsake.config.js in the app.
#define BAG_NAME "Keepsake Bag"

// Our own service and characteristic IDs. Keep these the same in the phone app.
#define SERVICE_UUID   "6e1a0001-4b6f-4d8e-9a53-0c2f6b7a1e10"
#define BOOP_CHAR_UUID "6e1a0002-4b6f-4d8e-9a53-0c2f6b7a1e10"

// Peak voltage the DRV2605L drives the motor with at full strength (open-loop ERM).
// The chip's own default is about 3000 mV. WARNING: check your motor's rated voltage and don't go
// above it. Many coin ERMs are rated 3.0 V; some (e.g. 2-5 V "mini motor discs") take 3.6 V or more.
// The output can't exceed the battery voltage either (about 3.7 V on a LiPo).
#define DRIVE_MILLIVOLTS 3000

// Longest an "alert" repeats when nobody stops it, so a forgotten alert can't drain the battery.
#define ALERT_MAX_MS 120000UL

// Strength of each pulse, 1 to 127 (127 = full drive). "power:<n>" changes it until restart.
uint8_t strength = 127;

Adafruit_DRV2605 drv;

// ---------- Patterns ----------
// A pattern is a list of steps: run the motor at `level` (0 = off, 255 = "strength") for `ms`.

struct Step { uint8_t level; uint16_t ms; };
const uint8_t ON = 255;   // "the current strength"
const uint8_t OFF = 0;

const Step P_SINGLE[] = { {ON, 350} };
const Step P_TAP[]    = { {ON, 220}, {OFF, 140}, {ON, 220} };
const Step P_STRONG[] = { {ON, 450}, {OFF, 180}, {ON, 450} };
// Alert: two long pulses, then a pause, over and over. Easy to feel through leather, easy to tell apart.
const Step P_ALERT[]  = { {ON, 450}, {OFF, 160}, {ON, 450}, {OFF, 1400} };

#define COUNT(a) (sizeof(a) / sizeof((a)[0]))

const Step *steps = nullptr;   // pattern now playing (nullptr = idle)
uint8_t stepCount = 0;
uint8_t stepIndex = 0;
uint32_t stepStartedAt = 0;
bool repeating = false;
uint32_t repeatStartedAt = 0;
uint32_t repeatForMs = 0;
bool effectPlaying = false;    // an fx:<n> library effect is running

// ---------- Motor ----------

void motor(uint8_t level) {
  uint8_t value = (level == ON) ? strength : level;
  if (value > 127) value = 127;  // real-time mode takes 0 to 127 (signed data format)
  drv.setRealtimeValue(value);
}

void enterRealtime() {
  if (effectPlaying) { drv.stop(); effectPlaying = false; }
  drv.setMode(DRV2605_MODE_REALTIME);
}

void stopAll() {
  steps = nullptr;
  repeating = false;
  drv.setRealtimeValue(0);
  drv.stop();
  drv.setMode(DRV2605_MODE_INTTRIG);
  effectPlaying = false;
}

// Start a pattern now. It replaces whatever was playing, including an alert.
void play(const Step *pattern, uint8_t count, bool repeat = false, uint32_t repeatMs = 0) {
  enterRealtime();
  steps = pattern;
  stepCount = count;
  stepIndex = 0;
  stepStartedAt = millis();
  repeating = repeat;
  repeatStartedAt = stepStartedAt;
  repeatForMs = repeatMs;
  motor(steps[0].level);
}

void playEffect(uint8_t effect) {
  stopAll();
  drv.setMode(DRV2605_MODE_INTTRIG);
  drv.setWaveform(0, effect);
  drv.setWaveform(1, 0);
  drv.go();
  effectPlaying = true;
}

// Called every loop(): moves the pattern on when a step's time is up.
void updatePattern() {
  if (!steps) return;
  uint32_t now = millis();
  if (now - stepStartedAt < steps[stepIndex].ms) return;
  stepIndex++;
  if (stepIndex >= stepCount) {
    if (repeating && now - repeatStartedAt < repeatForMs) {
      stepIndex = 0;
    } else {
      if (repeating) Serial.println("[ALERT] Stopped by itself (time limit)");
      stopAll();
      Serial.println("[READY] Waiting for command...");
      return;
    }
  }
  stepStartedAt = now;
  motor(steps[stepIndex].level);
}

// ---------- Commands ----------

// One place that handles a command, whether it came from USB or Bluetooth.
void runCommand(String command) {
  command.trim();
  command.toLowerCase();
  if (command.length() == 0) return;

  if (command == "tap") {
    Serial.println("[HAPTIC] Tap (double pulse)");
    play(P_TAP, COUNT(P_TAP));
  } else if (command == "single") {
    Serial.println("[HAPTIC] Single pulse");
    play(P_SINGLE, COUNT(P_SINGLE));
  } else if (command == "strong") {
    Serial.println("[HAPTIC] Strong (two long pulses)");
    play(P_STRONG, COUNT(P_STRONG));
  } else if (command == "alert" || command.startsWith("alert:")) {
    uint32_t ms = ALERT_MAX_MS;
    if (command.startsWith("alert:")) {
      long seconds = command.substring(6).toInt();
      if (seconds < 1 || seconds > 600) { Serial.println("[ERROR] alert:<seconds> takes 1 to 600"); return; }
      ms = (uint32_t)seconds * 1000UL;
    }
    Serial.print("[ALERT] Buzzing until stopped (at most ");
    Serial.print(ms / 1000);
    Serial.println(" s)");
    play(P_ALERT, COUNT(P_ALERT), true, ms);
  } else if (command == "stop") {
    Serial.println("[HAPTIC] Stop");
    stopAll();
  } else if (command.startsWith("fx:")) {
    int id = command.substring(3).toInt();
    if (id >= 1 && id <= 123) {
      Serial.print("[HAPTIC] Effect ");
      Serial.println(id);
      playEffect((uint8_t)id);
    } else {
      Serial.println("[ERROR] Effect must be 1 to 123");
    }
  } else if (command.startsWith("power:")) {
    int p = command.substring(6).toInt();
    if (p >= 1 && p <= 127) {
      strength = (uint8_t)p;
      Serial.print("[HAPTIC] Strength set to ");
      Serial.println(strength);
      play(P_SINGLE, COUNT(P_SINGLE));  // so you can feel the new strength
    } else {
      Serial.println("[ERROR] power:<n> takes 1 to 127");
    }
  } else {
    Serial.print("[ERROR] Unknown command: ");
    Serial.println(command);
  }
}

// ---------- Bluetooth ----------
// Writes arrive on the Bluetooth task. They wait in a small queue until loop() runs them, so a
// "stop" sent right after "alert" is never dropped.

const uint8_t QUEUE_SIZE = 6;
char queue[QUEUE_SIZE][32];
volatile uint8_t queueHead = 0, queueTail = 0;
portMUX_TYPE queueLock = portMUX_INITIALIZER_UNLOCKED;

void enqueue(const char *text) {
  portENTER_CRITICAL(&queueLock);
  uint8_t next = (queueTail + 1) % QUEUE_SIZE;
  if (next != queueHead) {  // when full, the newest command is dropped
    strncpy(queue[queueTail], text, sizeof(queue[0]) - 1);
    queue[queueTail][sizeof(queue[0]) - 1] = '\0';
    queueTail = next;
  }
  portEXIT_CRITICAL(&queueLock);
}

bool dequeue(char *out) {
  bool got = false;
  portENTER_CRITICAL(&queueLock);
  if (queueHead != queueTail) {
    strcpy(out, queue[queueHead]);
    queueHead = (queueHead + 1) % QUEUE_SIZE;
    got = true;
  }
  portEXIT_CRITICAL(&queueLock);
  return got;
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) {
    Serial.println("[BLE] Phone connected");
  }
  void onDisconnect(BLEServer *server) {
    // An alert keeps going (up to its time limit): the phone may only have dropped out of range.
    Serial.println("[BLE] Phone disconnected, advertising again");
    BLEDevice::startAdvertising();
  }
};

class BoopCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) {
    String value = String(characteristic->getValue().c_str());
    value.trim();
    if (value.length() == 0) return;
    enqueue(value.c_str());
  }
};

// ---------- Setup and loop ----------

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(50);  // a typed command arrives in a few ms; don't stall patterns waiting for more
  delay(2000);

  Serial.println();
  Serial.println("==========================");
  Serial.println(" KEEPSAKE BAG: HAPTIC + BLE");
  Serial.println("==========================");

  Wire.begin(SDA_PIN, SCL_PIN);

  if (!drv.begin(&Wire)) {
    Serial.println("[ERROR] DRV2605L not found! Check the Qwiic cable.");
    while (1) delay(1000);
  }
  Serial.println("[SUCCESS] DRV2605L connected!");

  drv.selectLibrary(1);
  drv.useERM();
  // Open-loop ERM (the chip's default for ERM): real-time values map straight to drive voltage.
  drv.writeRegister8(DRV2605_REG_CONTROL3, drv.readRegister8(DRV2605_REG_CONTROL3) | 0x20);
  // Full-strength drive voltage: about 21.3 mV per step in open-loop ERM mode.
  uint32_t clamp = (uint32_t)DRIVE_MILLIVOLTS * 100UL / 2132UL;
  if (clamp > 255) clamp = 255;
  drv.writeRegister8(DRV2605_REG_CLAMPV, (uint8_t)clamp);
  drv.setMode(DRV2605_MODE_INTTRIG);
  Serial.print("[READY] Haptic motor ready, full drive about ");
  Serial.print(DRIVE_MILLIVOLTS);
  Serial.println(" mV");

  // Start Bluetooth and advertise as the bag
  BLEDevice::init(BAG_NAME);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService *service = server->createService(SERVICE_UUID);
  BLECharacteristic *boop = service->createCharacteristic(
      BOOP_CHAR_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  boop->setCallbacks(new BoopCallbacks());
  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();

  Serial.print("[BLE] Advertising as: ");
  Serial.println(BAG_NAME);
  Serial.println();
  Serial.println("Commands: tap, single, strong, alert, alert:<s>, stop, fx:<1-123>, power:<1-127>");

  play(P_SINGLE, COUNT(P_SINGLE));  // one pulse: the bag is on
}

void loop() {
  // Commands from Bluetooth, oldest first
  char command[32];
  while (dequeue(command)) {
    Serial.print("[BLE] Received: ");
    Serial.println(command);
    runCommand(String(command));
  }

  // Command typed over USB (still works)
  if (Serial.available() > 0) {
    runCommand(Serial.readStringUntil('\n'));
  }

  updatePattern();
  delay(5);  // plenty fine for timing, and lets the Bluetooth task breathe
}
