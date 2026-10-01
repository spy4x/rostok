// Stack metadata for `ollama`.
//
// Ollama: local LLM server. The compose file reserves every NVIDIA GPU, so the host needs an
// NVIDIA GPU with the NVIDIA Container Toolkit; Docker refuses to start the container otherwise.
// The Traefik router uses the `authelia@file` middleware: Traefik serves 404 on it until an
// `authelia` middleware exists in its file provider (the authelia stack).

import type { StackMeta } from "@rostok/cli"

export default {
  name: "ollama",
  description: "Local LLM server with an OpenAI-compatible API (NVIDIA GPU required)",
  category: "ai",
  requires: ["traefik"],
  variables: [
    {
      key: "OLLAMA_IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "OLLAMA_DOMAIN",
      question: "Public domain for the Ollama API?",
      default: "ollama.${DOMAIN}",
      required: true,
    },
    {
      key: "OLLAMA_CPU_LIMIT",
      question: "CPU limit for the Ollama container?",
      default: "2",
      required: true,
    },
    {
      key: "OLLAMA_MEM_LIMIT",
      question: "Memory limit for the Ollama container?",
      default: "8G",
      required: true,
    },
  ],
} satisfies StackMeta
