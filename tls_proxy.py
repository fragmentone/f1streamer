#!/usr/bin/env python3
"""Local TLS proxy — Chrome-impersonated fetcher for Node.js"""
import sys
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from curl_cffi import requests as cffi_req

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18888

# ⚡ THREAD-LOCAL SESSIONS: 
# curl_cffi sessions are not thread-safe! We must give every concurrent 
# request thread its own isolated Session to prevent TLS deadlocks and 502s.
thread_local = threading.local()

def get_session():
    if not hasattr(thread_local, "session"):
        thread_local.session = cffi_req.Session(impersonate='chrome')
    return thread_local.session

class Handler(BaseHTTPRequestHandler):
    # Enable HTTP/1.1 Keep-Alive capabilities to pool connections with Node
    protocol_version = 'HTTP/1.1' 
    
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        target = params.get('url', [None])[0]
        
        if not target:
            self.send_response(400)
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(b'Missing ?url=')
            return
            
        hdrs = {}
        for k, v in self.headers.items():
            if k.lower().startswith('x-fwd-'):
                hdrs[k[6:]] = v
                
        try:
            session = get_session()
            r = session.get(target, headers=hdrs, timeout=10)
            
            self.send_response(r.status_code)
            ct = r.headers.get('content-type', 'application/octet-stream')
            self.send_header('Content-Type', ct)
            self.send_header('Content-Length', str(len(r.content)))
            
            # Maintain the Keep-Alive pipeline back to Node.js
            if self.headers.get('Connection', '').lower() == 'keep-alive':
                self.send_header('Connection', 'keep-alive')
            else:
                self.send_header('Connection', 'close')
                
            self.end_headers()
            self.wfile.write(r.content)
        except Exception as e:
            self.send_response(502)
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(str(e).encode())

    def log_message(self, *a): pass  # silence logs

print("READY", flush=True)
ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
