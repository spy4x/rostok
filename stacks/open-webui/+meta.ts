// Stack metadata for `open-webui`.
//
// Chat UI for local and hosted models at `ai.${DOMAIN}` behind Traefik. It talks to sibling
// stacks by container name: `ollama`, `searxng` and `playwright` (web search and page loading),
// plus the MCP servers `caldav-mcp`, `email-mcp`, `google-maps-mcp` and `github-mcp`. Add the
// ones you want on the same server; a missing one only makes its tool fail. `after.deploy.ts`
// writes the provider list below into Open WebUI's database after every deploy.
//
// Variable shape:
//   - OPEN_WEBUI_OPENAI_API_KEYS / OPEN_WEBUI_OPENAI_API_BASE_URLS: semicolon-separated lists,
//     one entry per OpenAI-compatible provider, matched by position. Required: the deploy hook
//     refuses to run without them. Keys come from the provider, so there is no default.
//   - OPEN_WEBUI_WEBUI_SECRET_KEY: secret, generated at `stack add`. Compose passes it as
//     WEBUI_SECRET_KEY, which signs sessions.
//   - OPEN_WEBUI_HF_TOKEN: optional Hugging Face token.
//   - OPEN_WEBUI_MCPO_API_KEY: secret, generated at `stack add`. mcpo requires it as its API key
//     and Open WebUI sends it to mcpo.
//   - OPEN_WEBUI_CALDAV_MCP_TOKEN: the bearer token Open WebUI sends to caldav-mcp. A stack may
//     only read its own prefixed keys, so it can't read CALDAV_MCP_TOKEN directly. `stack add`
//     asks for the value; editing the server's `.env` to the unquoted reference
//     `OPEN_WEBUI_CALDAV_MCP_TOKEN=${CALDAV_MCP_TOKEN}` keeps one secret for both stacks (the CLI
//     single-quotes any typed value with `$`, which compose then reads literally). Optional, with
//     no default: a default reference would stop every deploy on a server without caldav-mcp.
//     The reference line must sit below the CALDAV_MCP_TOKEN line: compose resolves a reference
//     only to a key defined earlier, and above it the key is silently empty.
//   - the rest: same defaults as compose.
//
// Server-level vars (DOMAIN, VOLUMES_PATH, PATH_APPS) intentionally NOT declared here.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "open-webui",
  description: "Chat UI for local and hosted LLMs (open-webui/open-webui)",
  category: "ai",
  requires: ["traefik"],
  variables: [
    {
      key: "OPEN_WEBUI_DOMAIN",
      question: "Public domain for Open WebUI?",
      default: "ai.${DOMAIN}",
      required: true,
    },
    {
      key: "OPEN_WEBUI_OPENAI_API_KEYS",
      question: "API keys of your OpenAI-compatible providers (semicolon-separated)?",
      required: true,
      secret: true,
    },
    {
      key: "OPEN_WEBUI_OPENAI_API_BASE_URLS",
      question: "Base URLs of those providers, same order (semicolon-separated)?",
      required: true,
    },
    {
      key: "OPEN_WEBUI_WEBUI_SECRET_KEY",
      question: "Session signing key (auto-generated)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "OPEN_WEBUI_HF_TOKEN",
      question: "Hugging Face token (may be empty)?",
      required: false,
      secret: true,
    },
    {
      key: "OPEN_WEBUI_MCPO_API_KEY",
      question: "API key between Open WebUI and mcpo (auto-generated)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "OPEN_WEBUI_CALDAV_MCP_TOKEN",
      question: "Bearer token for caldav-mcp (the value of CALDAV_MCP_TOKEN, or empty)?",
      required: false,
      secret: true,
    },
    {
      key: "OPEN_WEBUI_ENABLE_WEB_SEARCH",
      question: "Enable web search?",
      default: "true",
      required: true,
    },
    {
      key: "OPEN_WEBUI_WEB_SEARCH_ENGINE",
      question: "Web search engine?",
      default: "searxng",
      required: true,
    },
    {
      key: "OPEN_WEBUI_SEARXNG_QUERY_URL",
      question: "SearXNG query URL?",
      default: "http://searxng:8080/search?format=json",
      required: true,
    },
    {
      key: "OPEN_WEBUI_WEB_SEARCH_RESULT_COUNT",
      question: "Web search results per query?",
      default: "3",
      required: true,
    },
    {
      key: "OPEN_WEBUI_BYPASS_WEB_SEARCH_EMBEDDING_AND_RETRIEVAL",
      question: "Pass web search results to the model without embedding?",
      default: "true",
      required: true,
    },
    {
      key: "OPEN_WEBUI_ENABLE_OLLAMA_API",
      question: "Enable the Ollama connection?",
      default: "true",
      required: true,
    },
    {
      key: "OPEN_WEBUI_OLLAMA_API_BASE_URL",
      question: "Ollama API base URL?",
      default: "http://ollama:11434",
      required: true,
    },
    {
      key: "OPEN_WEBUI_OLLAMA_BASE_URL",
      question: "Ollama base URL?",
      default: "http://ollama:11434",
      required: true,
    },
    {
      key: "OPEN_WEBUI_DEFAULT_USER_ROLE",
      question: "Role of a new user?",
      default: "user",
      required: true,
    },
    {
      key: "OPEN_WEBUI_ENABLE_SIGNUP",
      question: "Allow sign-up?",
      default: "false",
      required: true,
    },
    {
      key: "OPEN_WEBUI_ENABLE_LOGIN_FORM",
      question: "Show the login form?",
      default: "true",
      required: true,
    },
    {
      key: "OPEN_WEBUI_CONTENT_EXTRACTION_ENGINE",
      question: "Document extraction engine?",
      default: "tika",
      required: true,
    },
    {
      key: "OPEN_WEBUI_TIKA_SERVER_URL",
      question: "Tika server URL?",
      default: "http://tika:9998",
      required: true,
    },
    {
      key: "OPEN_WEBUI_RAG_TOP_K",
      question: "Document chunks passed to the model?",
      default: "10",
      required: true,
    },
    {
      key: "OPEN_WEBUI_RAG_FILE_MAX_COUNT",
      question: "Maximum files per upload?",
      default: "10",
      required: true,
    },
    {
      key: "OPEN_WEBUI_RAG_FILE_MAX_SIZE",
      question: "Maximum file size in bytes?",
      default: "52428800",
      required: true,
    },
    {
      key: "OPEN_WEBUI_ENABLE_PERSISTENT_CONFIG",
      question: "Keep settings changed in the UI across restarts?",
      default: "false",
      required: true,
    },
    {
      key: "OPEN_WEBUI_WEBUI_NAME",
      question: "Name shown in the UI?",
      default: "Homelab AI",
      required: true,
    },
  ],
} satisfies StackMeta
