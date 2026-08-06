#!/usr/bin/env python3
"""Pangolin IaC bootstrap — drive the API from K11 (or anywhere) via docker exec.

Runs all of:
  1. Login as admin
  2. Delete any misnamed resource (FQDN != code2.antonshubin.com)
  3. Ensure resource `opencode-web` exists at code2.antonshubin.com
  4. Get pick-site-defaults (newtId, secret, endpoint, address)
  5. Create site `k11` (type=newt)
  6. Create target (siteId → 127.0.0.1:8002, method=http)
  7. Clean up orphan sites (k11 sites with no targets)
  8. Write Newt env file for K11

Idempotent: re-running updates the resource if needed and reuses existing
site if one is already wired to a target.

Auth: Pangolin binds its API to IPv6 only on port 443 inside the container,
so we ssh into cloudlab and `docker exec hl-pangolin curl …`.

Prereqs: SSH alias `cloudlab` configured in ~/.ssh/config.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

API_BASE = "http://[::1]:443/api/v1"
EMAIL = "admin@antonshubin.com"
PASSWORD = "PangolinTest123!"
ORG_ID = "default"
DOMAIN_ID = "code2"  # base_domain = code2.antonshubin.com
RESOURCE_NAME = "opencode-web"
RESOURCE_MODE = "http"
SITE_NAME = "k11"
SITE_TYPE = "newt"
TARGET_IP = "127.0.0.1"
TARGET_PORT = 8002
TARGET_METHOD = "http"
CSRF_HEADER = "x-csrf-protection"


def ssh_run(cmd: str) -> str:
    """Run a shell command on cloudlab via ssh. Returns stdout."""
    p = subprocess.run(
        ["ssh", "cloudlab", cmd],
        capture_output=True, text=True, timeout=30,
    )
    if p.returncode != 0:
        raise RuntimeError(f"ssh cloudlab cmd failed: {p.stderr}\ncmd was: {cmd}")
    return p.stdout


def docker_exec_script(script: str) -> str:
    """Run a shell script inside hl-pangolin via stdin. Returns stdout."""
    p = subprocess.run(
        ["ssh", "cloudlab", "docker", "exec", "-i", "hl-pangolin", "sh", "-s"],
        input=script, capture_output=True, text=True, timeout=30,
    )
    if p.returncode != 0:
        raise RuntimeError(f"docker exec failed: {p.stderr}")
    return p.stdout


def docker_exec_curl(
    payload: str | None = None,
    *,
    method: str = "GET",
    path: str = "",
    cookie: bool = False,
    csrf: bool = False,
) -> dict:
    """Run curl inside hl-pangolin via docker exec. Returns parsed JSON."""
    parts = ["curl -s", f"-X {method}", '-H "Content-Type: application/json"']
    if cookie:
        parts.append("-b /tmp/cookies.txt")
    if csrf:
        parts.append(f'-H "x-csrf-token: {CSRF_HEADER}"')
    if payload is not None:
        parts.append(f"-d {payload!r}")
    parts.append(f'"{API_BASE}{path}"')
    out = docker_exec_script(" ".join(parts))
    if not out.strip():
        raise RuntimeError(f"empty response from {method} {path}")
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        print(f"raw: {out[:500]}", file=sys.stderr)
        raise


def login() -> str:
    """Login via docker exec. Returns session cookie value."""
    payload = json.dumps({"email": EMAIL, "password": PASSWORD})
    script = (
        "curl -s -c /tmp/cookies.txt -X POST "
        '-H "Content-Type: application/json" '
        f'-H "x-csrf-token: {CSRF_HEADER}" '
        f"-d {payload!r} "
        f'"{API_BASE}/auth/login"'
    )
    docker_exec_script(script)
    out = ssh_run("docker exec hl-pangolin cat /tmp/cookies.txt")
    for line in out.splitlines():
        if line.startswith("#HttpOnly_") and "p_session_token" in line:
            return line.split("\t")[-1]
    raise RuntimeError("no p_session_token cookie found")


def list_resources() -> list[dict]:
    return docker_exec_curl(method="GET", path=f"/org/{ORG_ID}/resources", cookie=True)["data"]["resources"]


def list_sites() -> list[dict]:
    return docker_exec_curl(method="GET", path=f"/org/{ORG_ID}/sites", cookie=True)["data"]["sites"]


def delete_resource(resource_id: int) -> dict:
    return docker_exec_curl(method="DELETE", path=f"/resource/{resource_id}", cookie=True, csrf=True)


def delete_site(site_id: int) -> dict:
    return docker_exec_curl(method="DELETE", path=f"/site/{site_id}", cookie=True, csrf=True)


def create_resource() -> dict:
    """Create resource with subdomain=null inside 'code2' domain → code2.antonshubin.com."""
    payload = json.dumps({
        "name": RESOURCE_NAME,
        "subdomain": None,
        "domainId": DOMAIN_ID,
        "mode": RESOURCE_MODE,
    })
    return docker_exec_curl(
        payload=payload, method="PUT", path=f"/org/{ORG_ID}/resource", cookie=True, csrf=True,
    )


def pick_site_defaults() -> dict:
    return docker_exec_curl(method="GET", path=f"/org/{ORG_ID}/pick-site-defaults", cookie=True)["data"]


def create_site(name: str, newt_id: str, secret: str, address: str) -> dict:
    payload = json.dumps({
        "name": name,
        "type": SITE_TYPE,
        "newtId": newt_id,
        "secret": secret,
        "address": address,
    })
    return docker_exec_curl(
        payload=payload, method="PUT", path=f"/org/{ORG_ID}/site", cookie=True, csrf=True,
    )


def create_target(resource_id: int, site_id: int, ip: str, port: int, method: str) -> dict:
    payload = json.dumps({
        "siteId": site_id,
        "ip": ip,
        "port": port,
        "method": method,
        "mode": "http",
        "enabled": True,
    })
    return docker_exec_curl(
        payload=payload, method="PUT", path=f"/resource/{resource_id}/target", cookie=True, csrf=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--newt-output", default="/tmp/pangolin-k11-newt.env")
    parser.add_argument("--skip-resource", action="store_true")
    parser.add_argument(
        "--rotate-site",
        action="store_true",
        help="Delete the existing k11 site (and its target) and recreate it for fresh newt creds",
    )
    args = parser.parse_args()

    print(">> Logging in...")
    cookie = login()
    print(f"   session: {cookie[:12]}…")

    if not args.skip_resource:
        print(">> Reconciling resources...")
        resources = list_resources()
        kept = None
        for res in resources:
            fqdn = res["fullDomain"]
            print(f"   - id={res['resourceId']} niceId={res['niceId']} FQDN={fqdn}")
            if fqdn == "code2.antonshubin.com":
                kept = res
                continue
            print(f"   ! deleting (wrong FQDN): {fqdn}")
            d = delete_resource(res["resourceId"])
            print(f"     {d['message']}")
        if kept is None:
            print(">> Creating resource code2.antonshubin.com...")
            c = create_resource()
            if not c["success"]:
                print(f"   ERROR: {c}")
                sys.exit(1)
            resource_id = c["data"]["resourceId"]
            print(f"   created id={resource_id} FQDN={c['data']['fullDomain']}")
        else:
            resource_id = kept["resourceId"]
            print(f">> Resource code2.antonshubin.com already exists (id={resource_id})")

    print(">> Reconciling sites...")
    sites = list_sites()
    k11_sites = [s for s in sites if s["name"] == SITE_NAME]
    site = None
    for s in k11_sites:
        if args.rotate_site:
            print(f"   ! rotating: deleting site id={s['siteId']} niceId={s['niceId']}")
            d = delete_site(s["siteId"])
            print(f"     {d['message']}")
            continue
        if s["resourceCount"] > 0:
            site = s
            print(f"   - siteId={s['siteId']} niceId={s['niceId']} (has {s['resourceCount']} target)")
        else:
            print(f"   ! deleting orphan site id={s['siteId']} niceId={s['niceId']} (no target)")
            d = delete_site(s["siteId"])
            print(f"     {d['message']}")

    if site is None:
        print(">> Getting site defaults + creating site...")
        defaults = pick_site_defaults()
        s = create_site(
            name=SITE_NAME,
            newt_id=defaults["newtId"],
            secret=defaults["newtSecret"],
            address=defaults["clientAddress"],
        )
        if not s["success"]:
            print(f"   ERROR: {s}")
            sys.exit(1)
        site = s["data"]
        defaults_to_save = defaults
        print(f"   created siteId={site['siteId']} niceId={site['niceId']}")
    else:
        # The API does not expose existing newtId/newtSecret after creation
        # (only the Argon2 hash is stored). If the previous env file is gone,
        # the only recovery is to delete this site and re-run the script.
        # Read the on-disk env file if it exists; otherwise refuse to write
        # bogus credentials.
        site_id = site["siteId"]
        if os.path.exists(args.newt_output):
            print(f"   ! Reusing site {site_id}; newt env already at {args.newt_output}")
            print(f"     (Delete {args.newt_output} + this site to force rotation.)")
            return
        print(f"   ! Site {site_id} exists but no env file at {args.newt_output}.")
        print("     The newtSecret is unrecoverable. To get fresh credentials:")
        print(f"       python3 stacks/pangolin/bootstrap.py --rotate-site")
        sys.exit(2)

    site_id = site["siteId"]

    # Re-list resource to see if a target for this site already exists
    print(">> Reconciling target...")
    resources = list_resources()
    target_exists = False
    for r in resources:
        if r["resourceId"] == resource_id:
            for t in r.get("targets", []):
                if t["siteId"] == site_id and t["ip"] == TARGET_IP and t["port"] == TARGET_PORT:
                    target_exists = True
                    print(f"   target already exists (targetId={t['targetId']})")
                    break
            break
    if not target_exists:
        print(f">> Creating target → {TARGET_IP}:{TARGET_PORT}...")
        t = create_target(
            resource_id=resource_id,
            site_id=site_id,
            ip=TARGET_IP,
            port=TARGET_PORT,
            method=TARGET_METHOD,
        )
        if not t["success"]:
            print(f"   ERROR: {t}")
            sys.exit(1)
        print(f"   targetId={t['data']['targetId']}")

    env_content = (
        f"PANGOLIN_ENDPOINT={defaults_to_save['endpoint']}\n"
        f"NEWT_ID={defaults_to_save['newtId']}\n"
        f"NEWT_SECRET={defaults_to_save['newtSecret']}\n"
    )
    with open(args.newt_output, "w") as f:
        f.write(env_content)
    os.chmod(args.newt_output, 0o600)
    print(f"\n>> Newt credentials written to {args.newt_output}")
    print(f"   Install on K11 with:")
    print(f"     curl -fsSL https://static.pangolin.net/get-newt.sh | bash -s -- --id {defaults_to_save['newtId']} --secret {defaults_to_save['newtSecret']} --endpoint {defaults_to_save['endpoint']}")


if __name__ == "__main__":
    main()
