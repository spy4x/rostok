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
| `CI_AGENT_CPU_SET`       | empty (all)   | CPUs workflows may use, such as `2-5,8-11`                     |
| `CI_AGENT_MEM_LIMIT`     | `0` (none)    | Memory per workflow container in bytes, swap included          |
| `CI_AGENT_AGENT_LABELS`  | empty         | Labels the agent reports, such as `!size=small` ("Labels")     |

Deploy stops with an error while the gRPC host or the secret is empty.

Each workflow runs as its own containers next to the agent, outside the agent's memory and CPU
limits. Size `CI_AGENT_MAX_WORKFLOWS` to the machine's free memory and cores, and set
`CI_AGENT_CPU_SET` to keep a core or two free for the machine's other work. Set
`CI_AGENT_MEM_LIMIT` (for example `10737418240`, 10 GiB) so one step that leaks or builds something
large hits its own limit instead of pushing the machine's other work into swap. Measure first:
`docker stats` on the `wp_*` containers during your heaviest pipeline.

## Labels

Without labels any agent takes any workflow, so a weak second machine (a laptop, a small board)
takes browser suites and image builds it runs several times slower than the main agent. One label
routes by size:

- the main agent: `size=small` (`CI_AGENT_AGENT_LABELS`, or `WOODPECKER_CI_AGENT_LABELS` in the
  `woodpecker` stack). It takes every workflow, labelled or not;
- the weaker agent: `!size=small`. The `!` makes it take only workflows that set the label;
- a project's light workflow (format, lint, type-check, unit tests): `labels: { size: small }`.

A workflow that sets a label waits until an agent reports it, so give the agents their labels
before any workflow sets one.

Labels route work; they are not a security boundary. An agent reports its own labels, so a
compromised agent can claim any of them. To restrict which workflows an agent may receive, use the
server's agent filter (Settings → Agents), which overrides the agent's labels.

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
