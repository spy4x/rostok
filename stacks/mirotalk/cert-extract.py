#!/usr/bin/env python3
"""Extract Let's Encrypt cert from Traefik's acme.json and write PEM files
for coturn TURN-TLS.

Watches /acme.json, writes /certs/<domain>.crt and /certs/<domain>.key whenever
the cert for ${DOMAIN} changes (LE renewal or initial issue). Designed to run
in a sidecar container with /acme.json mounted read-only and /certs as a
shared volume with coturn.

Runs every 5 minutes via a tiny internal cron. Exits cleanly on SIGTERM.
"""

import json
import os
import signal
import sys
import time
from base64 import b64decode
from pathlib import Path

ACME_PATH = Path(os.environ.get("ACME_PATH", "/acme.json"))
CERTS_DIR = Path(os.environ.get("CERTS_DIR", "/certs"))
DOMAIN = os.environ.get("DOMAIN", "antonshubin.com")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "300"))  # 5 min


def extract():
    try:
        data = json.loads(ACME_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"[{time.strftime('%H:%M:%S')}] skip: {e}", file=sys.stderr)
        return False

    target = f"talk.{DOMAIN}"
    for resolver in data.values():
        for cert in resolver.get("Certificates") or []:
            if cert.get("domain", {}).get("main") == target:
                pem = b64decode(cert["certificate"]).decode()
                key = b64decode(cert["key"]).decode()
                CERTS_DIR.mkdir(parents=True, exist_ok=True)
                crt_path = CERTS_DIR / f"{target}.crt"
                key_path = CERTS_DIR / f"{target}.key"
                # Only write if changed (compare fingerprints cheaply via mtime + bytes)
                if (crt_path.exists() and crt_path.read_text() == pem and
                        key_path.exists() and key_path.read_text() == key):
                    return False
                crt_path.write_text(pem)
                key_path.write_text(key)
                # 0644 for both: coturn runs as `nobody` inside the container
                # and refuses to start the TLS listener if the key is not readable.
                os.chmod(crt_path, 0o644)
                os.chmod(key_path, 0o644)
                print(f"[{time.strftime('%H:%M:%S')}] wrote {crt_path} ({len(pem)} bytes)")
                return True
    print(f"[{time.strftime('%H:%M:%S')}] no cert for {target} in acme.json yet")
    return False


_stop = False


def handle_stop(signum, frame):
    global _stop
    _stop = True
    print(f"[{time.strftime('%H:%M:%S')}] stopping")


signal.signal(signal.SIGTERM, handle_stop)
signal.signal(signal.SIGINT, handle_stop)


if __name__ == "__main__":
    print(f"[{time.strftime('%H:%M:%S')}] starting; ACME_PATH={ACME_PATH} DOMAIN={DOMAIN}")
    while not _stop:
        extract()
        # Sleep in small chunks so SIGTERM is responsive
        for _ in range(POLL_INTERVAL):
            if _stop:
                break
            time.sleep(1)
