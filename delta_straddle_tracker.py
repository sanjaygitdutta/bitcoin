#!/usr/bin/env python3
"""
Delta Exchange Real-Time Options Straddle & ATM Tracker
Fetches live Bitcoin (BTC) and Ethereum (ETH) options data from Delta Exchange API/WebSocket.
Calculates ATM (At-The-Money) strike, 10 strikes of CE (Call) & PE (Put) around ATM,
and computes real-time Straddle prices, Bid/Ask spreads, Breakevens, and Greeks.
"""

import sys
import time
import json
import argparse
import urllib.request
from datetime import datetime

DELTA_API_URL = "https://api.delta.exchange/v2"

def fetch_tickers(contract_types="call_options,put_options"):
    """Fetch live option tickers from Delta Exchange REST API."""
    url = f"{DELTA_API_URL}/tickers?contract_types={contract_types}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            return data.get('result', [])
    except Exception as e:
        print(f"[ERROR] Failed to fetch tickers from Delta Exchange: {e}", file=sys.stderr)
        return []

def fetch_spot_price(underlying="BTC"):
    """Fetch current underlying spot / perpetual price from Delta Exchange."""
    symbol = f"{underlying}USDT"
    url = f"{DELTA_API_URL}/tickers/{symbol}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            result = data.get('result', {})
            spot = result.get('spot_price') or result.get('mark_price') or result.get('close')
            return float(spot) if spot else None
    except Exception as e:
        return None

def parse_expiry_from_symbol(symbol):
    """
    Extracts date string from symbol.
    Example: 'C-BTC-77000-140926' -> '14-09-2026'
    """
    parts = symbol.split('-')
    if len(parts) >= 4:
        raw_date = parts[-1]
        if len(raw_date) == 6:
            day = raw_date[0:2]
            month = raw_date[2:4]
            year = "20" + raw_date[4:6]
            return f"{day}-{month}-{year}", raw_date
    return "UNKNOWN", "UNKNOWN"

def get_available_expiries(tickers, underlying="BTC"):
    """Returns sorted list of available expiry date codes for given underlying asset."""
    expiries = set()
    for t in tickers:
        if t.get('underlying_asset_symbol') == underlying:
            _, raw_code = parse_expiry_from_symbol(t.get('symbol', ''))
            if raw_code != "UNKNOWN":
                expiries.add(raw_code)
    # Sort by date
    def sort_key(code):
        try:
            return datetime.strptime(code, "%d%m%y")
        except Exception:
            return datetime.max
    return sorted(list(expiries), key=sort_key)

def process_options_chain(tickers, underlying="BTC", target_expiry=None, num_strikes=10, spot_price=None):
    """
    Processes options chain:
    - Filters for underlying asset and expiry
    - Computes ATM Strike
    - Slices num_strikes centered around ATM
    - Computes Straddle price, Bid/Ask, Breakevens for each strike
    """
    asset_tickers = [t for t in tickers if t.get('underlying_asset_symbol') == underlying]
    if not asset_tickers:
        return None

    # Derive spot price from tickers if not passed
    if not spot_price:
        for t in asset_tickers:
            if t.get('spot_price'):
                try:
                    spot_price = float(t.get('spot_price'))
                    break
                except (ValueError, TypeError):
                    continue
    if not spot_price:
        spot_price = fetch_spot_price(underlying)
    if not spot_price:
        spot_price = 0.0

    # Determine expiry
    available_expiries = get_available_expiries(asset_tickers, underlying)
    if not available_expiries:
        return None
    
    if not target_expiry or target_expiry not in available_expiries:
        target_expiry = available_expiries[0] # nearest expiry

    formatted_expiry, _ = parse_expiry_from_symbol(f"C-{underlying}-0-{target_expiry}")

    # Filter for target expiry
    expiry_tickers = [t for t in asset_tickers if t.get('symbol', '').endswith(f"-{target_expiry}")]

    # Map by strike: {strike: {'call': ticker, 'put': ticker}}
    strike_map = {}
    for t in expiry_tickers:
        try:
            strike = float(t.get('strike_price'))
        except (ValueError, TypeError):
            continue
        
        if strike not in strike_map:
            strike_map[strike] = {'call': None, 'put': None}
        
        ctype = t.get('contract_type')
        if ctype == 'call_options':
            strike_map[strike]['call'] = t
        elif ctype == 'put_options':
            strike_map[strike]['put'] = t

    all_strikes = sorted(strike_map.keys())
    if not all_strikes:
        return None

    # Determine ATM Strike
    atm_strike = min(all_strikes, key=lambda s: abs(s - spot_price))

    # Select num_strikes centered around ATM
    # Sort all strikes by distance from spot, take top num_strikes, then sort ascending
    closest_strikes = sorted(all_strikes, key=lambda s: abs(s - spot_price))[:num_strikes]
    selected_strikes = sorted(closest_strikes)

    rows = []
    for strike in selected_strikes:
        call = strike_map[strike]['call'] or {}
        put = strike_map[strike]['put'] or {}

        # Call data
        c_ltp = call.get('close')
        c_mark = float(call.get('mark_price', 0) or 0)
        c_quotes = call.get('quotes') or {}
        c_bid = float(c_quotes.get('best_bid') or 0)
        c_ask = float(c_quotes.get('best_ask') or 0)
        c_iv = float(c_quotes.get('mark_iv', 0) or 0) * 100
        c_greeks = call.get('greeks') or {}
        c_delta = float(c_greeks.get('delta', 0) or 0)
        c_oi = float(call.get('oi', 0) or 0)

        # Put data
        p_ltp = put.get('close')
        p_mark = float(put.get('mark_price', 0) or 0)
        p_quotes = put.get('quotes') or {}
        p_bid = float(p_quotes.get('best_bid') or 0)
        p_ask = float(p_quotes.get('best_ask') or 0)
        p_iv = float(p_quotes.get('mark_iv', 0) or 0) * 100
        p_greeks = put.get('greeks') or {}
        p_delta = float(p_greeks.get('delta', 0) or 0)
        p_oi = float(put.get('oi', 0) or 0)

        # Straddle Calculation:
        # Straddle Price (Mark): Sum of Call Mark and Put Mark
        straddle_mark = c_mark + p_mark

        # Straddle Price (LTP): Sum of Call Close and Put Close if available, fallback to Mark
        c_trade_price = float(c_ltp) if c_ltp is not None else c_mark
        p_trade_price = float(p_ltp) if p_ltp is not None else p_mark
        straddle_ltp = c_trade_price + p_trade_price

        # Straddle Bid / Ask
        straddle_bid = c_bid + p_bid if (c_bid and p_bid) else 0.0
        straddle_ask = c_ask + p_ask if (c_ask and p_ask) else 0.0

        # Breakevens
        upper_breakeven = strike + straddle_mark
        lower_breakeven = max(0.0, strike - straddle_mark)
        straddle_pct = (straddle_mark / spot_price * 100) if spot_price > 0 else 0.0

        rows.append({
            'strike': strike,
            'is_atm': (strike == atm_strike),
            'distance_from_spot': strike - spot_price,
            'call': {
                'symbol': call.get('symbol', '-'),
                'ltp': c_ltp,
                'mark': c_mark,
                'bid': c_bid,
                'ask': c_ask,
                'iv': round(c_iv, 2),
                'delta': round(c_delta, 3),
                'oi': c_oi
            },
            'put': {
                'symbol': put.get('symbol', '-'),
                'ltp': p_ltp,
                'mark': p_mark,
                'bid': p_bid,
                'ask': p_ask,
                'iv': round(p_iv, 2),
                'delta': round(p_delta, 3),
                'oi': p_oi
            },
            'straddle': {
                'mark_price': round(straddle_mark, 2),
                'ltp': round(straddle_ltp, 2),
                'bid': round(straddle_bid, 2),
                'ask': round(straddle_ask, 2),
                'upper_breakeven': round(upper_breakeven, 2),
                'lower_breakeven': round(lower_breakeven, 2),
                'premium_pct_spot': round(straddle_pct, 2)
            }
        })

    # ATM summary stats
    atm_row = next((r for r in rows if r['is_atm']), None)
    atm_straddle = atm_row['straddle']['mark_price'] if atm_row else 0.0
    atm_pct = atm_row['straddle']['premium_pct_spot'] if atm_row else 0.0

    return {
        'underlying': underlying,
        'spot_price': round(spot_price, 2),
        'expiry_code': target_expiry,
        'expiry_formatted': formatted_expiry,
        'available_expiries': available_expiries,
        'atm_strike': atm_strike,
        'atm_straddle_mark': atm_straddle,
        'atm_straddle_pct': atm_pct,
        'timestamp': datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC'),
        'strikes_count': len(rows),
        'rows': rows
    }

def print_terminal_table(data):
    """Prints a beautiful formatted ASCII terminal table with colored highlights."""
    if not data:
        print("[!] No data available.")
        return

    # ANSI color codes
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    RED = "\033[91m"
    YELLOW = "\033[93m"
    GOLD = "\033[38;5;220m"
    BOLD = "\033[1m"
    RESET = "\033[0m"
    DIM = "\033[2m"

    print("\n" + "="*112)
    print(f"{BOLD}{GOLD}DELTA EXCHANGE OPTIONS STRADDLE TRACKER{RESET} | Asset: {BOLD}{data['underlying']}{RESET} | Expiry: {BOLD}{data['expiry_formatted']}{RESET} ({data['expiry_code']})")
    print(f"Spot Price: {BOLD}${data['spot_price']:,.2f}{RESET} | ATM Strike: {BOLD}{GOLD}${data['atm_strike']:,.0f}{RESET} | ATM Straddle: {BOLD}{YELLOW}${data['atm_straddle_mark']:,.2f}{RESET} ({data['atm_straddle_pct']}%) | Time: {DIM}{data['timestamp']}{RESET}")
    print("="*112)

    header = (
        f"{CYAN}{'CALL (CE)':^28}{RESET} | "
        f"{GOLD}{'STRIKE & STRADDLE':^34}{RESET} | "
        f"{RED}{'PUT (PE)':^28}{RESET}"
    )
    sub_header = (
        f"{'Delta':>6} {'IV%':>5} {'Bid':>7} {'Ask':>7} {'Mark':>7} | "
        f"{'Strike':^9} {'Straddle':>9} {'Bid-Ask':>12} | "
        f"{'Mark':>7} {'Bid':>7} {'Ask':>7} {'IV%':>5} {'Delta':>6}"
    )

    print(header)
    print(sub_header)
    print("-" * 112)

    for r in data['rows']:
        c = r['call']
        p = r['put']
        s = r['straddle']
        is_atm = r['is_atm']

        atm_marker = f"{GOLD}*ATM*{RESET}" if is_atm else "     "
        strike_str = f"{GOLD}{BOLD}{r['strike']:>7,.0f}{RESET}" if is_atm else f"{r['strike']:>7,.0f}"
        
        c_mark_str = f"{c['mark']:>7.2f}"
        p_mark_str = f"{p['mark']:>7.2f}"
        strad_str = f"{YELLOW}{BOLD}{s['mark_price']:>9.2f}{RESET}" if is_atm else f"{s['mark_price']:>9.2f}"
        strad_ba = f"{s['bid']:.1f}-{s['ask']:.1f}"

        row_str = (
            f"{c['delta']:>6.2f} {c['iv']:>5.1f} {c['bid']:>7.1f} {c['ask']:>7.1f} {c_mark_str} | "
            f"{strike_str} {strad_str} {strad_ba:>12} | "
            f"{p_mark_str} {p['bid']:>7.1f} {p['ask']:>7.1f} {p['iv']:>5.1f} {p['delta']:>6.2f}"
        )

        if is_atm:
            print(f"{GOLD}>>> {row_str} <<<{RESET}")
        else:
            print(f"    {row_str}")

    print("="*112)
    atm_row = next((r for r in data['rows'] if r['is_atm']), None)
    if atm_row:
        s = atm_row['straddle']
        print(f"{BOLD}ATM Breakevens:{RESET} Lower: {GREEN}${s['lower_breakeven']:,.2f}{RESET} | Upper: {GREEN}${s['upper_breakeven']:,.2f}{RESET} (Spread: ±${s['mark_price']:,.2f})")
    print("="*112 + "\n")

def export_json_csv(data, export_path):
    """Exports processed data to JSON or CSV."""
    if export_path.endswith('.json'):
        with open(export_path, 'w') as f:
            json.dump(data, f, indent=2)
        print(f"[+] Successfully exported data to {export_path}")
    elif export_path.endswith('.csv'):
        import csv
        with open(export_path, 'w', newline='') as f:
            writer = csv.writer(f)
            writer.writerow([
                'Underlying', 'Spot', 'Expiry', 'Strike', 'Is_ATM',
                'CE_Symbol', 'CE_LTP', 'CE_Mark', 'CE_Bid', 'CE_Ask', 'CE_IV', 'CE_Delta', 'CE_OI',
                'PE_Symbol', 'PE_LTP', 'PE_Mark', 'PE_Bid', 'PE_Ask', 'PE_IV', 'PE_Delta', 'PE_OI',
                'Straddle_Mark', 'Straddle_LTP', 'Straddle_Bid', 'Straddle_Ask',
                'Lower_Breakeven', 'Upper_Breakeven', 'Premium_Pct_Spot'
            ])
            for r in data['rows']:
                c = r['call']
                p = r['put']
                s = r['straddle']
                writer.writerow([
                    data['underlying'], data['spot_price'], data['expiry_formatted'], r['strike'], r['is_atm'],
                    c['symbol'], c['ltp'], c['mark'], c['bid'], c['ask'], c['iv'], c['delta'], c['oi'],
                    p['symbol'], p['ltp'], p['mark'], p['bid'], p['ask'], p['iv'], p['delta'], p['oi'],
                    s['mark_price'], s['ltp'], s['bid'], s['ask'],
                    s['lower_breakeven'], s['upper_breakeven'], s['premium_pct_spot']
                ])
        print(f"[+] Successfully exported data to {export_path}")

def main():
    parser = argparse.ArgumentParser(description="Delta Exchange Live ATM & 10 CE/PE Straddle Tracker")
    parser.add_argument("--asset", choices=["BTC", "ETH"], default="BTC", help="Underlying asset (default: BTC)")
    parser.add_argument("--expiry", type=str, default=None, help="Specific expiry code (e.g. 140926)")
    parser.add_argument("--strikes", type=int, default=10, help="Number of strikes around ATM (default: 10)")
    parser.add_argument("--live", action="store_true", help="Run continuous live terminal update loop")
    parser.add_argument("--interval", type=int, default=3, help="Live refresh interval in seconds (default: 3)")
    parser.add_argument("--export", type=str, default=None, help="Export output to .csv or .json file")

    args = parser.parse_args()

    print(f"Fetching options data from Delta Exchange for {args.asset}...")
    tickers = fetch_tickers()
    if not tickers:
        print("[!] No tickers received. Check internet or API endpoint.")
        sys.exit(1)

    data = process_options_chain(tickers, underlying=args.asset, target_expiry=args.expiry, num_strikes=args.strikes)
    if not data:
        print(f"[!] No options data found for {args.asset}.")
        sys.exit(1)

    print_terminal_table(data)

    if args.export:
        export_json_csv(data, args.export)

    if args.live:
        print(f"Entering live streaming mode (refresh every {args.interval}s). Press Ctrl+C to stop.")
        try:
            while True:
                time.sleep(args.interval)
                tickers = fetch_tickers()
                data = process_options_chain(tickers, underlying=args.asset, target_expiry=args.expiry, num_strikes=args.strikes)
                if data:
                    print_terminal_table(data)
        except KeyboardInterrupt:
            print("\nStopped live tracking.")

if __name__ == "__main__":
    main()
