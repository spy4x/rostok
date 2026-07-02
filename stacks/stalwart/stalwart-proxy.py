#!/usr/bin/env python3
"""
Stalwart HTTP proxy sidecar.

Forwards HTTP requests from Traefik to Stalwart. Uses Python urllib which
has reliable HTTP/1.1 behavior compatible with Stalwart's Rust HTTP server.

Why needed: Traefik (Alpine 3.23 BusyBox) and Stalwart's Rust HTTP server
have a TCP-level interaction that causes connection resets on some Docker
container IPs. Python urllib (Alpine 3.24 python:3-alpine) consistently works.
"""
import http.server
import socketserver
import sys
import urllib.error
import urllib.request

UPSTREAM = "http://hl-stalwart:8080"


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _proxy(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length:
                data = self.rfile.read(content_length)
            else:
                # urllib.request treats data=None as GET regardless of method.
                # Use empty bytes to preserve the original method (PROPFIND, etc.).
                data = b""
            headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "content-length")}
            req = urllib.request.Request(
                f"{UPSTREAM}{self.path}",
                data=data,
                method=self.command,
                headers=headers,
            )
            r = urllib.request.urlopen(req, timeout=30)
            body = r.read()
            self.send_response(r.status)
            for h in ("Location", "Cache-Control", "Content-Type", "ETag", "DAV"):
                if any(h.lower() == k.lower() for k in r.headers):
                    val = next(v for k, v in r.headers.items() if k.lower() == h.lower())
                    self.send_header(h, val)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(502)
            msg = f"{type(e).__name__}: {e}".encode()
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def do_GET(self):
        self._proxy()

    def do_POST(self):
        self._proxy()

    def do_PUT(self):
        self._proxy()

    def do_DELETE(self):
        self._proxy()

    def do_OPTIONS(self):
        self._proxy()

    def do_HEAD(self):
        self._proxy()

    def do_PROPFIND(self):
        self._proxy()

    def do_PROPPATCH(self):
        self._proxy()

    def do_REPORT(self):
        self._proxy()

    def do_MKCALENDAR(self):
        self._proxy()

    def do_MOVE(self):
        self._proxy()

    def log_message(self, *_a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", port), ProxyHandler) as s:
        s.serve_forever()