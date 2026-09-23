# draw.io MCP server

The official [draw.io](https://www.draw.io) MCP server. It gives LLMs two tools: `create_diagram` renders draw.io XML as an interactive diagram inline in chat on MCP Apps hosts (Claude.ai, Cursor and others), with an "Open in draw.io" button, and `search_shapes` finds shapes across the draw.io libraries (AWS, Azure, GCP, Cisco, Kubernetes, P&ID, electrical, BPMN and more).

This image runs the same server that is hosted at `https://mcp.draw.io/mcp`. Use it when you want to self-host, for example to keep diagram data inside your own network.

## Usage

```bash
docker run --rm -p 127.0.0.1:3001:3001 jgraph/drawio-mcp
```

The MCP endpoint is then `http://localhost:3001/mcp` (Streamable HTTP). Add it as a remote MCP server in your host.

| Environment variable | Effect |
|---|---|
| `PORT` | Listening port inside the container (default `3001`); map it with `-p` |
| `ALLOWED_HOSTS` | Comma-separated hostnames the server answers to (checked against the `Host` header), e.g. `drawio-mcp.internal,localhost`. Unset: any |
| `DRAWIO_ICON_SERVICE_URL` | Set to `off` to keep `search_shapes` from querying the draw.io icon service |

Hosts that need a public URL (such as Claude.ai) can reach a local container through a tunnel, for example `npx cloudflared tunnel --url http://localhost:3001`, and use the tunnel URL with `/mcp` appended. Anyone who has that URL can use the server.

## Deployment boundary

- **Network exposure.** `-p 127.0.0.1:3001:3001` makes the server reachable from this machine only. `-p 3001:3001` publishes it on every interface of the Docker host, so everyone on your network can reach it.
- **Authentication.** The server has none. If teammates should reach it, put it behind a reverse proxy or gateway that authenticates them, and set `ALLOWED_HOSTS` to the hostname they use.
- **Storage.** Nothing is stored. The server is stateless, needs no volume, and does not write diagram content to its logs (only request metadata: method, status, timing). Diagrams live in the chat and in the draw.io files you save.
- **Outbound access from the container.** None is needed for diagrams. Diagram content is never sent anywhere. The shape library is built into the image. The only outbound requests are:
  - `icons.diagrams.net` for `search_shapes`, when the built-in library has no strong match; carries only the search terms. `DRAWIO_ICON_SERVICE_URL=off` disables it.
  - `viewer.diagrams.net`, a version check for the edge-routing code at startup and once a day. It carries no data and times out after 5 seconds, so it is harmless to block.
- **Outbound access from the user's browser.** The inline diagram viewer in the chat loads the draw.io viewer code from `viewer.diagrams.net`. This fetches application code only, never diagram content.

## Tags

- `latest` — the current release
- `1.0.3`, … — one tag per server version

Images are built for `linux/amd64` and `linux/arm64`.

## Links

- [Source and documentation](https://github.com/jgraph/drawio-mcp/tree/main/mcp-app-server) (Apache-2.0)
- [Dockerfile](https://github.com/jgraph/drawio-mcp/blob/main/mcp-app-server/Dockerfile)
- [Data residency and offline use](https://github.com/jgraph/drawio-mcp#data-residency--offline-use)
- [Issues](https://github.com/jgraph/drawio-mcp/issues)
