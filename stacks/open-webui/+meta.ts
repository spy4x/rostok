// Stack metadata for `open-webui`.
//
// Chat UI for local and hosted models at `ai.${DOMAIN}` behind Traefik. With default answers it
// needs nothing but one OpenAI-compatible provider: every model that provider returns is listed,
// and documents and web pages go through Open WebUI's built-in extractor and loader. Each
// sibling stack it can use (`ollama`, `searxng`, `playwright` and the MCP servers
// `playwright`, `caldav-mcp`, `email-mcp`, `google-maps-mcp`, `github-mcp`) is off until its
// variable below turns it on; the README has the table. `after.deploy.ts` writes the provider
// list below into Open WebUI's database after every deploy.
//
// Variable shape:
//   - OPEN_WEBUI_OPENAI_API_KEYS / OPEN_WEBUI_OPENAI_API_BASE_URLS: semicolon-separated lists,
//     one entry per OpenAI-compatible provider, matched by position. Optional, so that an
//     Ollama-only server (OPEN_WEBUI_ENABLE_OLLAMA_API=true) can be added with `stack add -n`
//     (spy4x/rostok#426); being optional, `stack add` does not ask for them: pass them with
//     `--var` or set them in `.env`. The deploy hook refuses one without the other.
//   - OPEN_WEBUI_ENABLE_<NAME>_MCP: `true` or `false`. Compose pastes the value unquoted into
//     JSON, so the deploy hook refuses any other value, naming the key.
//   - OPEN_WEBUI_ENABLE_RAG_LOCAL_WEB_FETCH: off by default (spy4x/rostok#399). On, any signed-in
//     user can make Open WebUI fetch a private address and read the answer.
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
//   - OPEN_WEBUI_EMAIL_MCP_TOKEN: the bearer token Open WebUI sends to the email-mcp guard, the
//     same way: `OPEN_WEBUI_EMAIL_MCP_TOKEN=${EMAIL_MCP_TOKEN}`, below the EMAIL_MCP_TOKEN line.
//     Empty, the guard refuses every call.
//   - OPEN_WEBUI_OPENAI_API_CONFIGS / OPEN_WEBUI_DEFAULT_MODELS: optional model whitelist per
//     provider (JSON) and the models preselected in a new chat. Empty lists every model.
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
      key: "OPEN_WEBUI_IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "OPEN_WEBUI_MCPO_IMAGE_TAG",
      default: "main",
      required: false,
    },
    {
      key: "OPEN_WEBUI_DOMAIN",
      question: "Public domain for Open WebUI?",
      default: "ai.${DOMAIN}",
      required: true,
    },
    {
      key: "OPEN_WEBUI_OPENAI_API_KEYS",
      question: "API keys of your OpenAI-compatible providers (semicolon-separated, may be empty)?",
      required: false,
      secret: true,
    },
    {
      key: "OPEN_WEBUI_OPENAI_API_BASE_URLS",
      question: "Base URLs of those providers, same order (semicolon-separated, may be empty)?",
      required: false,
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
      key: "OPEN_WEBUI_EMAIL_MCP_TOKEN",
      question: "Bearer token for email-mcp (the value of EMAIL_MCP_TOKEN, or empty)?",
      required: false,
      secret: true,
    },
    {
      key: "OPEN_WEBUI_OPENAI_API_CONFIGS",
      question: "Model whitelist per provider, as JSON (empty = list every model)?",
      required: false,
    },
    {
      key: "OPEN_WEBUI_DEFAULT_MODELS",
      question: "Models preselected in a new chat, comma-separated (may be empty)?",
      required: false,
    },
    {
      key: "OPEN_WEBUI_ENABLE_IMAGE_GENERATION",
      question: "Enable image generation (needs a provider with an image model)?",
      default: "false",
      required: true,
    },
    {
      key: "OPEN_WEBUI_IMAGE_GENERATION_MODEL",
      question: "Image generation model (may be empty)?",
      required: false,
    },
    {
      key: "OPEN_WEBUI_WEB_LOADER_ENGINE",
      question: "Web page loader (empty = built-in, playwright = the playwright stack)?",
      required: false,
    },
    {
      key: "OPEN_WEBUI_PLAYWRIGHT_WS_URL",
      question: "Playwright URL for the playwright loader (may be empty)?",
      required: false,
    },
    {
      key: "OPEN_WEBUI_ENABLE_RAG_LOCAL_WEB_FETCH",
      question: "Let users fetch pages from private addresses (your LAN, other containers)?",
      default: "false",
      required: true,
    },
    {
      key: "OPEN_WEBUI_ENABLE_WEB_SEARCH",
      question: "Enable web search (needs the searxng stack or another engine)?",
      default: "false",
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
      question: "Enable the Ollama connection (needs the ollama stack)?",
      default: "false",
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
      key: "OPEN_WEBUI_ENABLE_PLAYWRIGHT_MCP",
      question: "Offer the browser tools (needs the playwright stack)?",
      default: "false",
      required: true,
    },
    {
      key: "OPEN_WEBUI_ENABLE_CALDAV_MCP",
      question: "Offer the calendar and task tools (needs the caldav-mcp stack)?",
      default: "false",
      required: true,
    },
    {
      key: "OPEN_WEBUI_ENABLE_EMAIL_MCP",
      question: "Offer the e-mail tools (needs the email-mcp stack)?",
      default: "false",
      required: true,
    },
    {
      key: "OPEN_WEBUI_ENABLE_GOOGLE_MAPS_MCP",
      question: "Offer the Google Maps tools (needs the google-maps-mcp stack)?",
      default: "false",
      required: true,
    },
    {
      key: "OPEN_WEBUI_ENABLE_GITHUB_MCP",
      question: "Offer the GitHub tools (needs the github-mcp stack)?",
      default: "false",
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
      question: "Document extraction engine (empty = built-in, tika = your own Tika server)?",
      required: false,
    },
    {
      key: "OPEN_WEBUI_TIKA_SERVER_URL",
      question: "Tika server URL for the tika engine (may be empty)?",
      required: false,
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
