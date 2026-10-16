# Open WebUI

Self-hosted chat UI for hosted and local language models.

## Features

- Chat with any OpenAI-compatible provider, and with local models through Ollama
- Conversation history
- Document upload for RAG
- Optional web search, image generation and tools from sibling stacks

## Access

Web UI: `https://${OPEN_WEBUI_DOMAIN}`

## What you get with default answers

`rostok stack add open-webui` (with or without `-n`) needs nothing from you. It does not ask for
a model provider: pass the API keys and base URLs of your OpenAI-compatible providers with
`--var OPEN_WEBUI_OPENAI_API_KEYS=<keys> --var OPEN_WEBUI_OPENAI_API_BASE_URLS=<urls>`, or set
both in the server's `.env`. Set both or neither; the deploy hook refuses one without the other.
A server that only runs local models leaves both empty and sets
`OPEN_WEBUI_ENABLE_OLLAMA_API=true`. With every other answer left at its default:

- every model your providers return is listed, and none is preselected;
- uploaded documents go through Open WebUI's built-in extractor, and web pages through its
  built-in loader;
- the two tools this stack runs itself (YouTube transcript and web fetch, through `mcpo`) work;
- web search, image generation, Ollama and the tools of other stacks are off, so nothing points
  at a stack this server does not run;
- web fetch refuses private addresses (below).

## Turning on the optional parts

Each needs something else to exist first. Set the variables in the server's `.env` and deploy.

| To get                           | Add first                          | Then set                                                                                       |
| -------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Local models                     | the `ollama` stack                 | `OPEN_WEBUI_ENABLE_OLLAMA_API=true`                                                            |
| Web search                       | the `searxng` stack                | `OPEN_WEBUI_ENABLE_WEB_SEARCH=true`                                                            |
| Pages loaded in a real browser   | the `playwright` stack             | `OPEN_WEBUI_WEB_LOADER_ENGINE=playwright`, `OPEN_WEBUI_PLAYWRIGHT_WS_URL=ws://playwright:3000` |
| Browser tools                    | the `playwright` stack             | `OPEN_WEBUI_ENABLE_PLAYWRIGHT_MCP=true`                                                        |
| Calendar and task tools          | the `caldav-mcp` stack             | `OPEN_WEBUI_ENABLE_CALDAV_MCP=true` and `OPEN_WEBUI_CALDAV_MCP_TOKEN` (below)                  |
| E-mail tools                     | the `email-mcp` stack              | `OPEN_WEBUI_ENABLE_EMAIL_MCP=true`                                                             |
| Google Maps tools                | the `google-maps-mcp` stack        | `OPEN_WEBUI_ENABLE_GOOGLE_MAPS_MCP=true`                                                       |
| GitHub tools                     | the `github-mcp` stack             | `OPEN_WEBUI_ENABLE_GITHUB_MCP=true`                                                            |
| Image generation                 | a provider with an image model     | `OPEN_WEBUI_ENABLE_IMAGE_GENERATION=true`, `OPEN_WEBUI_IMAGE_GENERATION_MODEL=<model id>`      |
| Document extraction through Tika | your own Tika server (not shipped) | `OPEN_WEBUI_CONTENT_EXTRACTION_ENGINE=tika`, `OPEN_WEBUI_TIKA_SERVER_URL=<its URL>`            |
| Web pages from your own LAN      | nothing                            | `OPEN_WEBUI_ENABLE_RAG_LOCAL_WEB_FETCH=true` (below)                                           |

Each `OPEN_WEBUI_ENABLE_<NAME>_MCP` switch must be `true` or `false`. Compose writes the value
unquoted into the JSON list of tool servers, where any other value, such as `yes` or `True`, makes
the whole list invalid and Open WebUI loads no tool server at all. The deploy hook therefore fails
the deploy and names the key.

**Local web fetch.** Off by default. When it is on, any signed-in user can ask Open WebUI to fetch
a private address, such as an admin page of another container or your router, and read the answer
in the chat. Turn it on only when you need pages from your own network and trust every account.

**caldav-mcp token.** Write `OPEN_WEBUI_CALDAV_MCP_TOKEN=${CALDAV_MCP_TOKEN}` in the server's
`.env` by hand, without quotes and below the `CALDAV_MCP_TOKEN` line, so compose resolves the
reference and both stacks share one token. Compose resolves a reference only to a key defined
earlier in the file; above it, the key is silently empty and the caldav tool gets 401.

**A shorter model list.** To list only some of a provider's models, set
`OPEN_WEBUI_OPENAI_API_CONFIGS` to JSON keyed by the provider's position in
`OPEN_WEBUI_OPENAI_API_BASE_URLS`, in single quotes:

```bash
OPEN_WEBUI_OPENAI_API_CONFIGS='{"0":{"model_ids":["model-a","model-b"]}}'
```

To preselect models in a new chat, set `OPEN_WEBUI_DEFAULT_MODELS=model-a,model-b`. When it is
set, the deploy hook also hides every other model record of the workspace (Admin → Models);
leave it empty to keep them all.

## Variables

Declared in `+meta.ts`; `rostok stack add open-webui` writes them to the server's `.env`. Requires
the `traefik` stack. `after.deploy.ts` copies the provider list into Open WebUI's database on
every deploy. It also connects `hl-open-webui` to the private network of each MCP server stack
(`hl-playwright-mcp`, `hl-email-mcp`, `hl-github-mcp`, `hl-google-maps-mcp`) that exists on the
server. Those servers ask callers for no credential, so they are on no shared network, and Open
WebUI is the only other container that can reach them. `rostok deploy <server>` runs this hook
every time; after `rostok deploy <server> <mcp stack>` of a newly added MCP stack alone, run
`rostok deploy <server> open-webui` too, so the new network is connected.

| Key                                                    | Default                                  | Meaning                                                             |
| ------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------- |
| `OPEN_WEBUI_DOMAIN`                                    | `ai.${DOMAIN}`                           | Public host of the web UI                                           |
| `OPEN_WEBUI_OPENAI_API_KEYS`                           | none, secret                             | Keys of your OpenAI-compatible providers, `;`-separated             |
| `OPEN_WEBUI_OPENAI_API_BASE_URLS`                      | none                                     | Base URLs of those providers, same order                            |
| `OPEN_WEBUI_WEBUI_SECRET_KEY`                          | generated, secret                        | Session signing key (`WEBUI_SECRET_KEY`)                            |
| `OPEN_WEBUI_HF_TOKEN`                                  | none, secret                             | Optional Hugging Face token                                         |
| `OPEN_WEBUI_MCPO_API_KEY`                              | generated, secret                        | API key Open WebUI sends to mcpo                                    |
| `OPEN_WEBUI_CALDAV_MCP_TOKEN`                          | none, secret                             | Bearer token sent to caldav-mcp, normally `${CALDAV_MCP_TOKEN}`     |
| `OPEN_WEBUI_OPENAI_API_CONFIGS`                        | none                                     | Optional model whitelist per provider, as JSON                      |
| `OPEN_WEBUI_DEFAULT_MODELS`                            | none                                     | Models preselected in a new chat, comma-separated                   |
| `OPEN_WEBUI_ENABLE_IMAGE_GENERATION`                   | `false`                                  | Enable image generation                                             |
| `OPEN_WEBUI_IMAGE_GENERATION_MODEL`                    | none                                     | Image model of your provider                                        |
| `OPEN_WEBUI_WEB_LOADER_ENGINE`                         | none                                     | Web page loader (empty for the built-in one, or `playwright`)       |
| `OPEN_WEBUI_PLAYWRIGHT_WS_URL`                         | none                                     | Playwright URL, for the `playwright` loader                         |
| `OPEN_WEBUI_ENABLE_RAG_LOCAL_WEB_FETCH`                | `false`                                  | Let users fetch pages from private addresses                        |
| `OPEN_WEBUI_ENABLE_WEB_SEARCH`                         | `false`                                  | Enable web search                                                   |
| `OPEN_WEBUI_WEB_SEARCH_ENGINE`                         | `searxng`                                | Web search engine                                                   |
| `OPEN_WEBUI_SEARXNG_QUERY_URL`                         | `http://searxng:8080/search?format=json` | SearXNG query URL                                                   |
| `OPEN_WEBUI_WEB_SEARCH_RESULT_COUNT`                   | `3`                                      | Web search results per query                                        |
| `OPEN_WEBUI_BYPASS_WEB_SEARCH_EMBEDDING_AND_RETRIEVAL` | `true`                                   | Pass web search results to the model without embedding              |
| `OPEN_WEBUI_ENABLE_OLLAMA_API`                         | `false`                                  | Enable the Ollama connection                                        |
| `OPEN_WEBUI_OLLAMA_API_BASE_URL`                       | `http://ollama:11434`                    | Ollama API base URL                                                 |
| `OPEN_WEBUI_OLLAMA_BASE_URL`                           | `http://ollama:11434`                    | Ollama base URL                                                     |
| `OPEN_WEBUI_ENABLE_PLAYWRIGHT_MCP`                     | `false`                                  | Offer the tools of the `playwright` stack                           |
| `OPEN_WEBUI_ENABLE_CALDAV_MCP`                         | `false`                                  | Offer the tools of the `caldav-mcp` stack                           |
| `OPEN_WEBUI_ENABLE_EMAIL_MCP`                          | `false`                                  | Offer the tools of the `email-mcp` stack                            |
| `OPEN_WEBUI_ENABLE_GOOGLE_MAPS_MCP`                    | `false`                                  | Offer the tools of the `google-maps-mcp` stack                      |
| `OPEN_WEBUI_ENABLE_GITHUB_MCP`                         | `false`                                  | Offer the tools of the `github-mcp` stack                           |
| `OPEN_WEBUI_DEFAULT_USER_ROLE`                         | `user`                                   | Role of a new user                                                  |
| `OPEN_WEBUI_ENABLE_SIGNUP`                             | `false`                                  | Allow sign-up                                                       |
| `OPEN_WEBUI_ENABLE_LOGIN_FORM`                         | `true`                                   | Show the login form                                                 |
| `OPEN_WEBUI_CONTENT_EXTRACTION_ENGINE`                 | none                                     | Document extraction engine (empty for the built-in one, or `tika`)  |
| `OPEN_WEBUI_TIKA_SERVER_URL`                           | none                                     | URL of your Tika server, for the `tika` engine                      |
| `OPEN_WEBUI_RAG_TOP_K`                                 | `10`                                     | Document chunks passed to the model                                 |
| `OPEN_WEBUI_RAG_FILE_MAX_COUNT`                        | `10`                                     | Maximum files per upload                                            |
| `OPEN_WEBUI_RAG_FILE_MAX_SIZE`                         | `52428800`                               | Maximum file size in bytes                                          |
| `OPEN_WEBUI_ENABLE_PERSISTENT_CONFIG`                  | `false`                                  | Keep settings changed in the UI across restarts                     |
| `OPEN_WEBUI_WEBUI_NAME`                                | `Homelab AI`                             | Name shown in the UI                                                |
| `OPEN_WEBUI_IMAGE_TAG`                                 | `latest`                                 | Image tag of `ghcr.io/open-webui/open-webui` (service `open-webui`) |
| `OPEN_WEBUI_MCPO_IMAGE_TAG`                            | `main`                                   | Image tag of `ghcr.io/open-webui/mcpo` (service `mcpo`)             |

## Resources

- [Open WebUI Documentation](https://docs.openwebui.com/)
- [Ollama Models](https://ollama.com/library)
