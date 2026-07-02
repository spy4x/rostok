#!/usr/bin/env python3
"""Final import script - upload .ics to Stalwart via JMAP"""
import subprocess, json, os, glob, sys

MAILBOX_PASSWORD = os.environ.get("MAILBOX_PASSWORD", "")
if not MAILBOX_PASSWORD:
    print("Set MAILBOX_PASSWORD env var")
    sys.exit(1)

ACCOUNT = "anton@antonshubin.com"
URL = "http://127.0.0.1:8080"

def jmap(mc, using=None):
    if using is None:
        using = ["urn:ietf:params:jmap:core"]
    req = json.dumps({"using": using, "methodCalls": mc})
    cmd = ["docker", "exec", "-i", "hl-stalwart", "curl", "-s", f"{URL}/jmap/",
           "-u", f"{ACCOUNT}:{MAILBOX_PASSWORD}",
           "-H", "Content-Type: application/json", "-d", "@-"]
    p = subprocess.run(cmd, input=req.encode(), capture_output=True, timeout=30)
    return json.loads(p.stdout)

def blob_upload(data):
    cmd = ["docker", "exec", "-i", "hl-stalwart", "curl", "-s", f"{URL}/jmap/upload/c/",
           "-u", f"{ACCOUNT}:{MAILBOX_PASSWORD}",
           "-H", "Content-Type: text/calendar", "--data-binary", "@-"]
    p = subprocess.run(cmd, input=data, capture_output=True, timeout=30)
    try:
        return json.loads(p.stdout).get("blobId", "")
    except:
        return ""

def get_args(resp):
    return resp.get("methodResponses", [[{},]])[0][1]

# Get calendars
print("=== Calendars ===")
resp = jmap([["Calendar/get", {"accountId": "c", "ids": None}, "c0"]],
            using=["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"])
cals = get_args(resp).get("list", [])
for c in cals:
    print(f"  {c['name']} (id={c['id']})")

# Import
print("\n=== Importing ===")
base_dir = "/tmp/radicale-import/radicale-export/collections"
for c in cals:
    cid = c["id"]
    cname = c["name"]
    found = None
    for d in sorted(glob.glob(f"{base_dir}/*/")):
        cn = os.path.basename(d.rstrip("/"))
        dp = os.path.join(d, ".Radicale.props")
        dn = cn
        if os.path.exists(dp):
            with open(dp) as f:
                try:
                    dn = json.load(f).get("D:displayname", cn)
                except:
                    pass
        if dn == cname or cn == cname:
            found = d
            break
    if not found:
        continue

    ics_files = sorted(glob.glob(f"{found}*.ics"))
    ics_files = [f for f in ics_files if ".Radicale.cache" not in f]
    done = 0

    for ics_file in ics_files:
        with open(ics_file, "rb") as f:
            data = f.read()
        bid = blob_upload(data)
        if not bid:
            continue

        pr = jmap([["CalendarEvent/parse", {"accountId": "c", "blobIds": [bid]}, "c0"]],
                  using=["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars", "urn:ietf:params:jmap:calendars:parse"])
        parsed = get_args(pr).get("parsed", {})
        for pid, ev in parsed.items():
            ev["calendarId"] = cid
            sr = jmap([["CalendarEvent/set", {"accountId": "c", "create": {pid: ev}}, "c0"]],
                       using=["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"])
            if get_args(sr).get("created", {}):
                done += 1

        if done % 5 == 0:
            print(f"  {cname}: {done}/{len(ics_files)}")

    print(f"  {cname}: {done}/{len(ics_files)}")

print("\nDone!")
