/*
 * Smart Tamper-Proof Blood Storage Box — Arduino UNO Firmware
 * ============================================================
 * Pin Map:
 *   A0  — Temperature sensor (analog, 10mV/°C type like LM35 or TMP36)
 *   A1  — Water / leak sensor (analog)
 *   A2  — Moisture sensor (analog)
 *   A3  — LDR light sensor (analog, HIGH = bright)
 *   A4  — Gas / air-quality sensor (MQ-2 or MQ-135)
 *   A5  — Potentiometer (live tamper-sensitivity tuner)
 *   D2  — Vibration sensor (digital, LOW = triggered on most SW-420 modules)
 *   D3  — IR break-beam / IR obstacle sensor (LOW = object detected / beam broken)
 *   D4  — Arm / Disarm switch (HIGH = ARMED)
 *   D5  — Ultrasonic TRIG
 *   D6  — Ultrasonic ECHO
 *   D9  — Buzzer (active buzzer)
 *   D10 — Servo signal (box lock)
 *
 * Serial Protocol (9600 baud, LF-terminated):
 *   STATUS,<temp_C>,<gas_raw>,<distance_cm>,<vibration>,<light_raw>,<armed>
 *   EVENT,<source>,<detail>,<tamper_score>
 *   ACCESS,<detail>
 */

#include <Servo.h>

// ── Pin definitions ─────────────────────────────────────────────────────────
const int PIN_TEMP      = A0;
const int PIN_WATER     = A1;
const int PIN_MOISTURE  = A2;
const int PIN_LIGHT     = A3;
const int PIN_GAS       = A4;
const int PIN_POT       = A5;

const int PIN_VIBRATION = 2;
const int PIN_IR        = 3;
const int PIN_ARM       = 4;
const int PIN_TRIG      = 5;
const int PIN_ECHO      = 6;
const int PIN_BUZZER    = 9;
const int PIN_SERVO     = 10;

// ── Thresholds (tune after bench test) ──────────────────────────────────────
float TEMP_MIN         = 2.0;    // °C — blood storage lower bound
float TEMP_MAX         = 8.0;    // °C — blood storage upper bound
int   GAS_THRESHOLD    = 400;    // raw ADC — above = gas alert
int   DIST_BASELINE    = 15;     // cm — expected distance inside box
int   DIST_TOLERANCE   = 5;      // cm — allowable deviation
int   LIGHT_THRESHOLD  = 200;    // raw ADC — above = lid likely open (bright)

// ── State ────────────────────────────────────────────────────────────────────
Servo lockServo;
bool  wasArmed       = false;
bool  wasIrTriggered = false;
bool  wasVibration   = false;

const int LOCKED_ANGLE   = 90;
const int UNLOCKED_ANGLE = 0;

unsigned long lastStatusMs   = 0;
unsigned long lastTamperMs   = 0;
const unsigned long STATUS_INTERVAL  = 500;   // ms between STATUS lines
const unsigned long TAMPER_COOLDOWN  = 2000;  // ms between EVENT lines

// ── Setup ────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(9600);

  pinMode(PIN_VIBRATION, INPUT);
  pinMode(PIN_IR,        INPUT);
  pinMode(PIN_ARM,       INPUT);
  pinMode(PIN_TRIG,      OUTPUT);
  pinMode(PIN_ECHO,      INPUT);
  pinMode(PIN_BUZZER,    OUTPUT);

  lockServo.attach(PIN_SERVO);
  lockServo.write(UNLOCKED_ANGLE);
  digitalWrite(PIN_BUZZER, LOW);

  Serial.println("EVENT,SYSTEM,BOOT_OK,0");
}

// ── Helpers ──────────────────────────────────────────────────────────────────
float readTemperature() {
  int raw = analogRead(PIN_TEMP);
  // TMP36 / LM35 — adjust formula for your exact sensor:
  //   TMP36: voltage = (raw / 1023.0) * 5000 mV;  temp = (voltage - 500) / 10
  //   LM35:  voltage = (raw / 1023.0) * 5000 mV;  temp = voltage / 10
  float voltage = (raw / 1023.0) * 5000.0;
  return (voltage - 500.0) / 10.0;   // TMP36 formula
}

long readDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  long duration = pulseIn(PIN_ECHO, HIGH, 30000); // 30ms timeout
  if (duration == 0) return -1;
  return duration * 0.034 / 2;
}

int sensitivityFromPot() {
  // Potentiometer maps to a 0–100 sensitivity score offset
  return map(analogRead(PIN_POT), 0, 1023, 0, 100);
}

void buzz(int ms) {
  digitalWrite(PIN_BUZZER, HIGH);
  delay(ms);
  digitalWrite(PIN_BUZZER, LOW);
}

void sendEvent(const char* source, const char* detail, int score) {
  unsigned long now = millis();
  if (now - lastTamperMs < TAMPER_COOLDOWN) return;
  lastTamperMs = now;
  Serial.print("EVENT,");
  Serial.print(source);
  Serial.print(",");
  Serial.print(detail);
  Serial.print(",");
  Serial.println(score);
}

// ── Main loop ────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // ── Read sensors ──────────────────────────────────────────────────────────
  float temp     = readTemperature();
  int   gas      = analogRead(PIN_GAS);
  int   light    = analogRead(PIN_LIGHT);
  long  dist     = readDistanceCm();
  bool  vibTrig  = (digitalRead(PIN_VIBRATION) == LOW);  // SW-420: LOW = shake
  bool  irTrig   = (digitalRead(PIN_IR)        == LOW);  // LOW = beam broken
  bool  armed    = (digitalRead(PIN_ARM)        == HIGH);

  // ── Adjust thresholds live with potentiometer ──────────────────────────────
  int sensi = sensitivityFromPot();  // 0–100; higher = more sensitive

  // ── Arm / disarm transition ────────────────────────────────────────────────
  if (armed != wasArmed) {
    if (armed) {
      lockServo.write(LOCKED_ANGLE);
      Serial.println("ACCESS,SYSTEM_ARMED");
    } else {
      lockServo.write(UNLOCKED_ANGLE);
      Serial.println("ACCESS,AUTHORIZED_UNLOCK");
    }
    wasArmed = armed;
    buzz(100);
  }

  // ── Tamper checks (only when armed) ───────────────────────────────────────
  if (armed) {
    int score = 0;

    // IR beam broken → lid opened
    if (irTrig && !wasIrTriggered) {
      score = 70 + (sensi / 5);
      sendEvent("IR_SENSOR", "LID_OPEN_DETECTED", score);
      buzz(300);
    }
    wasIrTriggered = irTrig;

    // Vibration
    if (vibTrig && !wasVibration) {
      score = 40 + (sensi / 8);
      sendEvent("VIBRATION", "SHAKE_DETECTED", score);
      buzz(150);
    }
    wasVibration = vibTrig;

    // Light spike — lid open
    if (light > LIGHT_THRESHOLD) {
      score = 50 + (sensi / 6);
      sendEvent("LIGHT_SENSOR", "BRIGHT_LIGHT_INSIDE", score);
    }

    // Ultrasonic — unit missing / displaced
    if (dist > 0 && abs(dist - DIST_BASELINE) > DIST_TOLERANCE) {
      score = 85 + (sensi / 10);
      sendEvent("ULTRASONIC", "UNIT_POSITION_CHANGED", score);
    }

    // High gas
    if (gas > (GAS_THRESHOLD - sensi)) {
      sendEvent("GAS_SENSOR", "GAS_LEVEL_HIGH", 60);
    }

    // Temperature out of range
    if (temp < TEMP_MIN || temp > TEMP_MAX) {
      char detail[32];
      snprintf(detail, sizeof(detail), "TEMP_OUT_OF_RANGE_%.1fC", temp);
      sendEvent("TEMP_SENSOR", detail, 55);
    }
  }

  // ── Periodic STATUS line ──────────────────────────────────────────────────
  if (now - lastStatusMs >= STATUS_INTERVAL) {
    lastStatusMs = now;
    Serial.print("STATUS,");
    Serial.print(temp, 2);
    Serial.print(",");
    Serial.print(gas);
    Serial.print(",");
    Serial.print(dist);
    Serial.print(",");
    Serial.print(vibTrig ? 1 : 0);
    Serial.print(",");
    Serial.print(light);
    Serial.print(",");
    Serial.println(armed ? 1 : 0);
  }
}
