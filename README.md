# Delta Exchange Real-Time Bitcoin & Ethereum Straddle Matrix

A high-frequency, real-time options analytics terminal and side-by-side **Strike & Straddle Matrix** for **Bitcoin (BTC)** and **Ethereum (ETH)**, powered by Delta Exchange WebSocket and REST API v2.

---

## Key Features

- **Side-by-Side Multi-Asset Matrix**:
  - Displays Bitcoin (BTC) and Ethereum (ETH) columns simultaneously.
  - Multi-expiry 4-column layout (BTC Expiry 1, BTC Expiry 2, ETH Expiry 1, ETH Expiry 2) or 2-column layout.
  - Independent Expiry Dropdowns on each column header.
- **Precise 21-Strike Range**:
  - **10 Upper Strikes** (above ATM with directional `+1` to `+10` tags).
  - **At-The-Money (ATM)** strike highlighted with a distinctive amber badge and border.
  - **10 Lower Strikes** (below ATM with directional `-1` to `-10` tags).
  - Auto-centers on ATM on load.
- **Ultra-Fast 1-Second Real-Time Updates**:
  - **Level 2 Order Book (`l2_orderbook`)** streaming for sub-second quote and spread updates.
  - **1000ms (1-second) high-frequency polling engine** refreshing spot prices and options snapshots.
  - Sub-50ms reactive tick animations (green on uptick, red on downtick).
- **Aesthetic Themes**:
  - **Classic Sheet Mode**: Excel / Trading room high-contrast yellow strike columns matching financial terminal sheets.
  - **Pro Dark Mode**: Deep obsidian dark terminal.
- **Options Pricing & Tools**:
  - Pricing mode toggle between **Mark Price** and **LTP** (Last Traded Price).
  - Full **19-Column Options Chain View** with Delta, IV, OI, and Bid/Ask spreads.
  - One-click export of matrix data to **CSV** or **JSON**.

---

## Project Structure

```
├── index.html                  # Main Web Application & Dashboard UI
├── style.css                   # Stylesheet (Classic Sheet & Pro Dark themes)
├── app.js                      # Core WebSocket, REST & Matrix Engine
├── serve.py                    # Zero-dependency local web server (Port 8080)
├── delta_straddle_tracker.py   # Python CLI straddle tracker with ASCII table
├── btc_straddles.json          # Sample exported BTC straddle dataset
├── eth_straddles.csv           # Sample exported ETH straddle dataset
└── .gitignore                  # Git ignore rules
```

---

## How to Run

### 1. Web Dashboard
Run the built-in zero-dependency local HTTP server:
```bash
python serve.py
```
Open your browser and navigate to:
```
http://localhost:8080
```

### 2. Python CLI Tracker
You can also run the terminal tracker directly:
```bash
# Track BTC with 10 strikes around ATM
python delta_straddle_tracker.py --asset BTC --strikes 10

# Track ETH in continuous live streaming mode
python delta_straddle_tracker.py --asset ETH --strikes 10 --live --interval 1

# Export to CSV or JSON
python delta_straddle_tracker.py --asset BTC --export btc_straddles.json
```

---

## License
MIT License
