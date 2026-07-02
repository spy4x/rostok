#!/usr/bin/env python3
"""Import Radicale .ics files into Stalwart via JMAP API.
Run on cloudlab server. Data must be at /tmp/radicale-import/
"""
import json, os, sys, subprocess, glob

ACCOUNT = "anton@antonshubin.com"
PASS = os.environ["MAILBOX_PASSWORD"]
STALWART_URL = "http://127.0.0.1:8080"

def jmap(methods, using=None):
    if using is None:
        using = ["urn:ietf:params:jmap:core"]
    req = {"using": using, "methods": methods}
    cmd = ["docker", "exec", "hl-stalwart", "curl", "-s",
           f"{STALWART_URL}/jmap/",
           "-u", f"{ACCOUNT}:{PASS}",
           "-H", "Content-Type: application/json",
           "-d", json.dumps(req)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return json.loads(result.stdout)

print("=== Getting existing calendars ===")
resp = jmap([["Calendar/get", {"accountId": "c", "ids": None}, "c0"]],
            using=["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"])
print(json.dumps(resp, indent=2)[:500])
