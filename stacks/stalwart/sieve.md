# Stalwart — auto-foldering with Sieve

The Stalwart mail server has a JMAP Sieve interface
(`urn:ietf:params:jmap:sieve`) for client-side rules. The most common
use is to keep the INBOX tidy — newsletter noise and bounce notices get
filed automatically without needing separate mail clients.

## Recommended setup: noise buckets

Create three subfolders in INBOX, then push a Sieve script that moves
matches into them:

- **`Reports/`** — DMARC / TLS aggregate reports (Google, mail.ru,
  amazonses forwarding). Kept for ongoing regression signal — never
  auto-delete. The failure counts in these match what `#141` watches.
- **`VCB/`** — Vietnamese banking notifications
  (`info.vietcombank.com.vn`, `VCBDigibank@info.vietcombank.com.vn`).
  Move out of INBOX so they don't bury real correspondence.
- **`Digests/`** — recurring newsletters and digest emails. Subject
  keywords (`weekly`, `digest`, `newsletter`, `roundup`) catch the ones
  we haven't enumerated by sender.

`Reports/` is the noisy one but never auto-expire — it's your canary
for DKIM / SPF / DMARC changes. Delete older entries manually if it
fills up.

## Active setup (as of 2026-08-25)

The script is currently uploaded for `anton@antonshubin.com`. Apply
the same pattern to other mailboxes with a tweaked sender list.

```sieve
require ["fileinto", "mailbox", "envelope", "comparator-i;ascii-numeric"];

# --- Reports: DMARC / TLS aggregate reports ---
if anyof (
    address :is "from" "noreply-dmarc-support@google.com",
    address :is "from" "noreply-smtp-tls-reporting@google.com",
    address :is "from" "postmaster@amazonses.com",
    address :is "from" "dmarc_support@corp.mail.ru"
) {
    fileinto "Reports";
    stop;
}

# Repeat the same pattern for VCB and Digests.
```

## Applying a Sieve script via JMAP

Stalwart exposes the full Sieve management API over JMAP, but the method
names use the `SieveScript*` prefix (not `Sieve*`):

| Intent                  | Method                  |
|-------------------------|-------------------------|
| Upload the script       | `Blob/upload`           |
| Find existing scripts   | `SieveScript/query`     |
| Delete a script         | `SieveScript/set` (destroy) |
| Activate a script       | `SieveScript/set` (create `{blobId, name, isActive: true}`) |
| Validate                | not exposed via JMAP — validate by reading error logs after activation |

Every method call needs a client id (the third tuple element). Without
it Stalwart rejects the request as `notRequest`.

Minimal working sequence (Python, using `urllib.request`):

```python
import json, urllib.request, base64

AUTH = "user:pass"  # mailbox credentials, base64 below
API = "https://mail.antonshubin.com/jmap/"
auth = "Basic " + base64.b64encode(AUTH.encode()).decode()

def call(name, args, cid):
    return [name, args, cid]

using = [
    "urn:ietf:params:jmap:core",
    "urn:ietf:params:jmap:mail",
    "urn:ietf:params:jmap:blob",
    "urn:ietf:params:jmap:sieve",
]

body = {"using": using, "methodCalls": [
    call("Blob/upload", {
        "accountId": "b",
        "create": {"s1": {"data": [{"data:asText": open("filters.sieve").read()}],
                       "type": "text/plain"}}
    }, "u"),
    call("SieveScript/set", {
        "accountId": "b",
        "create": {"filters": {"blobId": "TBD", "name": "filters", "isActive": True}}
    }, "c"),
]}

# Two-step is easier — get blob id first, then create:
r = urllib.request.urlopen(urllib.request.Request(API, data=json.dumps(
    {"using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:blob"],
     "methodCalls": [call("Blob/upload", body["methodCalls"][0][1], "u")]}).encode(),
    headers={"Authorization": auth, "Content-Type": "application/json"}))
blob_id = json.loads(r.read())["methodResponses"][0][1]["created"]["s1"]["id"]

body["methodCalls"][1][1]["create"]["filters"]["blobId"] = blob_id
body["methodCalls"][1] = call("SieveScript/set",
    body["methodCalls"][1][1], "c")
r = urllib.request.urlopen(urllib.request.Request(API,
    data=json.dumps(body).encode(),
    headers={"Authorization": auth, "Content-Type": "application/json"}))
print(json.loads(r.read()))
```

After activation, sending a test message from any of the filtered senders
results in the new mail landing in the target folder instead of INBOX.

## Why not auto-delete reports?

Reports are the only signal you have that something regressed
(DKIM signing broken, SPF record stale, TLS chain expired). Worth keeping
in `Reports/` for at least one full DMARC reporting cycle (24h × all
receivers). The 6 reports Google currently sends per day take ~5 KB
each — even a year of reports fits comfortably.

## Background: where this came from

The `homelab/servers/home/.env` file has had `EMAIL_MCP_*` password
rotation notes since 2026-08-23 and started receiving DKIM-related noise
in the user inbox. The DKIM investigation (issue #141) confirmed:

- DKIM signing is working for new outbound (RSA pass on every report
  since 2026-08-19)
- Ed25519 fails because Google does not verify RFC 8463
- Mail is being delivered normally (Google reports `disposition: none`)
- The reports will keep coming forever — Ed25519 is noise, not a bug

So Sieve is the right answer: keep the regression signal in `Reports/`,
don't let it crowd INBOX.
