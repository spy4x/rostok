# Woodpecker agent

A [Woodpecker CI](https://woodpecker-ci.org) agent on its own, for a machine other than the one
running the [`woodpecker`](../woodpecker/README.md) server. Add it where you have spare cores, and
the server spreads workflows across both agents.

## Setup

1. On the server's machine, set `WOODPECKER_GRPC_DOMAIN` (for example `grpc.ci.example.com`),
   point its DNS at that machine and deploy the `woodpecker` stack again. Its README, "Agents on
   other machines", explains the route.
2. On the second machine: `rostok stack add ci-agent`. It asks for the gRPC host and the
   server's `WOODPECKER_AGENT_SECRET`.
3. `rostok deploy`. The agent shows up as connected in the server's admin settings, under
   "Agents".

The agent needs no Traefik and no open port: it connects out to the server on 443.

## Variables

Declared in `+meta.ts`. Server-level keys `DOCKER_GROUP_ID`, `PUID`, `PGID` and `VOLUMES_PATH`
are shared by every stack. Keys carry this stack's prefix because the catalog lets only one stack
declare a key, so both stacks can live on one server.

| Key                      | Default       | Meaning                                                        |
| ------------------------ | ------------- | -------------------------------------------------------------- |
| `CI_AGENT_GRPC_DOMAIN`   | asked         | The server's `WOODPECKER_GRPC_DOMAIN`; the agent uses port 443 |
| `CI_AGENT_SECRET`        | asked, secret | A copy of the server's `WOODPECKER_AGENT_SECRET`               |
| `CI_AGENT_MAX_WORKFLOWS` | `4`           | Workflows the agent runs at once                               |

Deploy stops with an error while the gRPC host or the secret is empty.

Each workflow runs as its own containers next to the agent, outside the agent's memory and CPU
limits. Size `CI_AGENT_MAX_WORKFLOWS` to the machine's free memory and cores.

## Security

The agent secret is the only thing that stops anyone on the internet from connecting an agent to
your server, then receiving your pipelines with their secrets. Keep it as long as the generated
one, and change it on the server and every agent at once if it leaks.

The agent runs workflows through the machine's Docker socket, so a pipeline can do anything Docker
can on this machine. Run it only for repositories you trust, on a machine that holds nothing a
pipeline should not reach.

## Data

`${VOLUMES_PATH}/ci-agent/agent.conf` keeps the id the server gave the agent, so a
restart does not register a new agent. It has no backup: when it is lost, the agent registers
again once, and you can delete the old entry in the server's agent list.

## Image tags

Under `IMAGE_POLICY=pinned`, `rostok stack add` writes the exact version, and
`rostok images update` moves it (see [commands](../../docs/commands.md)). Keep it on the server's
version.

| Variable             | Default   | Image                                                |
| -------------------- | --------- | ---------------------------------------------------- |
| `CI_AGENT_IMAGE_TAG` | `v3.19.0` | `woodpeckerci/woodpecker-agent` (service `ci-agent`) |
