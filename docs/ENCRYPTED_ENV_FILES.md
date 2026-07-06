# Encrypted Environment Files (age64)

Age64 encrypts each secret value **independently** with age. Only changed values
show in git diff — no more 200-line re-encryption noise from SOPS.

## Format

```
KEY=age64:YWdlLWVuY3J5cHRpb24ub3JnL3Yx...
```

Each `age64:base64...` is an age ciphertext for a single value. Non-secret values
stay as plaintext `KEY=VALUE` — readable in PRs.

## Prerequisites

Install age:

```bash
# macOS
brew install age

# Debian/Ubuntu
sudo apt install age

# Fedora/RHEL
sudo dnf install age

# Verify
age --version
```

## Quick Start

### 1. Set up the age key

```bash
mkdir -p .age && age-keygen -o .age/key.txt
```

The public key prints in the comment: `# public key: age1xxxx...`

### 2. Create / edit .env

```bash
cp servers/home/.env.example servers/home/.env
# Edit with your values
nano servers/home/.env
```

### 3. Encrypt

```bash
deno task env:encrypt
```

Produces `servers/home/.env.age` with age64-encrypted values.
Only changed values get re-encrypted — unchanged ciphertext stays identical byte-for-byte.

### 4. Decrypt (for deploy or editing)

```bash
deno task env:decrypt
```

Decrypts all age64 values back to plain `.env`.

## Workflow

```bash
# Edit secrets
vim servers/home/.env

# Re-encrypt (only changed lines)
deno task env:encrypt

# See clean diff
git diff servers/home/.env.age  # ← only YOUR changes shown

# Commit
git add servers/home/.env.age
git commit -m "fix(env): rotate CALDAV_PASSWORD"

# Deploy
deno task env:decrypt
deno task deploy home caldav-mcp
```

## File Structure

```
servers/
└── home/
    ├── .env.age          # ✅ age64-encrypted (safe in Git)
    ├── .env.example      # ✅ Template (safe in Git)
    └── .env              # ❌ Decrypted (gitignored)
.age/
└── key.txt               # ❌ Secret key (gitignored, in main repo)
```

## Key Management

### Personal Key

Key lives at `<repo-root>/.age/key.txt`. This is shared across git worktrees
(the key file only exists in the main repo checkout).

### Sharing Access

To allow multiple people to decrypt, share the `.age/key.txt` file securely
(password manager, encrypted storage). Age supports multiple recipients, but
the current scripts use a single key. For multi-key setups, extend
`scripts/encryption/age-lib.ts` to accept multiple recipients.

### Security

- **Age uses X25519 + ChaCha20Poly1305** (modern, audited)
- **Each value authenticated individually** — tampering detected per-value
- **No file-level MAC** (vs SOPS) — intentional tradeoff for stable diffs
- **Key rotation**: re-encrypt all values with new key (one-time script)

## Commands Reference

| Command | Description |
|---------|-------------|
| `deno task env:encrypt` | `.env` → `.env.age` (diff-based, only changed values) |
| `deno task env:decrypt` | `.env.age` → `.env` (decrypts age64) |

## Troubleshooting

### "No age key found"
```bash
# Ensure .age/key.txt exists
find /path/to/main/repo -path "*/.age/key.txt"
chmod 600 .age/key.txt
```

### "Failed to decrypt value"
Ensure the age key matches what was used to encrypt. Keys are at
`<repo-root>/.age/key.txt`.

## Why age64?

age64 encrypts each value independently with age. Compared to the previous
SOPS-based approach:

- **Stable diffs**: only changed values show in `git diff`
- **No merge conflicts**: branches editing different vars don't conflict
- **Fewer deps**: age only, no SOPS needed
- **Tradeoff**: per-value AEAD instead of file-level MAC; key rotation requires re-encrypting all values

## Resources

- [Age Documentation](https://github.com/FiloSottile/age)
- [Age Encryption Format](https://github.com/C2SP/C2SP/blob/main/age.md)
