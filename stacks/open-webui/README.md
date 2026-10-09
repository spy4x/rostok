# Open WebUI

Self-hosted ChatGPT-like interface with Ollama integration.

## Features

- Chat with local LLMs via Ollama
- Multiple model support
- Conversation history
- Document upload for RAG
- Web search integration

## Access

Web UI: `https://${OPEN_WEBUI_DOMAIN}`

## Configuration

Requires Ollama running. Pull models:

```bash
docker exec -it open-webui ollama pull llama2
docker exec -it open-webui ollama pull codellama
```

## Variables

Declared in `+meta.ts`; `rostok stack add open-webui` writes them to the server's `.env`. Requires the `traefik` stack. Served at `${OPEN_WEBUI_DOMAIN}`. `after.deploy.ts` copies the provider list into Open WebUI's database on every deploy. The stack talks to sibling stacks by container name (`ollama`, `searxng`, `playwright`, `caldav-mcp`, `email-mcp`, `google-maps-mcp`, `github-mcp`); a missing one only makes its tool fail. To use caldav-mcp, write `OPEN_WEBUI_CALDAV_MCP_TOKEN=${CALDAV_MCP_TOKEN}` in the server's `.env` by hand, without quotes, so compose resolves the reference and both stacks share one token. The default document extraction engine is `tika`, which this catalog does not ship: clear `OPEN_WEBUI_CONTENT_EXTRACTION_ENGINE` in the server's `.env` after `stack add` to use the built-in one.

| Key                                                    | Default                                  | Meaning                                                          |
| ------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------- |
| `OPEN_WEBUI_DOMAIN`                                    | `ai.${DOMAIN}`                           | Public host of the web UI                                        |
| `OPEN_WEBUI_OPENAI_API_KEYS`                           | none, secret, required                   | Keys of your OpenAI-compatible providers, `;`-separated          |
| `OPEN_WEBUI_OPENAI_API_BASE_URLS`                      | none, required                           | Base URLs of those providers, same order                         |
| `OPEN_WEBUI_WEBUI_SECRET_KEY`                          | generated, secret                        | Session signing key (`WEBUI_SECRET_KEY`)                         |
| `OPEN_WEBUI_HF_TOKEN`                                  | none, secret                             | Optional Hugging Face token                                      |
| `OPEN_WEBUI_MCPO_API_KEY`                              | generated, secret                        | API key Open WebUI sends to mcpo                                 |
| `OPEN_WEBUI_CALDAV_MCP_TOKEN`                          | none, secret                             | Bearer token sent to caldav-mcp, normally `${CALDAV_MCP_TOKEN}`  |
| `OPEN_WEBUI_ENABLE_WEB_SEARCH`                         | `true`                                   | Enable web search                                                |
| `OPEN_WEBUI_WEB_SEARCH_ENGINE`                         | `searxng`                                | Web search engine                                                |
| `OPEN_WEBUI_SEARXNG_QUERY_URL`                         | `http://searxng:8080/search?format=json` | SearXNG query URL                                                |
| `OPEN_WEBUI_WEB_SEARCH_RESULT_COUNT`                   | `3`                                      | Web search results per query                                     |
| `OPEN_WEBUI_BYPASS_WEB_SEARCH_EMBEDDING_AND_RETRIEVAL` | `true`                                   | Pass web search results to the model without embedding           |
| `OPEN_WEBUI_ENABLE_OLLAMA_API`                         | `true`                                   | Enable the Ollama connection                                     |
| `OPEN_WEBUI_OLLAMA_API_BASE_URL`                       | `http://ollama:11434`                    | Ollama API base URL                                              |
| `OPEN_WEBUI_OLLAMA_BASE_URL`                           | `http://ollama:11434`                    | Ollama base URL                                                  |
| `OPEN_WEBUI_DEFAULT_USER_ROLE`                         | `user`                                   | Role of a new user                                               |
| `OPEN_WEBUI_ENABLE_SIGNUP`                             | `false`                                  | Allow sign-up                                                    |
| `OPEN_WEBUI_ENABLE_LOGIN_FORM`                         | `true`                                   | Show the login form                                              |
| `OPEN_WEBUI_CONTENT_EXTRACTION_ENGINE`                 | `tika`                                   | Document extraction engine (tika, or empty for the built-in one) |
| `OPEN_WEBUI_TIKA_SERVER_URL`                           | `http://tika:9998`                       | Tika server URL                                                  |
| `OPEN_WEBUI_RAG_TOP_K`                                 | `10`                                     | Document chunks passed to the model                              |
| `OPEN_WEBUI_RAG_FILE_MAX_COUNT`                        | `10`                                     | Maximum files per upload                                         |
| `OPEN_WEBUI_RAG_FILE_MAX_SIZE`                         | `52428800`                               | Maximum file size in bytes                                       |
| `OPEN_WEBUI_ENABLE_PERSISTENT_CONFIG`                  | `false`                                  | Keep settings changed in the UI across restarts                  |
| `OPEN_WEBUI_WEBUI_NAME`                                | `Homelab AI`                             | Name shown in the UI                                             |

## Resources

- [Open WebUI Documentation](https://docs.openwebui.com/)
- [Ollama Models](https://ollama.com/library)
