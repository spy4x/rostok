// Stack metadata for `nginx`.
//
// A static site server: serves `servers/<server>/configs/nginx/src/` (deployed to
// `${PATH_APPS}/configs/nginx/src`) read-only at NGINX_DOMAIN. One instance per server: the
// container and Traefik router name is NGINX_CONTAINER_NAME, and a server's `.env` holds one
// value for it, so an aliased second copy (`deployAs`) would clash on the name.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "nginx",
  description: "Static site server for a landing page, dashboard or docs (nginx)",
  category: "web",
  requires: ["traefik"],
  variables: [
    {
      key: "NGINX_IMAGE_TAG",
      default: "alpine",
      required: false,
    },
    {
      key: "NGINX_CONTAINER_NAME",
      question: "Container and Traefik router name?",
      default: "hl-nginx",
      required: true,
    },
    {
      key: "NGINX_DOMAIN",
      question: "Public domain for the site? Leave blank for <container name>.<domain>",
      // No default: compose's fallback is `${NGINX_CONTAINER_NAME}.${DOMAIN}`, which a meta default
      // cannot express. Blank keeps the pre-meta host of an existing deployment.
      required: false,
    },
  ],
} satisfies StackMeta
