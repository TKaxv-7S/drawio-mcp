# Draw.io MCP App Server

The MCP App server renders draw.io diagrams **inline** in AI chat interfaces using the [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) protocol. Instead of opening a browser tab, diagrams appear directly in the conversation as interactive iframes.

## How It Works

1. The LLM calls the `create_diagram` tool with draw.io XML
2. The host fetches the UI resource and renders it in a sandboxed iframe
3. The diagram is rendered using the official [draw.io viewer](https://viewer.diagrams.net)
4. The user sees an interactive diagram inline with zoom, pan, and layers support

## Tool: `create_diagram`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `xml` | string | One of `xml` / `mermaid` | draw.io XML in mxGraphModel format. Mutually exclusive with `mermaid`. |
| `mermaid` | string | One of `xml` / `mermaid` | Mermaid.js diagram definition (26 supported diagram types — flowchart, sequence, class, state, ER, gantt, mindmap, timeline, quadrant, C4, architecture, …). Parsed and laid out natively, then converted to draw.io. Mutually exclusive with `xml`. |
| `postLayout` | enum | No | Optional ELK layered-flow pass applied after render. Only value: `"elk"`. Vertex positions are replaced; only edge topology survives. |
| `direction` | enum | No | XML-only flow direction for `postLayout: "elk"`: `"vertical"` (default) or `"horizontal"`. Ignored for Mermaid (direction comes from the `flowchart TD/LR` code). |

Provide exactly one of `xml` or `mermaid` as a plain string — not an object or array.

The rendered diagram includes:
- Interactive zoom, pan, and navigation
- Layer toggling and lightbox mode
- "Open in draw.io" button to edit the diagram in the full editor
- Fullscreen mode

## Official Hosted Endpoint

The official draw.io MCP App server is hosted at:

```
https://mcp.draw.io/mcp
```

Add this URL as a remote MCP server in Claude.ai, Cursor, or any MCP Apps-compatible host — no installation or setup required.

> **Note:** This server renders diagrams **inline** via the [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) protocol, so it requires an MCP Apps–capable host (e.g. Claude.ai or Cursor). In hosts that don't support MCP Apps — such as **VS Code / GitHub Copilot** or Claude Code — the tool connects but has nothing to render, so the diagram won't appear. For those clients use the stdio [`@drawio/mcp`](../mcp-tool-server) tool server instead, which opens diagrams in the browser. ChatGPT isn't supported yet: its connectors are remote-only and use OpenAI's own widget format rather than MCP Apps, so the diagram won't render inline — and unlike the editors above, the stdio fallback can't be used.

### Using with Cursor

Cursor supports the MCP Apps extension (Cursor **≥ 2.6**), so diagrams render inline in the Agent chat. On older builds the server still connects, but there's nothing to render inline; use the stdio [`@drawio/mcp`](../mcp-tool-server) tool server instead, which opens diagrams in the browser.

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=drawio&config=eyJ1cmwiOiJodHRwczovL21jcC5kcmF3LmlvL21jcCJ9)

Click the button above for one-click install, or add the hosted endpoint manually to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "drawio": {
      "url": "https://mcp.draw.io/mcp"
    }
  }
}
```

Enable the server when prompted (or under **Cursor Settings → MCP**), then ask the Agent to create a diagram.

### Using with OpenCode

[OpenCode](https://opencode.ai) connects to the hosted endpoint as a remote MCP server. Add it under the `mcp` key of `opencode.json` in your project root (or `~/.config/opencode/opencode.json` for every project):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "drawio": {
      "type": "remote",
      "url": "https://mcp.draw.io/mcp",
      "enabled": true
    }
  }
}
```

OpenCode has no MCP Apps UI, so nothing renders inline: `create_diagram` detects that and returns an `app.diagrams.net` link that opens the diagram in the editor instead. If you would rather have diagrams open in your browser directly (and also author them as Mermaid or CSV), use the stdio [`@drawio/mcp`](../mcp-tool-server/README.md#opencode) tool server.

## Self-Hosting

If you prefer to run your own instance, you can use Node.js, Docker, or deploy to Cloudflare Workers.

### Installation

```bash
cd mcp-app-server
npm install
```

### Running (Node.js)

Start the HTTP server (for Claude.ai and other web-based hosts):

```bash
npm start
```

The server listens on `http://localhost:3001/mcp` by default. Set the `PORT` environment variable to change the port.

### Running (Docker)

The [`Dockerfile`](Dockerfile) packages the same Node.js server. Build it from the **repository root**, not from this directory — at startup the server reads the shared references and the shape index from the sibling `shared/` and `shape-search/` directories:

```bash
docker build -f mcp-app-server/Dockerfile -t drawio-mcp-app .
docker run --rm -p 3001:3001 drawio-mcp-app
```

The endpoint is `http://localhost:3001/mcp`, as with `npm start`. Pass `-e PORT=8080 -p 8080:8080` to change the port, and `-e DRAWIO_ICON_SERVICE_URL=off` to keep `search_shapes` from querying the draw.io icon service (see [Data Residency & Offline Use](../README.md#data-residency--offline-use)).

### Connecting to Claude.ai

Since Claude.ai needs a public URL, use a tunnel:

```bash
npx cloudflared tunnel --url http://localhost:3001
```

Then add the tunnel URL (with `/mcp` appended) as a custom connector in Claude.ai settings.

### Using with Claude Desktop (stdio)

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "drawio-app": {
      "command": "node",
      "args": ["path/to/mcp-app-server/src/index.js", "--stdio"]
    }
  }
}
```

> **Note:** Inline diagram rendering requires an MCP host that supports the MCP Apps extension. In hosts without MCP Apps support, the tool still works but returns the XML as text.

## Deploying to Cloudflare Workers

The server can be deployed to Cloudflare Workers for a public endpoint without tunnels.

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- Node.js 18+

### Deploy

```bash
npm install
npx wrangler login        # One-time: authenticate with Cloudflare
npm run deploy             # Build + deploy to Workers
```

The deploy script runs `node src/build-html.js` (pre-inlines the SDK bundles into the HTML) then `wrangler deploy`.

### Local development with Wrangler

```bash
npm run dev:worker
```

This starts a local Workers dev server at `http://localhost:8787/mcp`.

### How the Worker entry differs from Node.js

| | Node.js (`src/index.js`) | Worker (`src/worker.js`) |
|---|---|---|
| **Transport** | `StreamableHTTPServerTransport` (Express) | `WebStandardStreamableHTTPServerTransport` (Web Standard `Request`/`Response`) |
| **HTML build** | Reads bundles from `node_modules` at startup | Pre-built at deploy time via `src/build-html.js` → `src/generated-html.js` |
| **Schema validation** | Default (Zod-based) | Default (Zod-based) |

## Publishing to the MCP Registry

The hosted server is listed in the [MCP Community Registry](https://github.com/modelcontextprotocol/registry) as **`io.draw/mcp`**, defined by [`server.json`](server.json) in this directory. The community registry feeds downstream surfaces such as [GitHub's MCP Registry](https://github.com/mcp) and VS Code's *MCP: Browse Servers* (GitHub additionally curates what it features on its own page).

**One-time setup** — prove ownership of the `draw.io` domain. Generate a keypair (macOS's system LibreSSL lacks Ed25519 — use Homebrew OpenSSL 3) and publish the public key as a DNS TXT record:

```bash
brew install mcp-publisher openssl@3
OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
$OPENSSL genpkey -algorithm Ed25519 -out ~/.drawio-mcp-registry-key.pem
echo "draw.io. IN TXT \"v=MCPv1; k=ed25519; p=$($OPENSSL pkey -in ~/.drawio-mcp-registry-key.pem -pubout -outform DER | tail -c 32 | base64)\""
```

Add the printed TXT record on the **apex** of `draw.io` (record name `@` in Cloudflare DNS — not under a selector like `_mcp-auth`, which the registry will not see). Keep the key file for future publishes, and keep it outside the repository; losing it only means generating a new key and replacing the TXT record (remove the stale record — leftovers are tried first and break verification).

**Publish / update** — bump `version` in `server.json` first (kept in lockstep with `package.json`), then from this directory:

```bash
OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
mcp-publisher login dns --domain draw.io --private-key "$($OPENSSL pkey -in ~/.drawio-mcp-registry-key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
mcp-publisher publish
```

The `io.draw` namespace is the reverse-DNS form of the verified `draw.io` domain (the same pattern as the registry's own `io.modelcontextprotocol/everything`). The alternative would be `io.github.jgraph/...` via `mcp-publisher login github`, but that requires jgraph org-owner rights and gives up the brand naming.

## Architecture

### File layout

```
src/
  shared.js          Shared logic: buildHtml(), processAppBundle(), createServer()
  index.js           Node.js entry (Express + stdio transports)
  worker.js          Cloudflare Workers entry (Web Standard fetch handler)
  build-html.js      Build script: generates generated-html.js + xml reference
  generated-html.js  (gitignored) Pre-built HTML string + XML reference for the Worker
wrangler.toml        Wrangler configuration
../shared/
  xml-reference.md   Shared XML generation reference (single source of truth)
```

The `create_diagram` tool description is loaded from `shared/xml-reference.md` at startup (Node.js) or pre-built into `generated-html.js` at deploy time (Workers). This file is the single source of truth for XML generation guidance across all four approaches in the repository.

### How the HTML is built

The server inlines two bundles into a self-contained HTML string:

- **`app-with-deps.js`** (~319 KB) — MCP Apps SDK browser bundle from `@modelcontextprotocol/ext-apps`. The bundle is ESM (ends with `export { ... as App }`), so the server strips the export statement and creates a local `var App = <minifiedName>` alias. This makes it safe to inline in a plain `<script>` tag inside the sandboxed iframe.
- **`pako_deflate.min.js`** (~28 KB) — for compressing XML into the `#create=` URL format.

Both are inlined into the HTML served via `registerAppResource`. The draw.io viewer (`viewer-static.min.js`) is loaded from CDN at runtime.

For **Node.js**, this happens at startup (bundles read from `node_modules` via `fs`). For **Workers**, the `build-html.js` script does this at build time and writes `generated-html.js`.

### Key constraints

- The MCP Apps sandbox uses `sandbox="allow-scripts"` but **not** `allow-same-origin`, so Blob URL module imports fail silently. That's why the ESM export statement is stripped and a plain `var` alias is created.
- `app.openLink()` must be used instead of `<a target="_blank">` since the sandbox doesn't have `allow-popups`.
- `GraphViewer.processElements()` requires the container to have a nonzero `offsetWidth`, hence the `min-width: 200px` on `#diagram-container`.
