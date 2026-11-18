"""
app.py — Smart Tamper-Proof Blood Storage Box
Flask backend: serial reader thread, SQLite logging, REST API, QR generation.

Quick-start:
  1. pip install -r requirements.txt
  2. Set SERIAL_PORT below (e.g. "COM3" on Windows, "/dev/ttyUSB0" on Linux)
  3. Set SIMULATE = True to run without hardware
  4. python app.py
  5. Open http://localhost:5000
"""

import os, time, json, random, threading, sqlite3, io, base64, math
from datetime import datetime, timedelta
from functools import wraps
from flask import Flask, jsonify, render_template, request, send_file, abort, session, redirect, url_for
import qrcode
from PIL import Image

# ── Configuration ─────────────────────────────────────────────────────────────
SERIAL_PORT = "COM3"          # ← change to your Arduino's actual port
BAUD_RATE   = 9600
SIMULATE    = True            # True = fake data; False = real Arduino
DB_PATH     = "blood_bank.db"

# ── Flask app ─────────────────────────────────────────────────────────────────
app = Flask(__name__)
app.secret_key = "bloodguard_secure_2024_xK9mP"

# ── Staff credentials ─────────────────────────────────────────────────────────
STAFF_USERS = {
    "user123": "pass123",
}

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Unauthorized"}), 401
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated

# ── Shared state (thread-safe via lock) ───────────────────────────────────────
_lock = threading.Lock()
_status = {
    "temperature":  "--",
    "gas":          "--",
    "distance":     "--",
    "vibration":    0,
    "light":        "--",
    "armed":        False,
    "locked":       False,
    "connected":    False,
    "alert_active": False,
    "last_update":  None,
}

# ── Database ───────────────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ts          TEXT    NOT NULL,
            source      TEXT    NOT NULL,
            detail      TEXT    NOT NULL,
            score       INTEGER DEFAULT 0,
            event_type  TEXT    DEFAULT 'TAMPER'
        );

        CREATE TABLE IF NOT EXISTS status_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ts          TEXT    NOT NULL,
            temperature REAL,
            gas         INTEGER,
            distance    INTEGER,
            vibration   INTEGER,
            light       INTEGER,
            armed       INTEGER
        );

        CREATE TABLE IF NOT EXISTS blood_units (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            unit_id         TEXT    NOT NULL UNIQUE,
            blood_type      TEXT    NOT NULL,
            donor_name      TEXT    NOT NULL,
            donor_dob       TEXT,
            donor_id        TEXT,
            collection_date TEXT    NOT NULL,
            expiry_date     TEXT    NOT NULL,
            recipient_name  TEXT,
            recipient_id    TEXT,
            status          TEXT    DEFAULT 'STORED',
            location        TEXT    DEFAULT 'Chamber A',
            notes           TEXT,
            created_at      TEXT    NOT NULL
        );
    """)
    conn.commit()

    # Seed demo blood units if empty
    c.execute("SELECT COUNT(*) FROM blood_units")
    if c.fetchone()[0] == 0:
        now = datetime.utcnow()
        demo_units = [
            ("BU-2024-001", "O+",  "Rajesh Kumar",   "1985-03-12", "DID-1001",
             (now - timedelta(days=5)).strftime("%Y-%m-%d"),
             (now + timedelta(days=37)).strftime("%Y-%m-%d"),
             None, None, "STORED", "Chamber A", "Screened, ready"),
            ("BU-2024-002", "A-",  "Priya Sharma",   "1990-07-22", "DID-1002",
             (now - timedelta(days=2)).strftime("%Y-%m-%d"),
             (now + timedelta(days=40)).strftime("%Y-%m-%d"),
             "Arjun Mehta", "RID-2001", "TRANSFUSED", "Chamber A",
             "Transfused successfully"),
            ("BU-2024-003", "B+",  "Sunita Patel",   "1978-11-05", "DID-1003",
             (now - timedelta(days=38)).strftime("%Y-%m-%d"),
             (now + timedelta(days=4)).strftime("%Y-%m-%d"),
             None, None, "STORED", "Chamber B", "Nearing expiry — prioritize"),
            ("BU-2024-004", "AB+", "Mohammed Farhan","1995-01-30", "DID-1004",
             (now - timedelta(days=1)).strftime("%Y-%m-%d"),
             (now + timedelta(days=41)).strftime("%Y-%m-%d"),
             None, None, "STORED", "Chamber A", ""),
            ("BU-2024-005", "O-",  "Deepa Nair",     "1988-09-15", "DID-1005",
             (now - timedelta(days=10)).strftime("%Y-%m-%d"),
             (now + timedelta(days=32)).strftime("%Y-%m-%d"),
             None, None, "QUARANTINE", "Chamber C", "Pending cross-match"),
        ]
        c.executemany("""
            INSERT INTO blood_units
              (unit_id,blood_type,donor_name,donor_dob,donor_id,
               collection_date,expiry_date,recipient_name,recipient_id,
               status,location,notes,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, [(*u, now.isoformat()) for u in demo_units])
        conn.commit()
    conn.close()

def log_event(source, detail, score, event_type="TAMPER"):
    ts = datetime.utcnow().isoformat()
    conn = get_db()
    conn.execute(
        "INSERT INTO events (ts,source,detail,score,event_type) VALUES (?,?,?,?,?)",
        (ts, source, detail, score, event_type)
    )
    conn.commit()
    conn.close()
    with _lock:
        if event_type == "TAMPER" and score > 50:
            _status["alert_active"] = True

def log_status(temp, gas, distance, vibration, light, armed):
    ts = datetime.utcnow().isoformat()
    conn = get_db()
    conn.execute(
        """INSERT INTO status_log
           (ts,temperature,gas,distance,vibration,light,armed)
           VALUES (?,?,?,?,?,?,?)""",
        (ts, temp, gas, distance, vibration, light, 1 if armed else 0)
    )
    conn.commit()
    conn.close()

# ── Serial reader thread ───────────────────────────────────────────────────────
def parse_status(line):
    """STATUS,<temp>,<gas>,<dist>,<vib>,<light>,<armed>"""
    try:
        parts = line.strip().split(",")
        if len(parts) < 7:
            return
        temp     = float(parts[1])
        gas      = int(parts[2])
        dist     = int(parts[3])
        vib      = int(parts[4])
        light    = int(parts[5])
        armed    = parts[6].strip() == "1"
        with _lock:
            _status.update({
                "temperature":  round(temp, 2),
                "gas":          gas,
                "distance":     dist,
                "vibration":    vib,
                "light":        light,
                "armed":        armed,
                "locked":       armed,
                "last_update":  datetime.utcnow().isoformat(),
            })
        log_status(temp, gas, dist, vib, light, armed)
    except Exception as e:
        print(f"[PARSE] status error: {e}")

def parse_event(line):
    """EVENT,<source>,<detail>,<score>"""
    try:
        parts = line.strip().split(",", 3)
        if len(parts) < 4:
            return
        source = parts[1]
        detail = parts[2]
        score  = int(parts[3])
        etype  = "SYSTEM" if source == "SYSTEM" else "TAMPER"
        log_event(source, detail, score, etype)
    except Exception as e:
        print(f"[PARSE] event error: {e}")

def parse_access(line):
    """ACCESS,<detail>"""
    try:
        detail = line.strip().split(",", 1)[1]
        etype  = "ACCESS"
        log_event("ACCESS_CONTROL", detail, 0, etype)
        with _lock:
            if detail == "SYSTEM_ARMED":
                _status["armed"]  = True
                _status["locked"] = True
            elif detail == "AUTHORIZED_UNLOCK":
                _status["armed"]  = False
                _status["locked"] = False
                _status["alert_active"] = False
    except Exception as e:
        print(f"[PARSE] access error: {e}")

def serial_reader():
    """Background thread: reads Arduino serial port."""
    try:
        import serial
        ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
        print(f"[SERIAL] Connected on {SERIAL_PORT}")
        with _lock:
            _status["connected"] = True
        while True:
            line = ser.readline().decode("utf-8", errors="replace").strip()
            if not line:
                continue
            if line.startswith("STATUS,"):
                parse_status(line)
            elif line.startswith("EVENT,"):
                parse_event(line)
            elif line.startswith("ACCESS,"):
                parse_access(line)
    except Exception as e:
        print(f"[SERIAL] Error: {e}")
        with _lock:
            _status["connected"] = False

# ── Simulation thread ──────────────────────────────────────────────────────────
def simulate_reader():
    """Generates realistic fake sensor data when SIMULATE = True."""
    t = 0
    base_temp   = 4.5   # centre of safe range
    armed_state = False
    print("[SIM] Simulation mode active — no hardware needed")
    with _lock:
        _status["connected"] = True

    while True:
        t += 1
        time.sleep(0.5)

        # Slow oscillation for temperature
        temp  = round(base_temp + 1.5 * math.sin(t / 40) + random.uniform(-0.1, 0.1), 2)
        gas   = int(150 + 80 * abs(math.sin(t / 30)) + random.randint(-20, 20))
        dist  = int(14 + random.randint(-2, 2))
        vib   = 1 if random.random() < 0.04 else 0
        light = int(80 + random.randint(-30, 30))

        # Toggle armed every ~60 s
        if t % 120 == 0:
            armed_state = not armed_state
            detail = "SYSTEM_ARMED" if armed_state else "AUTHORIZED_UNLOCK"
            parse_access(f"ACCESS,{detail}")

        with _lock:
            _status.update({
                "temperature":  temp,
                "gas":          gas,
                "distance":     dist,
                "vibration":    vib,
                "light":        light,
                "armed":        armed_state,
                "locked":       armed_state,
                "last_update":  datetime.utcnow().isoformat(),
            })
        log_status(temp, gas, dist, vib, light, armed_state)

        # Random tamper events
        r = random.random()
        if armed_state:
            if r < 0.008:
                parse_event("EVENT,IR_SENSOR,LID_OPEN_DETECTED,72")
            elif r < 0.015:
                parse_event("EVENT,VIBRATION,SHAKE_DETECTED,45")
            elif r < 0.018:
                parse_event("EVENT,ULTRASONIC,UNIT_POSITION_CHANGED,88")
            elif r < 0.022:
                parse_event("EVENT,TEMP_SENSOR,TEMP_OUT_OF_RANGE_9.3C,55")
            elif r < 0.025:
                parse_event("EVENT,GAS_SENSOR,GAS_LEVEL_HIGH,60")

# ── REST API ──────────────────────────────────────────────────────────────────
@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "").strip()
        if STAFF_USERS.get(username) == password:
            session["logged_in"] = True
            session["username"] = username
            return redirect(url_for("index"))
        error = "Invalid credentials. Please try again."
    return render_template("login.html", error=error)

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))

@app.route("/")
@login_required
def index():
    from flask import make_response
    resp = make_response(render_template("dashboard.html", username=session.get("username", "Staff")))
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"]        = "no-cache"
    resp.headers["Expires"]       = "0"
    return resp

@app.route("/api/status")
@login_required
def api_status():
    with _lock:
        data = dict(_status)
    return jsonify(data)

@app.route("/api/logs")
@login_required
def api_logs():
    limit  = int(request.args.get("limit",  50))
    offset = int(request.args.get("offset", 0))
    conn   = get_db()
    rows   = conn.execute(
        "SELECT * FROM events ORDER BY id DESC LIMIT ? OFFSET ?",
        (limit, offset)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route("/api/history")
@login_required
def api_history():
    """Returns last N status_log rows for chart rendering."""
    points = int(request.args.get("points", 60))
    conn   = get_db()
    rows   = conn.execute(
        "SELECT ts,temperature,gas,distance,light FROM status_log ORDER BY id DESC LIMIT ?",
        (points,)
    ).fetchall()
    conn.close()
    rows = list(reversed(rows))
    return jsonify([dict(r) for r in rows])

@app.route("/api/chambers/status")
@login_required
def api_chambers_status():
    with _lock:
        a_status = dict(_status)
    
    def parse_float(v, offset=0.0):
        try:
            return round(float(v) + offset, 2)
        except (ValueError, TypeError):
            return None

    def parse_int(v, scale=1.0, offset=0):
        try:
            return int(int(v) * scale + offset)
        except (ValueError, TypeError):
            return None

    temp_a = parse_float(a_status.get("temperature"))
    gas_a = parse_int(a_status.get("gas"))
    dist_a = parse_int(a_status.get("distance"))
    light_a = parse_int(a_status.get("light"))

    conn = get_db()
    counts = {
        "Chamber A": conn.execute("SELECT COUNT(*) FROM blood_units WHERE location='Chamber A' AND status='STORED'").fetchone()[0],
        "Chamber B": conn.execute("SELECT COUNT(*) FROM blood_units WHERE location='Chamber B' AND status='STORED'").fetchone()[0],
        "Chamber C": conn.execute("SELECT COUNT(*) FROM blood_units WHERE location='Chamber C' AND status='STORED'").fetchone()[0]
    }
    conn.close()

    return jsonify({
        "A": {
            "temperature": temp_a,
            "gas": gas_a,
            "distance": dist_a,
            "light": light_a,
            "count": counts["Chamber A"],
            "status": "NORMAL" if (temp_a is not None and 2 <= temp_a <= 8) else "ALERT"
        },
        "B": {
            "temperature": parse_float(temp_a, 0.4),
            "gas": parse_int(gas_a, 0.95),
            "distance": parse_int(dist_a, 1.0, -2),
            "light": parse_int(light_a, 0.9),
            "count": counts["Chamber B"],
            "status": "NORMAL" if (temp_a is not None and 2 <= temp_a + 0.4 <= 8) else "ALERT"
        },
        "C": {
            "temperature": parse_float(temp_a, -0.3),
            "gas": parse_int(gas_a, 1.05),
            "distance": parse_int(dist_a, 1.0, 1),
            "light": parse_int(light_a, 1.1),
            "count": counts["Chamber C"],
            "status": "NORMAL" if (temp_a is not None and 2 <= temp_a - 0.3 <= 8) else "ALERT"
        }
    })

@app.route("/api/units", methods=["GET"])
@login_required
def api_units():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM blood_units ORDER BY expiry_date ASC"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route("/api/units", methods=["POST"])
@login_required
def api_add_unit():
    data = request.get_json(force=True)
    required = ["unit_id", "blood_type", "donor_name", "collection_date", "expiry_date"]
    for field in required:
        if not data.get(field):
            abort(400, description=f"Missing field: {field}")
    now = datetime.utcnow().isoformat()
    conn = get_db()
    try:
        conn.execute("""
            INSERT INTO blood_units
              (unit_id,blood_type,donor_name,donor_dob,donor_id,
               collection_date,expiry_date,recipient_name,recipient_id,
               status,location,notes,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            data["unit_id"], data["blood_type"], data["donor_name"],
            data.get("donor_dob",""), data.get("donor_id",""),
            data["collection_date"], data["expiry_date"],
            data.get("recipient_name",""), data.get("recipient_id",""),
            data.get("status","STORED"), data.get("location","Chamber A"),
            data.get("notes",""), now
        ))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        abort(409, description="Unit ID already exists")
    conn.close()
    return jsonify({"success": True}), 201

@app.route("/api/units/<unit_id>", methods=["PATCH"])
@login_required
def api_update_unit(unit_id):
    data   = request.get_json(force=True)
    conn   = get_db()
    row    = conn.execute("SELECT * FROM blood_units WHERE unit_id=?", (unit_id,)).fetchone()
    if not row:
        conn.close()
        abort(404)
    allowed = ["recipient_name","recipient_id","status","location","notes"]
    sets    = ", ".join(f"{k}=?" for k in allowed if k in data)
    vals    = [data[k] for k in allowed if k in data]
    if sets:
        conn.execute(f"UPDATE blood_units SET {sets} WHERE unit_id=?", (*vals, unit_id))
        conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route("/api/units/<unit_id>/qr")
@login_required
def api_unit_qr(unit_id):
    """Returns a PNG QR code for the given blood unit."""
    conn = get_db()
    row  = conn.execute("SELECT * FROM blood_units WHERE unit_id=?", (unit_id,)).fetchone()
    conn.close()
    if not row:
        abort(404)
    row = dict(row)
    payload = (
        f"BLOOD_UNIT:{row['unit_id']}\n"
        f"Type:{row['blood_type']}\n"
        f"Donor:{row['donor_name']}\n"
        f"DonorID:{row['donor_id']}\n"
        f"Collected:{row['collection_date']}\n"
        f"Expires:{row['expiry_date']}\n"
        f"Recipient:{row['recipient_name'] or 'Unassigned'}\n"
        f"Status:{row['status']}"
    )
    qr = qrcode.QRCode(version=1, error_correction=qrcode.constants.ERROR_CORRECT_H,
                        box_size=6, border=3)
    qr.add_data(payload)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#C0392B", back_color="white")
    buf = io.BytesIO()
    # pyrefly: ignore [unexpected-keyword]
    img.save(buf, format="PNG")
    buf.seek(0)
    return send_file(buf, mimetype="image/png")

@app.route("/api/alert/clear", methods=["POST"])
@login_required
def api_clear_alert():
    with _lock:
        _status["alert_active"] = False
    return jsonify({"success": True})

@app.route("/api/stats")
@login_required
def api_stats():
    conn = get_db()
    total    = conn.execute("SELECT COUNT(*) FROM blood_units").fetchone()[0]
    stored   = conn.execute("SELECT COUNT(*) FROM blood_units WHERE status='STORED'").fetchone()[0]
    expiring = conn.execute(
        "SELECT COUNT(*) FROM blood_units WHERE status='STORED' AND expiry_date <= date('now','+7 days')"
    ).fetchone()[0]
    tampers  = conn.execute(
        "SELECT COUNT(*) FROM events WHERE event_type='TAMPER' AND ts >= datetime('now','-24 hours')"
    ).fetchone()[0]
    conn.close()
    return jsonify({
        "total_units": total,
        "stored_units": stored,
        "expiring_soon": expiring,
        "tampers_24h": tampers,
    })

# ── Staff access API ──────────────────────────────────────────────────────────
@app.route("/api/staff/log", methods=["GET"])
@login_required
def api_staff_log():
    """Return staff access records (ACCESS events with extra metadata)."""
    limit = int(request.args.get("limit", 100))
    conn  = get_db()
    rows  = conn.execute(
        "SELECT * FROM events WHERE event_type='ACCESS' ORDER BY id DESC LIMIT ?",
        (limit,)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route("/api/staff/checkin", methods=["POST"])
@login_required
def api_staff_checkin():
    """Log a staff chamber access event."""
    data      = request.get_json(force=True)
    staff     = data.get("staff_name", "").strip()
    chamber   = data.get("chamber", "").strip()
    unit_id   = data.get("unit_id", "").strip()
    action    = data.get("action", "ACCESSED").strip()
    if not staff or not chamber:
        return jsonify({"error": "staff_name and chamber are required"}), 400
    # Validate unit_id exists if provided
    if unit_id:
        conn = get_db()
        row  = conn.execute("SELECT unit_id FROM blood_units WHERE unit_id=?", (unit_id,)).fetchone()
        conn.close()
        if not row:
            return jsonify({"error": f"Unit {unit_id} not found in inventory"}), 404
    detail = f"Staff:{staff} | Chamber:{chamber} | Unit:{unit_id or 'N/A'} | Action:{action}"
    log_event("STAFF", detail, 0, event_type="ACCESS")
    return jsonify({"success": True, "detail": detail})

# ── Main ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    init_db()
    if SIMULATE:
        t = threading.Thread(target=simulate_reader, daemon=True)
    else:
        t = threading.Thread(target=serial_reader, daemon=True)
    t.start()
    # Brief warmup so first API calls have data
    time.sleep(1)
    app.run(host="0.0.0.0", port=5000, debug=False)
