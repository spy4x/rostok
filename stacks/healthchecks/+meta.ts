// Stack metadata for `healthchecks`.
//
// Healthchecks: cron job monitoring (jobs ping a URL, alerts fire when a ping is missing).
//
// - HEALTHCHECKS_SECRET_KEY: Django secret, generated.
// - HEALTHCHECKS_SMTP_*: optional, no default, so `stack add -n` still deploys. Healthchecks logs
//   people in with an emailed link, so without SMTP the only way in is
//   `docker exec -it hl-healthchecks /opt/healthchecks/manage.py createsuperuser`
//   (see the README). Port defaults to 587 because an empty EMAIL_PORT crashes Django.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "healthchecks",
  description: "Cron job and scheduled task monitoring with alerts for missed pings",
  category: "monitoring",
  requires: ["traefik"],
  variables: [
    {
      key: "HEALTHCHECKS_IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "HEALTHCHECKS_DOMAIN",
      question: "Public domain for Healthchecks?",
      default: "healthchecks.${DOMAIN}",
      required: true,
    },
    {
      key: "HEALTHCHECKS_SECRET_KEY",
      default: () => generatePassword(50),
      required: true,
      secret: true,
    },
    {
      key: "HEALTHCHECKS_SMTP_HOST",
      question: "SMTP host for login and alert emails? Leave blank to skip",
      required: false,
    },
    {
      key: "HEALTHCHECKS_SMTP_PORT",
      question: "SMTP port (STARTTLS)?",
      default: "587",
      required: false,
    },
    {
      key: "HEALTHCHECKS_SMTP_USERNAME",
      question: "SMTP username? Leave blank to skip",
      required: false,
    },
    {
      key: "HEALTHCHECKS_SMTP_PASSWORD",
      question: "SMTP password? Leave blank to skip",
      required: false,
      secret: true,
    },
    {
      key: "HEALTHCHECKS_SMTP_FROM",
      question: "From address for emails (e.g. healthchecks@example.com)? Leave blank to skip",
      required: false,
    },
  ],
} satisfies StackMeta
