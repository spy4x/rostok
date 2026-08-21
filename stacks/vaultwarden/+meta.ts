// Stack metadata for `vaultwarden`.
//
// First 6 stacks tracked by the v1 catalog (docs/v1-cli.md §11, Phase 4).
// Vaultwarden is a Bitwarden-compatible password manager. SMTP settings
// drive email notifications (signups, invites, password hints).
//
// Strictness (per Phase 4 user feedback): keep onboarding easy.
// - VAULTWARDEN_DOMAIN: single var, default `passwords.${DOMAIN}`.
// - All VAULTWARDEN_* tunables: required:false with sensible defaults
//   written to .env so compose doesn't see empty strings. Wizard can
//   offer to change them but doesn't block.
// - SMTP_* vars: required:false, no default → omitted unless user opts
//   in via --var or wizard. Vaultwarden runs without SMTP (no email
//   notifications, but signups/invites/password resets still work).

import type { StackMeta } from "@rostok/cli"

export default {
  name: "vaultwarden",
  description: "Bitwarden-compatible password manager with SMTP notifications",
  category: "security",
  variables: [
    {
      key: "IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "VAULTWARDEN_DOMAIN",
      question: "Public domain for Vaultwarden?",
      default: "passwords.${DOMAIN}",
      required: true,
    },
    {
      key: "VAULTWARDEN_SIGNUPS_ALLOWED",
      default: "true",
      required: false,
    },
    {
      key: "VAULTWARDEN_INVITATIONS_ALLOWED",
      default: "true",
      required: false,
    },
    {
      key: "VAULTWARDEN_SHOW_PASSWORD_HINT",
      default: "false",
      required: false,
    },
    {
      key: "VAULTWARDEN_LOGIN_RATELIMIT_MAX_BURST",
      default: "10",
      required: false,
    },
    {
      key: "VAULTWARDEN_LOGIN_RATELIMIT_SECONDS",
      default: "60",
      required: false,
    },
    {
      key: "VAULTWARDEN_INCOMPLETE_2FA_TIME_LIMIT",
      default: "3 days",
      required: false,
    },
    {
      key: "VAULTWARDEN_LOG_LEVEL",
      default: "info",
      required: false,
    },
    {
      key: "VAULTWARDEN_EMERGENCY_ACCESS_ALLOWED",
      default: "true",
      required: false,
    },
    {
      key: "SMTP_HOST",
      // required:false + no default → omitted from .env if not provided.
      // Vaultwarden runs without SMTP; only notifications need it.
      required: false,
    },
    {
      key: "SMTP_PORT",
      required: false,
    },
    {
      key: "SMTP_FROM",
      required: false,
    },
    {
      key: "SMTP_USERNAME",
      required: false,
    },
    {
      key: "SMTP_PASSWORD",
      required: false,
      secret: true,
    },
  ],
} satisfies StackMeta
