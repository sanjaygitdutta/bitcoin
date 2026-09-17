#!/usr/bin/env python3
"""
Simple zero-dependency HTTP server to launch the Delta Exchange Straddle Tracker dashboard.
Runs at http://localhost:8080
"""

import os
import sys
import http.server
import socketserver
import webbrowser

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # Enable CORS and disable aggressive caching for local development
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

def run_server():
    os.chdir(DIRECTORY)
    # Allow port reuse to prevent Address already in use errors
    socketserver.TCPServer.allow_reuse_address = True
    
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print("="*75)
        print("  DELTA EXCHANGE OPTIONS STRADDLE & ATM TRACKER")
        print(f"  Local Web Server running at: http://localhost:{PORT}")
        print(f"  Serving directory: {DIRECTORY}")
        print("  Press Ctrl+C to stop the server.")
        print("="*75)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")

if __name__ == "__main__":
    run_server()
