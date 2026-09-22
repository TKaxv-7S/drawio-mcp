# draw.io MCP server

The official [draw.io](https://www.draw.io) MCP server. It gives LLMs two tools: `create_diagram` renders draw.io XML as an interactive diagram inline in chat on MCP Apps hosts (Claude.ai, Cursor and others), with an "Open in draw.io" button, and `search_shapes` finds shapes across the draw.io libraries (AWS, Azure, GCP, Cisco, Kubernetes, P&ID, electrical, BPMN and more).

This image runs the same server that is hosted at `https://mcp.draw.io/mcp`. Use it when you want to self-host, for example to keep diagram data inside your own network.

## Usage

```bash
docker run --rm -p 3001:3001 jgraph/drawio-mcp
```

The MCP endpoint is then `http://localhost:3001/mcp` (Streamable HTTP). Add it as a remote MCP server in your host.

| Environment variable | Effect |
|---|---|
| `PORT` | Listening port inside the container (default `3001`); map it with `-p` |
| `DRAWIO_ICON_SERVICE_URL` | Set to `off` to keep `search_shapes` from querying the draw.io icon service, for fully offline use |

Hosts that need a public URL (such as Claude.ai) can reach a local container through a tunnel, for example `npx cloudflared tunnel --url http://localhost:3001`, and use the tunnel URL with `/mcp` appended.

## Tags

- `latest` — the current release
- `1.0.3`, … — one tag per server version

Images are built for `linux/amd64` and `linux/arm64`.

## Links

- [Source and documentation](https://github.com/jgraph/drawio-mcp/tree/main/mcp-app-server) (Apache-2.0)
- [Dockerfile](https://github.com/jgraph/drawio-mcp/blob/main/mcp-app-server/Dockerfile)
- [Data residency and offline use](https://github.com/jgraph/drawio-mcp#data-residency--offline-use)
- [Issues](https://github.com/jgraph/drawio-mcp/issues)
