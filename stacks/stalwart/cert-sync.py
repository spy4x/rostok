#!/usr/bin/env python3
"""Sync Let's Encrypt certs from Traefik acme.json into Stalwart Mail Server.

Reads the Traefik acme.json, extracts certs for configured domains, and imports
them into Stalwart via JMAP API when they've changed.

Designed to run as a daily cron job on the cloudlab VPS.

Usage:
    STALWART_PASSWORD=xxx python3 stalwart-cert-sync.py
"""

import base64
import hashlib
import json
import os
import sys
import urllib.request
from base64 import b64decode

# ── Configuration ────────────────────────────────────────────────────────────

ACME_PATH = os.environ.get("ACME_PATH", "/home/spy4x/cloudlab/apps/.volumes/traefik/letsencrypt/acme.json")
STALWART_URL = os.environ.get("STALWART_URL", "http://stalwart:8080/jmap/")
STALWART_USER = os.environ.get("STALWART_USER", "admin")
STATE_DIR = os.environ.get("STATE_DIR", os.path.expanduser("~/.cache/stalwart-cert-sync"))

DOMAINS = [
    "mail.antonshubin.com",
    "mail.neatsoft.dev",
]


def get_password():
    env = os.environ.get("STALWART_PASSWORD")
    if env:
        return env
    # Also try reading from cloud .env (fallback for cron)
    env_file = "/home/spy4x/cloudlab/apps/env/cloud.env"
    try:
        with open(env_file) as f:
            for line in f:
                if line.startswith("STALWART_ADMIN_PASSWORD="):
                    return line.strip().split("=", 1)[1]
    except FileNotFoundError:
        pass
    print("ERROR: STALWART_PASSWORD not set", file=sys.stderr)
    sys.exit(1)


def jmap(method_calls):
    payload = json.dumps({
        "methodCalls": method_calls,
        "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
    }).encode()
    auth = base64.b64encode(f"{STALWART_USER}:{PASSWORD}".encode()).decode()
    req = urllib.request.Request(STALWART_URL, data=payload, headers={
        "Content-Type": "application/json",
        "Authorization": f"Basic {auth}",
    })
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def cert_fingerprint(crt_pem, key_pem):
    h = hashlib.sha256()
    h.update(crt_pem.encode())
    h.update(key_pem.encode())
    return h.hexdigest()


def load_acme_certs():
    with open(ACME_PATH) as f:
        acme = json.load(f)
    certs = acme["myresolver"]["Certificates"]
    result = {}
    for c in certs:
        main = c["domain"]["main"]
        if main in DOMAINS:
            result[main] = {
                "cert": b64decode(c["certificate"]).decode(),
                "key": b64decode(c["key"]).decode(),
            }
    return result


def main():
    os.makedirs(STATE_DIR, exist_ok=True)

    acme_certs = load_acme_certs()

    # Query existing Stalwart certs for matching domains
    # Find cert IDs to update
    existing = jmap([["x:Certificate/query", {"filter": {"subjectAlternativeNames": "placeholder"}}, "c1"]])
    # Actually, query for each domain's cert via a broad query and then filter
    # Simpler: get all certs and match by SAN
    resp = jmap([["x:Certificate/query", {}, "c1"]])
    cert_ids = resp["methodResponses"][0][1].get("ids", [])

    # Get all cert details
    if cert_ids:
        resp = jmap([["x:Certificate/get", {"ids": cert_ids}, "c1"]])
        cert_list = resp["methodResponses"][0][1].get("list", [])
    else:
        cert_list = []

    # Map: domain -> cert_id
    domain_cert_ids = {}
    for c in cert_list:
        sans = c.get("subjectAlternativeNames", {})
        for san in sans:
            domain_cert_ids[san] = c["id"]

    for domain in DOMAINS:
        if domain not in acme_certs:
            print(f"[{domain}] SKIP: not found in acme.json")
            continue

        crt = acme_certs[domain]["cert"]
        key = acme_certs[domain]["key"]
        fp = cert_fingerprint(crt, key)

        # Load stored fingerprint
        state_file = os.path.join(STATE_DIR, domain.replace(".", "_") + ".sha256")
        stored_fp = None
        try:
            with open(state_file) as f:
                stored_fp = f.read().strip()
        except FileNotFoundError:
            pass

        if fp == stored_fp and domain in domain_cert_ids:
            print(f"[{domain}] OK: cert unchanged (id={domain_cert_ids[domain]})")
            continue

        # Import cert
        create_obj = {
            "certificate": {"@type": "Text", "value": crt},
            "privateKey": {"@type": "Text", "secret": key},
        }

        if domain in domain_cert_ids:
            # Update existing cert
            resp = jmap([["x:Certificate/set", {
                "update": {domain_cert_ids[domain]: create_obj},
            }, "c1"]])
            status = resp["methodResponses"][0][1]
            if "updated" in status:
                print(f"[{domain}] UPDATED (id={domain_cert_ids[domain]})")
            else:
                print(f"[{domain}] UPDATE FAILED: {json.dumps(status)[:200]}")
                continue
        else:
            # Create new cert
            resp = jmap([["x:Certificate/set", {
                "create": {"cert": create_obj},
            }, "c1"]])
            status = resp["methodResponses"][0][1]
            if "created" in status:
                new_id = list(status["created"].values())[0]["id"]
                domain_cert_ids[domain] = new_id
                print(f"[{domain}] CREATED (id={new_id})")
            else:
                print(f"[{domain}] CREATE FAILED: {json.dumps(status)[:200]}")
                continue

        # Store fingerprint
        with open(state_file, "w") as f:
            f.write(fp)

    # Set the first domain's cert as default if no default is set
    resp = jmap([["x:SystemSettings/get", {"ids": ["singleton"]}, "c1"]])
    settings = resp["methodResponses"][0][1].get("list", [])
    if settings:
        default_cert_id = settings[0].get("defaultCertificateId")
        first_domain = DOMAINS[0]
        if first_domain in acme_certs and first_domain in domain_cert_ids:
            new_default = domain_cert_ids[first_domain]
            if default_cert_id != new_default:
                resp = jmap([["x:SystemSettings/set", {
                    "update": {"singleton": {"defaultCertificateId": new_default}},
                }, "c1"]])
                print(f"[default] Set defaultCertificateId={new_default}")


if __name__ == "__main__":
    PASSWORD = get_password()
    main()
