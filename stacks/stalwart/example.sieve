# Sieve auto-folder rules — reference implementation
#
# This is the exact script that runs on each mailbox in the homelab.
# Two instances are deployed:
#   - anton@antonshubin.com  (accountId "b")
#   - anton@neatsoft.dev      (accountId "c")
#
# Both share the same script body — only the accountId differs when the
# script is uploaded via JMAP. See apply-sieve-filters.ts for the
# automation.
#
# The script auto-files three kinds of noise out of INBOX:
#
#   Reports/  — DMARC / TLS aggregate reports (kept for regression
#               signal; never auto-expire. Matches the failure counts
#               watched in issue #141.)
#   VCB/       — Vietnamese banking notifications.
#   Digests/   — recurring newsletters and digest emails.
#
# Anything that doesn't match any rule falls through to INBOX. In
# particular, wise.com (transfer notifications, statements) is
# INTENTIONALLY absent — those are real transactional mail.

require ["fileinto", "mailbox", "envelope", "comparator-i;ascii-numeric"];

# --- Reports: DMARC / TLS aggregate reports ---
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
if anyof (
    address :is "from" "info@info.vietcombank.com.vn",
    address :is "from" "VCBDigibank@info.vietcombank.com.vn"
) {
    fileinto "VCB";
    stop;
}

# --- Digests: newsletters and digest-style mail ---
# wise.com INTENTIONALLY absent — real transactional emails, belong in INBOX.
if anyof (
    address :is "from" "noreply@mail.selfh.st",
    address :is "from" "informer@daily.dev",
    address :is "from" "jsw@peterc.org",
    address :is "from" "node@cooperpress.com",
    address :is "from" "postgres@cooperpress.com",
    address :is "from" "newsletter@nodeweekly.com",
    address :is "from" "do-not-reply@singlife.com",
    address :is "from" "no-reply@agoda.com",
    address :is "from" "noreply@simba.sg",
    address :is "from" "no_reply@immigration.gov.vn",
    address :is "from" "no-reply@grab.com",
    address :is "from" "dvc_bca@noreply.vnpay.vn",
    address :matches "from" "*@meetup.com",
    address :is "from" "billing@ic.vrn.ru",
    header :contains "subject" "weekly",
    header :contains "subject" "digest",
    header :contains "subject" "newsletter",
    header :contains "subject" "roundup"
) {
    fileinto "Digests";
    stop;
}
