# GitHub MCP Server — runs github-mcp-server (Go stdio binary) behind
# a Node.js Streamable HTTP wrapper so OpenWebUI can connect natively.
#
# Stage 1: Download the github-mcp-server release binary
FROM alpine:3.21 AS download
ARG GITHUB_MCP_VERSION=v1.5.0
RUN apk add --no-cache curl tar \
  && curl -sSL "https://github.com/github/github-mcp-server/releases/download/${GITHUB_MCP_VERSION}/github-mcp-server_Linux_x86_64.tar.gz" \
    | tar xz -C /tmp/

# Stage 2: Node.js runtime with the http-wrapper
FROM node:22-alpine
RUN apk add --no-cache wget
COPY --from=download /tmp/github-mcp-server /usr/local/bin/github-mcp-server
COPY http-wrapper.mjs /app/http-wrapper.mjs
WORKDIR /app

EXPOSE 3000
CMD ["node", "http-wrapper.mjs"]
