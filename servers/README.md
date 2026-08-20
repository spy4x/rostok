# servers/

Per-server configuration. Only `servers/demo/` is tracked in git — it is a
public template showing the minimum setup. Real server configs (`cloud/`,
`home/`, `offsite/`, `portable/`) are **gitignored**: they contain IPs,
domains, secrets, and per-host tweaks that must not be public. The gitignore
keeps them on disk so the existing toolchain (deploy, backup, env encryption)
still works locally.

## Layout

```
servers/
├── demo/        # PUBLIC template — tracked in git
├── cloud/       # PRIVATE — gitignored, on disk only
├── home/        # PRIVATE — gitignored, on disk only
├── offsite/     # PRIVATE — gitignored, on disk only
└── portable/    # PRIVATE — gitignored, on disk only
```

Each private server directory contains the same shape as `demo/`:

```
servers/<name>/
├── .env          # gitignored — decrypted secrets for local + deploy
├── .env.age      # gitignored — encrypted secrets (committed nowhere)
├── .env.example  # public template (only tracked in servers/demo/)
├── config.json   # which stacks from the catalog to deploy
├── configs/      # per-service overrides (gatus, traefik, syncthing, ...)
└── README.md     # server-specific notes
```

## Bootstrapping a new server

1. Copy the demo template and rename it:

   ```bash
   cp -r servers/demo servers/<newhost>
   cd servers/<newhost>
   ```

2. Edit `.env.example` with your placeholders, then create the real `.env`
   and fill in actual values. Required keys (see `servers/demo/.env.example`):

   - `SSH_ADDRESS`, `SSH_PORT`, `HOMELAB_USER` — how `deno task deploy` reaches the host
   - `DOMAIN`, `CONTACT_EMAIL` — TLS + ACME
   - `BACKUPS_PASSWORD`, `NTFY_TOKEN_BACKUPS`, `GATUS_NTFY_TOKEN` — monitoring + backup

3. Pick which stacks to deploy in `config.json` — see the catalog at
   [`../stacks/`](../stacks/). Cross-server monitoring convention: each
   server's gatus monitors services on the _opposite_ server.

4. Add the new private directory to `.gitignore` (top-level `.gitignore`,
   under "Private server directories") so a stray `git add -A` cannot
   leak it.

5. Provision the host (firewall, fail2ban, users) via Ansible:

   ```bash
   deno task ansible ansible/playbooks/initial-setup.yml <newhost>
   ```

6. Deploy:

   ```bash
   deno task deploy <newhost>
   ```

7. Encrypt the env so Syncthing + the backup pipeline can carry it to other
   machines safely:

   ```bash
   deno task env:encrypt
   ```

## Cloning this repo on a new machine

The repo no longer carries private server configs or encrypted env files.
To restore full local functionality on a fresh clone:

1. Clone the repo.
2. Restore the age key (one-time, never commit):

   ```bash
   mkdir -p .age
   # Copy from your password manager, an existing machine, or a Syncthing-synced
   # backup location. Path is gitignored (.age/ is in .gitignore).
   cp /path/to/key.txt .age/key.txt
   chmod 600 .age/key.txt
   ```

3. Pull the `servers/<name>/` directories from Syncthing (they live in the
   shared folder) or from a restic restore. The directories must exist on
   disk for `deno task env:decrypt` to find the `.env.age` files inside.

4. Decrypt envs:

   ```bash
   deno task env:decrypt
   deno task hooks:install   # auto-decrypt on every checkout
   ```

5. Verify:

   ```bash
   deno task check
   deno task deploy <server> --dry-run   # or just deploy
   ```

## Backup strategy

Private server dirs and their `.env.age` files are **not** in git, but they
are still durable:

- **Syncthing** syncs `servers/` between the user's machines in real time
  (the `syncthing` stack is part of every server's `config.json`).
- **Restic** (see `../scripts/backup/`) backs up each server's `servers/`
  directory plus the host's other data into an offsite repo.
- **Offline backup** (`deno task offline-backup`) writes a monthly snapshot
  to an external drive kept physically separate.

Losing a server directory means restoring from one of those channels —
not `git clone`. Treat the repo as a catalog of _stacks_; the per-server
state lives on the servers themselves and in the backup chain.
