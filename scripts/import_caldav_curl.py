#!/usr/bin/env python3
"""Import .ics files into Stalwart via CalDAV using docker exec curl"""
import subprocess, json, os, glob, sys, re, uuid, html, tempfile, time, urllib.parse

PASS = os.environ.get("MAILBOX_PASSWORD", "")
if not PASS:
    print("Set MAILBOX_PASSWORD env var")
    sys.exit(1)

ACCOUNT = "anton@antonshubin.com"
BASE = "http://127.0.0.1:8080"

def curl(method, path, headers=None, data=None):
    cmd = ["docker", "exec", "-i", "hl-stalwart", "curl", "-s",
           f"{BASE}{path}",
           "-u", f"{ACCOUNT}:{PASS}",
           "-X", method]
    if headers:
        for h in headers:
            cmd += ["-H", h]
    if data:
        p = subprocess.run(cmd, input=data.encode(), capture_output=True, timeout=30)
    else:
        p = subprocess.run(cmd, capture_output=True, timeout=30)
    return p.stdout.decode(), p.stderr.decode()

def curl_put(path, ics_data):
    cmd = ["docker", "exec", "-i", "hl-stalwart", "curl", "-s", "-D-",
           f"{BASE}{path}",
           "-u", f"{ACCOUNT}:{PASS}",
           "-X", "PUT",
           "-H", "Content-Type: text/calendar; charset=utf-8"]
    p = subprocess.run(cmd, input=ics_data.encode(), capture_output=True, timeout=30)
    return p.stdout.decode(), p.stderr.decode()

def curl_mkcol(path, xml_data):
    cmd = ["docker", "exec", "-i", "hl-stalwart", "curl", "-s", "-D-",
           f"{BASE}{path}",
           "-u", f"{ACCOUNT}:{PASS}",
           "-X", "MKCALENDAR",
           "-H", "Content-Type: application/xml; charset=utf-8"]
    p = subprocess.run(cmd, input=xml_data.encode(), capture_output=True, timeout=30)
    return p.stdout.decode(), p.stderr.decode()

def http_status(output):
    """Extract HTTP status code from -D- header output"""
    for line in output.split("\n"):
        if line.startswith("HTTP/"):
            parts = line.split()
            if len(parts) >= 2:
                return parts[1]
    return ""

# Step 1: Get existing calendars
print("=== Existing calendars via PROPFIND ===")
resp, _ = curl("PROPFIND", "/dav/cal/", ["Depth: 1"])
print(resp[:1500])

# Step 2: Import .ics files  
base_dir = "/tmp/radicale-import/radicale-export/collections"
print(f"\n=== Importing from {base_dir} ===")

for coll_dir in sorted(glob.glob(f"{base_dir}/*/")):
    coll_name = os.path.basename(coll_dir.rstrip("/"))
    props_file = os.path.join(coll_dir, ".Radicale.props")
    
    displayname = coll_name
    color = "#3788d8FF"
    if os.path.exists(props_file):
        with open(props_file) as f:
            try:
                props = json.load(f)
                displayname = props.get("D:displayname", props.get("displayname", coll_name))
                c = props.get("CS:calendar-color", props.get("ICAL:calendar-color", "#3788d8"))
                if len(c) == 7:
                    color = c + "FF"
                elif len(c) == 9:
                    color = c
                else:
                    color = "#3788d8FF"
            except:
                pass
    
    # Use filename-safe slug for calendar URL, store displayname as metadata
    cal_slug = re.sub(r'[^a-zA-Z0-9_-]', '_', coll_name)[:50]
    encoded_account = urllib.parse.quote(ACCOUNT, safe="")
    cal_url = f"/dav/cal/{encoded_account}/{cal_slug}/"
    
    # Create calendar via MKCALENDAR
    mkcol_xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<C:mkcalendar xmlns:C="urn:ietf:params:xml:ns:caldav"
              xmlns:D="DAV:"
              xmlns:CS="http://calendarserver.org/ns/">
  <D:set>
    <D:prop>
      <D:displayname>{html.escape(displayname)}</D:displayname>
      <CS:calendar-color>{color}</CS:calendar-color>
      <C:supported-calendar-component-set>
        <C:comp name="VTODO"/>
        <C:comp name="VEVENT"/>
      </C:supported-calendar-component-set>
    </D:prop>
  </D:set>
</C:mkcalendar>'''
    
    out, err = curl_mkcol(cal_url, mkcol_xml)
    status = http_status(out)
    if status == "201":
        print(f"  Created calendar: {displayname}")
    elif status in ("405", "409"):
        print(f"  Already exists: {displayname}")
    elif not status:
        print(f"  MKCALENDAR {displayname}: (empty response)")
    else:
        print(f"  MKCALENDAR {displayname}: HTTP {status}")
    
    # Upload .ics files
    count = 0
    ics_files = sorted(glob.glob(f"{coll_dir}/*.ics"))
    for ics_file in ics_files:
        if ".Radicale.cache" in ics_file:
            continue
        with open(ics_file) as f:
            ics_data = f.read()
        
        uid_match = re.search(r"^UID[=:](.+)$", ics_data, re.MULTILINE)
        uid = uid_match.group(1).strip() if uid_match else os.path.splitext(os.path.basename(ics_file))[0]
        
        event_url = f"{cal_url}{uid}.ics"
        out, err = curl_put(event_url, ics_data)
        status = http_status(out)
        if status in ("201", "204"):
            count += 1
        elif count == 0 and status:
            print(f"  First PUT status: {status}")
    
    print(f"  Imported {count}/{len(ics_files)} items")

print("\n=== Verification ===")
resp, _ = curl("PROPFIND", "/dav/cal/", ["Depth: 1"])
cal_urls = re.findall(r"<D:href>(/dav/cal/[^<]+)</D:href>", resp)
print(f"Calendars: {[u for u in cal_urls if u != '/dav/cal/']}")
print("\nDone!")
