#!/usr/bin/env python3
"""
Model initializer for Open WebUI.
Run this after deploy to whitelist models and set capabilities.
Kept in repo for reproducibility.

Usage:
  docker cp init-models.py hl-open-webui:/tmp/ && docker exec hl-open-webui python3 /tmp/init-models.py

Or from the host:
  ssh homelab "docker cp stacks/open-webui/init-models.py hl-open-webui:/tmp/ && docker exec hl-open-webui python3 /tmp/init-models.py"
"""

import sqlite3, json, sys, os

DB = "/app/backend/data/webui.db"

# Models that appear in the model selector
WHITELIST = [
    "MiniMax-M3",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
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


def main():
    if not os.path.exists(DB):
        print(f"DB not found: {DB}")
        sys.exit(1)

    conn = sqlite3.connect(DB)
    cur = conn.cursor()

    # Trim model_order_list in config (controls the UI selector order)
    # Set api_configs per provider (whitelists which models each API returns)
    cur.execute("SELECT id, data FROM config WHERE id = 1")
    config_row = cur.fetchone()
    if config_row:
        config = json.loads(config_row[1])

        if "ui" in config and "model_order_list" in config["ui"]:
            old_count = len(config["ui"]["model_order_list"])
            config["ui"]["model_order_list"] = list(WHITELIST)
            print(f"  ORDER    trimmed {old_count} -> {len(WHITELIST)} entries")

        # Per-provider model whitelist (prevents API from returning unwanted models)
        api_configs = config.get("openai", {}).get("api_configs", {})
        api_configs["0"] = {"enable": True, "model_ids": ["deepseek-v4-flash", "deepseek-v4-pro"]}
        api_configs["1"] = {"enable": True, "model_ids": ["gpt-5.4-mini"]}
        api_configs["2"] = {"enable": True, "model_ids": ["MiniMax-M3"]}
        config["openai"]["api_configs"] = api_configs
        print(f"  FILTER   set api_configs per provider")

        cur.execute(
            "UPDATE config SET data = ? WHERE id = 1",
            (json.dumps(config),),
        )

    cur.execute("SELECT id, is_active FROM model")
    models = cur.fetchall()

    changed = 0
    for mid, active in models:
        if mid in WHITELIST and not active:
            cur.execute("UPDATE model SET is_active = 1 WHERE id = ?", (mid,))
            print(f"  ACTIVE   {mid}")
            changed += 1
        elif mid not in WHITELIST and active:
            cur.execute("UPDATE model SET is_active = 0 WHERE id = ?", (mid,))
            print(f"  HIDDEN   {mid}")
            changed += 1

    for mid in WHITELIST:
        cur.execute("SELECT meta FROM model WHERE id = ?", (mid,))
        row = cur.fetchone()
        if row:
            meta = json.loads(row[0]) if row[0] else {}
            meta["capabilities"] = CAPABILITIES
            meta["featureIds"] = ["image_generation"]
            cur.execute(
                "UPDATE model SET meta = ? WHERE id = ?",
                (json.dumps(meta), mid),
            )
            print(f"  CAPS     {mid}")

    conn.commit()
    conn.close()

    active = sum(1 for m in models if m[0] in WHITELIST)
    print(f"\nDone. {len(WHITELIST)} models active, {len(models) - len(WHITELIST)} hidden.")


if __name__ == "__main__":
    main()
