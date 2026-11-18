# BloodGuard 🩸🛡️

BloodGuard is an end-to-end IoT monitoring system and full-stack dashboard designed to secure the medical cold chain. By combining real-time hardware telemetry with a WebSocket-driven backend, BloodGuard tracks environmental conditions, detects tampering, and manages inventory for sensitive medical supplies like blood bags.

## 🚀 Features

* **Real-Time Telemetry:** Streams live sensor data via a custom Arduino setup to a Flask backend over a Serial connection.
* **Event-Driven Dashboard:** Utilizes `Flask-SocketIO` to push real-time updates to the frontend, eliminating HTTP polling overhead.
* **Multi-Sensor Anomaly Detection:** Monitors Temperature, Gas (MQ-2), Light (LDR), Vibration, and IR Break-beam sensors to detect hardware degradation, compressor failure, or unauthorized access.
* **Client-Side Barcode Scanning:** Integrated `jsQR` for rapid inventory tracking directly from the browser.
* **Historical Logging:** Stores time-series data and critical alert events in an SQLite database for auditing and analytics.

## 🛠️ Tech Stack

* **Hardware Layer:** Arduino (C++), Temperature Sensor, MQ-2 Gas, Ultrasonic, LDR, Vibration, IR Break-beam.
* **Backend:** Python, Flask, Flask-SocketIO (WebSockets), SQLite, PySerial.
* **Frontend:** Vanilla HTML/CSS/JS, Chart.js (Live Graphs), jsQR.

## ⚙️ Local Setup

1. **Hardware Configuration:**
   * Flash the Arduino with the provided firmware.
   * Connect the Arduino to your machine via USB and note the COM/Serial port.

2. **Backend Setup:**
   ```bash
   # Clone the repository
   git clone https://github.com/Sreeharan-debug/bloodguard-hackathon.git
   cd bloodguard-hackathon

   # Create and activate a virtual environment
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate

   # Install dependencies
   pip install -r requirements.txt
   ```

3. **Configure and Run:**
   * Update the `SERIAL_PORT` variable in `app.py` to match your Arduino's port.
   * Start the server:
     ```bash
     python app.py
     ```
   * Open `http://localhost:5000` in your browser to view the live dashboard.

## 🔮 Future Roadmap
* **Predictive AI/ML:** Train an Isolation Forest model on historical telemetry to predict compressor failures before thermal limits are breached.
* **Database Migration:** Upgrade from SQLite to PostgreSQL for better concurrent read/write performance under heavy load.