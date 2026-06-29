# GitHub MCP Server — supergateway wraps the Go stdio binary in HTTP
#
# Stage 1: Download the github-mcp-server release binary
FROM alpine:3.21 AS download
ARG GITHUB_MCP_VERSION=v1.5.0
RUN apk add --no-cache curl tar \
  && curl -sSL "https://github.com/github/github-mcp-server/releases/download/${GITHUB_MCP_VERSION}/github-mcp-server_Linux_x86_64.tar.gz" \
    | tar xz -C /tmp/

# Stage 2: SuperGateway wraps stdio in Streamable HTTP / SSE
FROM ghcr.io/supercorp-ai/supergateway:latest
COPY --from=download /tmp/github-mcp-server /usr/local/bin/github-mcp-server

EXPOSE 3000
ENTRYPOINT ["supergateway"]
CMD ["--stdio", "github-mcp-server stdio", "--outputTransport", "streamableHttp", "--port", "3000", "--streamableHttpPath", "/mcp", "--healthEndpoint", "/healthz"]
