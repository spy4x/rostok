# Ollama

Local LLM server — run and serve open-source language models.

## Features

- Run LLMs locally (Llama, Mistral, Gemma, etc.)
- OpenAI-compatible API
- Model management via CLI
- GPU acceleration (NVIDIA CUDA)
- Used by Open WebUI and AI tools

## Requirements

The compose file reserves all NVIDIA GPUs. The host needs an NVIDIA GPU, its driver and the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/);
without them Docker refuses to start the container. For a CPU-only host, remove the `reservations`
block from `compose.yml`.

## Configuration

| Variable           | Default            | Meaning                |
| ------------------ | ------------------ | ---------------------- |
| `OLLAMA_IMAGE_TAG` | `latest`           | Image tag              |
| `OLLAMA_DOMAIN`    | `ollama.${DOMAIN}` | Public host of the API |
| `OLLAMA_CPU_LIMIT` | `2`                | CPU limit              |
| `OLLAMA_MEM_LIMIT` | `8G`               | Memory limit           |

## Access

API: `https://<OLLAMA_DOMAIN>`, protected by Authelia SSO. The router uses the `authelia@file`
middleware, so it answers 404 until the authelia stack (or your own file-provider middleware named
`authelia`) is deployed.

## Usage

Pull and run models:

```bash
# From the host
ollama pull llama3
ollama run llama3

# API
curl https://ollama.${DOMAIN}/api/generate -d '{
  "model": "llama3",
  "prompt": "Hello!"
}'
```

## Resources

- [Ollama GitHub](https://github.com/ollama/ollama)
- [Ollama Library](https://ollama.com/library)
