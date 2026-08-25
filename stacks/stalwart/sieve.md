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

# ============================================================
# Auto-folder rules for anton@antonshubin.com
# Auto-generated via JMAP by homelab cleanup, 2026-08-25
# ============================================================

# --- Reports: DMARC / TLS aggregate reports ---
# These are noise we want out of INBOX but kept for regression signal.
# Sources: Google, mail.ru, amazonses (Google forwarding).
if anyof (
    address :is "from" "noreply-dmarc-support@google.com",
    address :is "from" "noreply-smtp-tls-reporting@google.com",
    address :is "from" "postmaster@amazonses.com",
    address :is "from" "dmarc_support@corp.mail.ru"
) {
    fileinto "Reports";
    stop;
}

# --- VCB: Vietcombank banking notifications ---
# Transaction notifications, marketing — all noise.
if anyof (
    address :is "from" "info@info.vietcombank.com.vn",
    address :is "from" "VCBDigibank@info.vietcombank.com.vn"
) {
    fileinto "VCB";
    stop;
}

# --- Digests: newsletters and digest-style mail ---
# All known recurring digests/newsletters. Anything that fails anyof here
# stays in INBOX. Subject keywords catch subjects like "Weekly", "Issue",
# "digest" that we haven't enumerated by sender yet.
#
# Note: wise.com is INTENTIONALLY absent — those are real transactional
# emails (transfer notifications, statements) that belong in INBOX.
if anyof (
    # known digest/newsletter senders
    address :is "from" "noreply@mail.selfh.st",
    address :is "from" "informer@daily.dev",
    address :is "from" "jsw@peterc.org",
    address :is "from" "node@cooperpress.com",
    address :is "from" "postgres@cooperpress.com",
    address :is "from" "newsletter@nodeweekly.com",
    address :is "from" "do-not-reply@singlife.com",
    address :is "from" "no-reply@agoda.com",
    address :is "from" "noreply@simba.sg",
    # other notifications digests
    address :is "from" "no_reply@immigration.gov.vn",
    address :is "from" "no-reply@grab.com",
    address :is "from" "dvc_bca@noreply.vnpay.vn",
    # meetup.com newsletters (event digest emails — high volume)
    address :matches "from" "*@meetup.com",
    # Russian invoicing/billing digests
    address :is "from" "billing@ic.vrn.ru",
    # generic: subject keywords
    header :contains "subject" "weekly",
    header :contains "subject" "digest",
    header :contains "subject" "newsletter",
    header :contains "subject" "roundup"
) {
    fileinto "Digests";
    stop;
}
```

## Sender notes

- **wise.com (`noreply@wise.com`)** — REMOVED from filters. These are
  real transactional emails (transfer notifications, statements).
  Belongs in INBOX.
- **meetup.com (`*@meetup.com`)** — Event digest emails, high volume.
  Folder: `Digests/`.
- **billing@ic.vrn.ru** — Russian invoicing/billing. Folder: `Digests/`.

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

Updating an existing script requires deactivating it first
(`update {id: {isActive: false}}`) before you can destroy it, otherwise
Stalwart returns `scriptIsActive`. Trying to create a script with the
same name as an existing one returns `alreadyExists`. So the workflow
to update is:

1. `SieveScript/set` with `update {existingId: {isActive: false}}`
2. `SieveScript/set` with `destroy [existingId]`
3. `Blob/upload` to upload the new source
4. `SieveScript/set` with `create {sameName: {blobId, name, isActive: true}}`

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
