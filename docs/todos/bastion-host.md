# Bastion Host / Jump Box Architecture

Reduce the SSH attack surface from N public endpoints to 1 by routing all
server access through a hardened bastion.

## Rationale

| Today | With Bastion |
|---|---|
| 4 servers expose SSH publicly (home, cloud, offsite, demo) | 1 server exposes SSH publicly (cloud) |
| Firewall and fail2ban on every host | Hardened focus on one entry point |
| Home's outage takes down deploy/ansible access to all other servers | Cloud (always-on Hetzner) stays reachable regardless of home's state |

## Server Role Assignment

**Bastion** → **cloud** (Hetzner VM, always-on, stable power/internet)

**Internal servers** → **home**, **offsite**, **demo**

Cloud is the best choice: it's a professional VM with SLA-backed uptime,
unlike home (gaming PC in a Singapore HDB flat prone to power/internet
outages).

---

## Option A — SSH Bastion with ProxyJump

Lightest-weight approach. Cloud remains the only server with SSH open on
the firewall. All other servers close their SSH port. Access is via SSH
ProxyJump (`-J` flag).

### Traffic Flow

```
You ──SSH──► cloud (public, port <custom>) ──SSH──► home (private)
                                                ──SSH──► offsite (private)
                                                ──SSH──► demo (private)
```

Connection is transparent — `ssh -J spy4x@cloud:port spy4x@home`
connects you directly. SSH config aliases hide the complexity.

### Changes Required

#### 1. Close SSH ports on internal servers

Update `.env.example` for `home`, `offsite`, `demo` — remove the SSH
port from `FIREWALL_PORTS`. Re-run the firewall Ansible playbook.

No changes to the playbook itself (`firewall.yml` reads from env).

#### 2. Add bastion env vars to internal servers

Each internal server's `.env` / `.env.example` gains:

```bash
# Bastion (jump host) for SSH access
BASTION_ADDRESS=<cloud-public-ip-or-hostname>
BASTION_PORT=<cloud-ssh-port>
BASTION_USER=spy4x
```

Cloud's own `.env` needs nothing — it is the bastion.

#### 3. Update `scripts/ssh/+main.ts` (SSH helper)

When the target server has `BASTION_ADDRESS` set, insert a `-J` flag:

```typescript
// Before: direct SSH
const cmd = new Deno.Command("ssh", { args: [sshAddress], ... })

// After: ProxyJump through bastion
const args = bastionAddress
  ? ["-J", `${bastionUser}@${bastionAddress}:${bastionPort}`, sshAddress]
  : [sshAddress]
```

#### 4. Update `scripts/deploy/+main.ts`

Every `ssh SSH_ADDRESS` call needs a bastion-aware helper:

```typescript
function sshCmd(args: string[]): string[] {
  const bastion = Deno.env.get("BASTION_ADDRESS")
  return bastion
    ? ["ssh", "-J", `${user}@${bastion}:${port}`, Deno.env.get("SSH_ADDRESS")!, ...args]
    : ["ssh", Deno.env.get("SSH_ADDRESS")!, ...args]
}
```

Replace all `runCommand(["ssh", SSH_ADDRESS, ...])` with
`runCommand([...sshCmd([...])])`. Affected calls:
- `getRemoteChecksums()` — single command via SSH
- `generateVolumeCreationScript()` execution
- `deployScript` execution

#### 5. Update `scripts/ansible/inventory.ts`

Ansible supports ProxyJump natively via `ansible_ssh_common_args`. Add
to hostvars for non-bastion hosts:

```typescript
inventory._meta.hostvars[server] = {
  ansible_host: host,
  ansible_user: user,
  ansible_ssh_common_args: env.BASTION_ADDRESS
    ? `-J ${env.BASTION_USER}@${env.BASTION_ADDRESS} -p ${env.BASTION_PORT}`
    : "",
  // ... existing vars
}
```

No playbook changes needed — Ansible picks this up from inventory.

#### 6. Update `servers/cloud/.env.example`

Keep SSH port open, optionally add rate-limiting / source-IP restrictions.

#### 7. Adjust fail2ban configs

Only cloud needs the SSH fail2ban jail enabled. The internal servers'
SSH jails become redundant (no public SSH port). They can be removed from
the Ansible fail2ban template or simply left inactive.

### Caveats

- **Latency**: All SSH connections route through cloud's Hetzner DC
  (Germany). If you're in Singapore, expect ~200ms added latency.
- **Home outage**: If both home *and* cloud go down, you're locked out of
  home until cloud comes back up. Mitigated by cloud's SLA.
- **Single point of compromise**: Compromising cloud gives SSH access to
  all internal servers. Mitigated by key-only auth + fail2ban + keeping
  the bastion minimal (no Docker stacks beyond what's needed).

---

## Option B — WireGuard VPN Mesh

Runs WireGuard on *all* servers as a mesh VPN. SSH ports are closed on
*every* server (including cloud). All management traffic flows over the
encrypted WireGuard overlay network.

### Traffic Flow

```
You ──WG──► cloud (public, 51820/udp)
     │       │
     │       ├──WG──► home (10.0.0.2)
     │       ├──WG──► offsite (10.0.0.3)
     │       └──WG──► demo (10.0.0.4)
     │
     └── SSHs to cloud's WireGuard IP (10.0.0.1)
         └── ProxyJump from there to internal WG IPs
```

**Key difference from Option A**: Not even the bastion has SSH open.
Access is *only* over the encrypted WireGuard tunnel on UDP 51820.

### Changes Required

#### 1. Extend WireGuard to all servers

You already run `stacks/wireguard` on home. It uses
[lscr.io/linuxserver/wireguard](https://docs.linuxserver.io/images/docker-wireguard/)
with `PEERS` to generate configs. Cloud, offsite, and demo need their own
WireGuard instances.

For cloud (Hetzner Fedora), WireGuard runs as a Docker container or
natively. Docker is preferred (follows the existing pattern):

```bash
# stacks/wireguard-cloud/ or reuse stacks/wireguard per-server
# each server gets its own WireGuard stack with unique peers
```

#### 2. Assign WireGuard mesh IPs

```
cloud:   10.0.0.1/24     (public endpoint: <cloud-ip>:51820)
home:    10.0.0.2/24     (connects to cloud WG as peer)
offsite: 10.0.0.3/24     (connects to cloud WG as peer)
demo:    10.0.0.4/24     (connects to cloud WG as peer)
```

Each server runs WireGuard and connects to the mesh. Cloud acts as the
mesh hub (all peers connect to it). For redundancy, home and offsite could
also peer directly.

#### 3. Update Ansible inventory

WireGuard IPs replace public SSH addresses for internal access:

```typescript
inventory._meta.hostvars["home"] = {
  ansible_host: "10.0.0.2",
  ansible_user: "spy4x",
  ansible_ssh_common_args: "-J 10.0.0.1",  // jump via cloud WG IP
  // ... existing vars
}
```

Ansible commands route over WireGuard automatically.

#### 4. Update deploy script

The deploy script's SSH calls use the WireGuard IP directly. No `-J`
needed if you SSH to the WG IP — but for convenience, still jump
through cloud's WG IP so only one WG endpoint is needed from your
client.

Alternatively, your *client machine* connects to the WireGuard mesh as
a peer too:

```
You (client) ──WG──► cloud (10.0.0.1) ──WG──► home (10.0.0.2)
                   ──WG──► offsite (10.0.0.3)
                   ──WG──► demo (10.0.0.4)
```

Then all SSH is direct to WireGuard IPs — no ProxyJump needed at all.
This is the cleanest setup but requires your client to be a WG peer.

#### 5. Update `scripts/ssh/+main.ts`

Read WireGuard IP from `.env` and use it directly:

```typescript
const sshAddress = wgAddress || publicSSHAddress
```

If `WG_ADDRESS` is set, SSH goes over the VPN. Otherwise fall back to
public SSH (for cloud, the bastion).

#### 6. Close all public SSH ports

Every server (including cloud) removes SSH from `FIREWALL_PORTS`. Only
`51820/udp` (WireGuard) is public on cloud. Home, offsite, demo have
nothing public for remote access.

#### 7. Update WireGuard stack (`stacks/wireguard/compose.yml`)

If reusing the existing stack, add a `deployAs` config or per-server
WireGuard configs. Each server needs:
- Unique `SERVERURL` (or same endpoint for cloud, others connect to it)
- `PEERS` config specifying which peers connect
- Exposed `51820:51820/udp` port

### Benefits Over Option A

- **No public SSH at all** — not even the bastion
- **Full traffic encryption** — all inter-server traffic (Ansible, rsync,
  backup transfers) is over WireGuard
- **No extra latency** — once the tunnel is up, SSH is direct between WG
  IPs (or single-hop through cloud)
- **Resilient** — you can make WG mesh fully peering (home↔offsite direct)
  so cloud being down doesn't block home↔offsite access
- **L4 firewall bypass** — useful if a server is behind NAT or restrictive
  firewalls (tunnel out to cloud)

### Costs

- **More setup** — each server needs WireGuard configured and key exchange
- **More moving parts** — WireGuard containers, key management, peer
  rotation
- **UDP might be blocked** — some networks block UDP 51820. HTTP-over-WG
  via a fallback TCP tunnel can mitigate this.
- **Key management** — losing the WireGuard private key = locked out of
  all servers until you console in

---

## Comparison

| Criterion | SSH Bastion (A) | VPN Mesh (B) |
|---|---|---|
| Effort | ~20 lines of code changes | New stack per server, config |
| Public ports | 1 (SSH on cloud) | 1 (UDP 51820 on cloud) |
| Attack surface | SSH daemon (hardened) | WireGuard (noise protocol, no listener daemon) |
| Latency | +200ms via Hetzner DC | WireGuard is line-speed |
| Key mgmt | SSH keys (existing) | SSH keys + WireGuard keys |
| Home outage impact | Can't deploy to home, but cloud/offsite still reachable | Can't reach home (WG peer down), but cloud/offsite still reachable |
| Ansible changes | `ansible_ssh_common_args: "-J ..."` | `ansible_host: 10.0.0.x` + `-J` |
| Deploy script changes | Helper function for `-J` | Read `WG_ADDRESS` from env |
| Client VPN needed? | No (just SSH client) | Yes (client must be a WG peer or SSH through cloud WG) |
| Existing infra reuse | SSH hardening (already done) | WireGuard stack (already on home) |
| Inter-server traffic | Unencrypted (over internet) | Encrypted (over WireGuard) |

## Recommendation

**Phase 1 — Start with Option A (SSH Bastion)**. It's minimal code
changes, reuses existing SSH hardening, and doesn't require running
WireGuard on Hetzner/RPi. The biggest win — reducing attack surface from
4 to 1 — is achieved immediately.

**Phase 2 — Migrate to Option B (VPN Mesh)** if any of these apply:
- You want to close the last public port entirely
- You're doing frequent inter-server rsync/backup transfers that benefit
  from encryption
- Home's outage frequency makes cloud-only ProxyJump unreliable
  (you'd add home as alternative bastion or peer directly)

## Files Changed Summary

### Option A (SSH Bastion)

| File | Change |
|---|---|
| `servers/home/.env.example` | Add `BASTION_ADDRESS`, `BASTION_PORT`, `BASTION_USER`; remove SSH from `FIREWALL_PORTS` |
| `servers/offsite/.env.example` | Same |
| `servers/demo/.env.example` | Same |
| `scripts/ssh/+main.ts` | Conditional `-J` flag when `BASTION_ADDRESS` is set |
| `scripts/deploy/+main.ts` | `sshCmd()` helper wrapping all SSH calls with `-J` |
| `scripts/ansible/inventory.ts` | `ansible_ssh_common_args` for non-bastion hosts |

### Option B (VPN Mesh) — Option A changes plus:

| File | Change |
|---|---|
| `stacks/wireguard/compose.yml` | Parameterise for per-server deployment (or create `stacks/wireguard-node/`) |
| `servers/cloud/.env.example` | Add `WG_ADDRESS`, `VPN_SUBDOMAIN`; remove `SSH_PORT` from `FIREWALL_PORTS` |
| `servers/home/.env.example` | Add `WG_ADDRESS` |
| `servers/offsite/.env.example` | Add `WG_ADDRESS` |
| `servers/demo/.env.example` | Add `WG_ADDRESS` |
| `scripts/ssh/+main.ts` | Prefer `WG_ADDRESS` over public SSH |
| `scripts/ansible/inventory.ts` | Use `WG_ADDRESS` as `ansible_host` for mesh |
| `servers/cloud/config.json` | Add `wireguard` to stacks |
| `servers/offsite/config.json` | Add `wireguard` to stacks |
| `servers/demo/config.json` | Add `wireguard` to stacks |
