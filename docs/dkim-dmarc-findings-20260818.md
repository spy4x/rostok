# DKIM failures in Google's DMARC report — 2026-08-18

**Status:** Investigation paused, unresolved. Analysis is complete for the data
available; the next step needs a real outbound message (see §6). Written
2026-08-19 from the aggregate reports Google delivered for the 2026-08-18
window.

## 0. One-line summary

Ed25519 is contributing nothing — Google fails it on every message — so RSA
carries all DKIM. **RSA is also failing on mail sent directly from our own
server**, including *every* neatsoft.dev message in the window. Nothing is
being rejected today only because SPF passes; with `p=reject`, any forwarded
mail is one broken signature away from being dropped.

## 1. Source data

Three reports, all covering **2026-08-18 00:00:00Z – 23:59:59Z**:

| report | org | id |
|---|---|---|
| DMARC aggregate, `neatsoft.dev` | google.com | `14768369679615499220` |
| DMARC aggregate, `antonshubin.com` | google.com | `5117611635658124987` |
| SMTP TLS (MTA-STS) | Google Inc. | `2026-08-18T00:00:00Z_antonshubin.com` |

Published policy on both domains: `p=reject`, `sp=reject`, `np=reject`,
`pct=100`, `adkim=r`, `aspf=r`.

Reports are delivered to `postmaster@antonshubin.com` and
`postmaster@neatsoft.dev` — **not** `anton@` — per the `rua=` in each
`_dmarc` TXT record.

## 2. What the records actually say

`23.88.101.28` is our own cloud mail server. `2a00:1450:4864:20::346` is
Google, i.e. mail that reached them via a forward.

### antonshubin.com — 6 messages

| # | source | count | ed25519 | rsa | spf | evaluated | disposition |
|---|---|---|---|---|---|---|---|
| 1 | own server | 1 | **fail** | pass | pass | dkim=pass spf=pass | none |
| 2 | own server | 3 | **fail** | **fail** | pass | dkim=fail spf=pass | none |
| 3 | forwarded (Google) | 1 | **fail** | pass | fail | dkim=pass spf=fail | none |
| 4 | forwarded (Google) | 1 | **fail** | **fail** | fail | dkim=fail spf=fail | none (`local_policy`, `arc=pass`) |

### neatsoft.dev — 2 messages

| # | source | count | ed25519 | rsa | spf | evaluated | disposition |
|---|---|---|---|---|---|---|---|
| 1 | own server | 2 | **fail** | **fail** | pass | dkim=fail spf=pass | none |

### MTA-STS — healthy

`mode: enforce`, 4 successful sessions, **0 failures**. No action needed.

## 3. Ed25519: Google does not verify it

Ed25519 failed on **9 of 9 messages**, across both domains, from both direct
and forwarded paths, with no exceptions.

The decisive evidence is records 1 and 3 above: the *same message* had
Ed25519 fail and RSA pass. A message altered in transit breaks **both**
signatures — it cannot break only one. So this is not message integrity, and
it is not our keys.

Google has historically not verified RFC 8463 Ed25519 DKIM and reports it as
`fail` rather than omitting it. The practical consequence:

> **Dual-signing is not giving us redundancy at Google. RSA is a single point
> of failure for DKIM on the largest receiver we send to.**

That is not a reason to drop Ed25519 — other receivers do verify it, and it
costs nothing to keep publishing. It *is* a reason to treat any RSA failure
as a total DKIM failure rather than a partial one.

## 4. RSA: the actual problem

Ignoring the Ed25519 column entirely:

- **antonshubin.com:** 2 pass / 4 fail
- **neatsoft.dev:** 0 pass / 2 fail

Records 3 and 4 are forwarded mail, where SPF also fails — signatures
breaking in a forward is ordinary and not a misconfiguration. Record 4 is
worth noting anyway: it survived *only* because Google applied `local_policy`
on `arc=pass`. Without that it would have been rejected under `p=reject`.

The unexplained part is **direct sends from `23.88.101.28` failing RSA**:
3 messages on antonshubin.com (record 2) and both neatsoft.dev messages.
Forwarding cannot explain those — we are talking to Google directly.

## 5. Ruled out

Checked on 2026-08-19 against the live server; none of these is the cause.

- **Key/DNS mismatch.** `verifyActiveDkimDns()` from `stacks/stalwart/dkim.ts`
  (added in #131) compares every active signature's public key against the
  published TXT record:

  ```
  ✅ all 4 active signatures match their published TXT records
  ```

- **Stale or extra selectors in DNS.** Only the active `v1-*-20260702` pair is
  published on each domain; the superseded `20260629` selectors and the
  docker-mailserver-era `mail._domainkey.neatsoft.dev` were removed in #131.

- **Automatic key rotation racing DNS.** Both domains are pinned to
  `dkimManagement=Manual` (#131), so Stalwart is not minting selectors behind
  our back.

- **Signing misconfiguration.** All four signature objects report:

  ```
  canonicalization: relaxed/relaxed
  headers: From, To, Date, Subject, Message-ID
  expire: null        (no l= body-length tag)
  stage: active
  ```

  `relaxed/relaxed` is the forgiving choice, the signed header set is small
  (fewer headers to be rewritten), and there is no `l=` tag to truncate over.

## 6. What to do next

The data cannot take this further. One report-day with 2–6 messages per domain
is a small sample, and aggregate reports give no per-message detail — no
Message-ID, no headers, no failure reason.

**Get a real outbound message and verify its signature offline.** Either:

1. Send a test message from each domain to a Gmail address, then read the
   received `DKIM-Signature` and `Authentication-Results` headers; or
2. Read `postmaster@` / `anton@` directly and inspect recently sent mail.

Option 2 is currently blocked: `MAIL_AI_IMAP_PASSWORD` and
`MAIL_AI_NEATSOFT_PASSWORD` in `servers/cloud/.env` both fail authentication
(`A002 NO [AUTHENTICATIONFAILED]`), and there is no mail-ai container running
on cloud any more. Stalwart's admin JMAP session exposes only its own account
(`d333333 → admin`) and cannot read user mailboxes. Those two variables are
stale credentials sitting in the encrypted env — refresh or remove them.

Hypotheses worth testing once a message is in hand, roughly in order:

1. **Something modifies the message after signing.** Even one rewritten header
   from the signed set (`From`, `To`, `Date`, `Subject`, `Message-ID`) breaks
   RSA. Check whether anything sits between Stalwart's signer and the wire.
2. **A second submission path that signs differently or not at all.** The
   failures cluster — 3 at once on one domain, 2 of 2 on the other — which
   looks more like "a category of message" than random corruption. Automated
   mail (reports, bounces, cron notifications) is the obvious candidate;
   `report: true` is set on all four signature objects.
3. **Per-domain difference.** neatsoft.dev is 0/2 while antonshubin.com is
   2/4. If neatsoft.dev never passes, compare its domain object against
   antonshubin.com's rather than looking for a message-level cause.

## 7. Why this matters more than the disposition column suggests

Every record says `disposition: none` — nothing was rejected. That is not
reassurance:

- DMARC passed on the SPF leg, because `aspf=r` and the mail came straight
  from `23.88.101.28`. **SPF is the only thing keeping this mail deliverable.**
- SPF breaks on any forward — mailing lists, `.forward` rules, aliases. On
  those paths DKIM is the sole surviving authentication, and per §3 that means
  RSA alone.
- Record 4 already shows a message that failed both legs and was saved only by
  Google honouring ARC. That is a courtesy, not a guarantee, and other
  receivers may not extend it.

Under `p=reject`, the failure mode is not spam-foldering — it is a bounce.

## 8. Related

- #131 — manual DKIM management, deploy-time DNS verification, stale selector
  retirement. `stacks/stalwart/dkim.ts` holds the verification helpers used in
  §5 and is the right place to add any further checks.
- `docs/migrate-from-docker-mailserver-to-stalwart.md` — DKIM section, §8.3.
- `stacks/stalwart/README.md` — current selectors and rotation policy.
