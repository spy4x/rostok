// Stack metadata for `quantum-filebrowser`.
//
// FileBrowser Quantum (gtsteffaniak/filebrowser), the maintained fork that replaces the archived
// File Browser behind `stacks/filebrowser`. It mounts the same PATH_* folders, which are
// server-level keys shared by name with filebrowser and jellyfin (one value per key).
//
// Variable shape:
//   - QUANTUM_FILEBROWSER_DOMAIN: default `files.${DOMAIN}`, the old stack's host.
//   - QUANTUM_FILEBROWSER_ADMIN_PASSWORD: secret, generated at `stack add`; the app applies it
//     to the `admin` user on every start.
//
// Server-level vars (TIMEZONE, PUID, PGID, VOLUMES_PATH) intentionally NOT declared here.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "quantum-filebrowser",
  description: "Web-based file manager (FileBrowser Quantum)",
  category: "storage",
  requires: ["traefik"],
  variables: [
    {
      key: "QUANTUM_FILEBROWSER_IMAGE_TAG",
      default: "stable",
      required: false,
    },
    {
      key: "QUANTUM_FILEBROWSER_DOMAIN",
      question: "Public domain for FileBrowser Quantum?",
      default: "files.${DOMAIN}",
      required: true,
    },
    {
      key: "QUANTUM_FILEBROWSER_ADMIN_PASSWORD",
      question: "Password for the admin user (auto-generated)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "PATH_MEDIA",
      question: "Host path for the media library?",
      default: "${VOLUMES_PATH}/media",
      required: true,
    },
    {
      key: "PATH_VIDEOS",
      question: "Host path for the videos library?",
      default: "${VOLUMES_PATH}/videos",
      required: true,
    },
    {
      key: "PATH_MUSIC",
      question: "Host path for the music library?",
      default: "${VOLUMES_PATH}/music",
      required: true,
    },
    {
      key: "PATH_BOOKS",
      question: "Host path for the books library?",
      default: "${VOLUMES_PATH}/books",
      required: true,
    },
    {
      key: "PATH_SYNC",
      question: "Host path for synced files?",
      default: "${VOLUMES_PATH}/sync",
      required: true,
    },
    {
      key: "PATH_MOVIES",
      question: "Host path for movies?",
      default: "${VOLUMES_PATH}/movies",
      required: true,
    },
    {
      key: "PATH_SERIES",
      question: "Host path for TV series?",
      default: "${VOLUMES_PATH}/series",
      required: true,
    },
    {
      key: "PATH_OTHER",
      question: "Host path for everything else?",
      default: "${VOLUMES_PATH}/other",
      required: true,
    },
  ],
} satisfies StackMeta
