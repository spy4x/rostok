// Stack metadata for `caldav-tasks-web`.
//
// caldav-tasks-web is a web client for the tasks on a CalDAV server
// (github.com/spy4x/caldav-tasks-web), served at `todos.${DOMAIN}` behind Traefik. Its own
// settings (CalDAV address and account, owner password hash, secrets) live in the
// operator-written file `${PATH_APPS}/configs/caldav-tasks-web.env`, which
// `servers/<server>/configs/caldav-tasks-web.env` provides: see the stack README. The stack
// cannot start without that file, so write it before the first deploy.
//
// Variable shape:
//   - CALDAV_TASKS_WEB_DOMAIN: single var, default `todos.${DOMAIN}`. Set `PUBLIC_URL` in
//     `caldav-tasks-web.env` to match.
//   - CALDAV_TASKS_WEB_IMAGE_TAG: image tag, `latest` follows the app's stable releases.
//   - CALDAV_TASKS_WEB_MIDDLEWARES: Traefik middleware chain.
//
// Server-level vars (PROJECT, DOMAIN, PATH_APPS, PUID, PGID) intentionally NOT declared here.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "caldav-tasks-web",
  description: "Web client for the tasks on a CalDAV server: one owner, one account, no database",
  category: "productivity",
  requires: ["traefik"],
  variables: [
    {
      key: "CALDAV_TASKS_WEB_DOMAIN",
      question: "Public domain for the task list?",
      default: "todos.${DOMAIN}",
      required: true,
    },
    {
      key: "CALDAV_TASKS_WEB_IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "CALDAV_TASKS_WEB_MIDDLEWARES",
      default: "security-headers@file,compression@file,robots-deny@file",
      required: false,
    },
  ],
} satisfies StackMeta
