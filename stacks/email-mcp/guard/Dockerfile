# The email-mcp guard (spy4x/rostok#143): a small TypeScript proxy that asks for a token and passes
# only allowed tools to mcp-email-server. Built on the server by `rostok deploy`; never pushed.
# The base image is pinned by digest, the same one as caldav-mcp's builder.
FROM denoland/deno:alpine-2.9.7@sha256:8ce780168429c4bf5962652e6cbea3fd45254ae902069e90585fb33f74c56968
WORKDIR /app
COPY +main.ts guard.ts /app/
# Compile once at build time, as the user that runs it, so the container needs no writable cache.
USER deno
RUN deno cache /app/+main.ts
# Explicit permissions: listen on 9557, reach only the upstream server, read only its own settings.
ENTRYPOINT ["/tini", "--", "deno", "serve", "--host", "0.0.0.0", "--port", "9557", \
  "--allow-net=0.0.0.0:9557,hl-email-mcp-upstream:9557", \
  "--allow-env=EMAIL_MCP_TOKEN,EMAIL_MCP_ALLOWED_USERS", \
  "/app/+main.ts"]
