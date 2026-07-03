# Ollama

Local LLM server — run and serve open-source language models.

## Features

- Run LLMs locally (Llama, Mistral, Gemma, etc.)
- OpenAI-compatible API
- Model management via CLI
- GPU acceleration (NVIDIA CUDA)
- Used by Open WebUI and AI tools

## Access

API: `https://ollama.${DOMAIN}` (protected by Authelia SSO)

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
