#!/usr/bin/env python3
"""
Open WebUI model + provider initializer.

Run after deploy to:
1. Sync provider config (api_base_urls, api_keys, api_configs) from env
   into the SQLite `config` table. Required because OpenWebUI reads
   provider config from the DB, not container env vars, via
   `get_openai_runtime_config()` (openai.py:276-283). If a Watchtower
   auto-update or schema migration wipes the DB-backed config, the
   3rd provider slot (MiniMax) is silently lost and chat returns
   the upstream's `insufficient balance (1008)` even though the key
   in env is correct.
2. Trim the model_order_list to the whitelisted models.
3. Set capabilities on whitelisted models.

Environment (passed via `docker exec -e` or compose env):
  OPENAI_API_KEYS         semicolon-separated API keys
  OPENAI_API_BASE_URLS    semicolon-separated OpenAI-compatible base URLs
  OPENAI_API_CONFIGS      JSON object keyed by provider index:
                          {"0": {"model_ids": [...]}, "2": {"model_ids": ["MiniMax-M3"]}}

Manual usage from host:
  ssh <server> "docker cp stacks/open-webui/init-models.py hl-open-webui:/tmp/ && \\
               docker exec -i -e OPENAI_API_KEYS=... -e OPENAI_API_BASE_URLS=... \\
                 -e OPENAI_API_CONFIGS=... \\
                 hl-open-webui python3 /tmp/init-models.py"

Or run directly inside the container with env vars already set
(it will use whatever is in the process environment).
"""
import json
import os
import sqlite3
import sys
import time

DB = "/app/backend/data/webui.db"

# Models that appear in the model selector (UI + /api/v1/models)
WHITELIST = [
    "MiniMax-M3",
    "gemma4:e4b",
    "gpt-5.4-mini",
]

# Capabilities enabled on all whitelisted models
CAPABILITIES = {
    "vision": True,
    "file_upload": True,
    "file_context": True,
    "web_search": True,
    "image_generation": True,
    "code_interpreter": True,
    "tools": True,
}


def sync_provider_config(cur: sqlite3.Cursor) -> None:
    """Write OPENAI_API_KEYS / OPENAI_API_BASE_URLS / OPENAI_API_CONFIGS
    into the SQLite config table so OWUI's runtime reads the same set
    the container env declares."""
    keys_raw = os.environ.get("OPENAI_API_KEYS", "")
    urls_raw = os.environ.get("OPENAI_API_BASE_URLS", "")
    cfgs_raw = os.environ.get("OPENAI_API_CONFIGS", "")

    if not keys_raw or not urls_raw:
        print("  SKIP     provider sync: OPENAI_API_KEYS / OPENAI_API_BASE_URLS not set")
        return

    keys = [k.strip() for k in keys_raw.split(";") if k.strip()]
    urls = [u.strip() for u in urls_raw.split(";") if u.strip()]

    if len(keys) != len(urls):
        print(f"  FAIL     provider key/url count mismatch: {len(keys)} keys vs {len(urls)} urls")
        sys.exit(1)

    cfgs: dict = {}
    if cfgs_raw.strip():
        try:
            parsed = json.loads(cfgs_raw)
            if isinstance(parsed, dict):
                for idx, val in parsed.items():
                    if not isinstance(val, dict):
                        continue
                    cfgs[str(idx)] = {
                        "enable": val.get("enable", True) is not False,
                        "model_ids": list(val.get("model_ids", [])),
                    }
        except json.JSONDecodeError as err:
            print(f"  WARN     OPENAI_API_CONFIGS not valid JSON, ignoring: {err}")

    now_ms = int(time.time() * 1000)
    cur.execute(
        "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)",
        ("openai.api_base_urls", json.dumps(urls), now_ms),
    )
    cur.execute(
        "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)",
        ("openai.api_keys", json.dumps(keys), now_ms),
    )
    cur.execute(
        "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)",
        ("openai.api_configs", json.dumps(cfgs), now_ms),
    )
    # Invalidate the in-memory model list cache so the next request
    # re-discovers from the new URLs.
    cur.execute(
        "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)",
        ("models.base_models_cache", "false", now_ms),
    )
    print(f"  SYNC     providers: {len(urls)} urls, {len(keys)} keys, {len(cfgs)} whitelists")


def sync_ui_model_order(cur: sqlite3.Cursor) -> None:
    """Trim model_order_list to the WHITELIST."""
    cur.execute("SELECT value FROM config WHERE key = 'ui.default_models'")
    row = cur.fetchone()
    if not row:
        return
    raw = row[0] if row else None
    try:
        current = json.loads(raw) if raw else ""
    except (json.JSONDecodeError, TypeError):
        current = ""
    desired = ",".join(WHITELIST)
    if current == desired:
        return
    cur.execute(
        "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)",
        ("ui.default_models", json.dumps(desired), int(time.time() * 1000)),
    )
    print(f"  DEFAULT  ui.default_models = {desired}")


def sync_model_capabilities(conn: sqlite3.Connection, cur: sqlite3.Cursor) -> None:
    """Activate whitelisted models and apply CAPABILITIES to their meta."""
    cur.execute("SELECT id, is_active FROM model")
    models = cur.fetchall()

    activated = hidden = 0
    for mid, active in models:
        if mid in WHITELIST and not active:
            cur.execute("UPDATE model SET is_active = 1 WHERE id = ?", (mid,))
            activated += 1
        elif mid not in WHITELIST and active:
            cur.execute("UPDATE model SET is_active = 0 WHERE id = ?", (mid,))
            hidden += 1

    for mid in WHITELIST:
        cur.execute("SELECT meta FROM model WHERE id = ?", (mid,))
        row = cur.fetchone()
        if not row:
            continue
        try:
            meta = json.loads(row[0]) if row[0] else {}
        except (json.JSONDecodeError, TypeError):
            meta = {}
        meta["capabilities"] = CAPABILITIES
        meta["featureIds"] = ["image_generation"]
        cur.execute(
            "UPDATE model SET meta = ? WHERE id = ?",
            (json.dumps(meta), mid),
        )

    conn.commit()
    print(
        f"  MODELS   active={activated} hidden={hidden} "
        f"of {len(WHITELIST)} whitelisted ({len(models) - len(WHITELIST)} others hidden)",
    )


def main() -> None:
    if not os.path.exists(DB):
        print(f"DB not found: {DB}")
        sys.exit(1)

    conn = sqlite3.connect(DB)
    cur = conn.cursor()

    sync_provider_config(cur)
    sync_ui_model_order(cur)
    sync_model_capabilities(conn, cur)

    conn.commit()
    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
