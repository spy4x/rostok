# Sieve auto-folder rules — reference implementation
#
# This is the exact script that runs on each mailbox in the homelab.
# Two instances are deployed:
#   - user@example.com     (accountId "b")
#   - user@example.org      (accountId "c")
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
#   BANK/       — Banking notifications.
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

# --- BANK: Example Bank banking notifications ---
if anyof (
    address :is "from" "info@bank.example.com",
    address :is "from" "digibank@bank.example.com"
) {
    fileinto "BANK";
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
    address :is "from" "do-not-reply@insurer.example.com",
    address :is "from" "no-reply@travel.example.com",
    address :is "from" "noreply@telecom.example.com",
    address :is "from" "no_reply@immigration.example.gov",
    address :is "from" "no-reply@rides.example.com",
    address :is "from" "notify@payments.example.com",
    address :matches "from" "*@meetup.com",
    address :is "from" "billing@invoices.example.com",
    header :contains "subject" "weekly",
    header :contains "subject" "digest",
    header :contains "subject" "newsletter",
    header :contains "subject" "roundup"
) {
    fileinto "Digests";
    stop;
}
