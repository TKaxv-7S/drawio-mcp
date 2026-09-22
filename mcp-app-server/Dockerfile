# Builds the Node.js entry (src/index.js) of the MCP App server.
#
# Build from the REPOSITORY ROOT, not from this directory: at startup the
# server reads the shared references and the shape index from the sibling
# ../shared and ../shape-search directories.
#
#   docker build -f mcp-app-server/Dockerfile -t drawio-mcp-app .
#   docker run --rm -p 3001:3001 drawio-mcp-app
#
# The endpoint is then http://localhost:3001/mcp (PORT overrides the port).
#
# Published to Docker Hub as jgraph/drawio-mcp (linux/amd64 + linux/arm64) by
# .github/workflows/publish-app-server-image.yml.

FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app/mcp-app-server

# Dependencies first so they cache independently of source edits. wrangler is
# a devDependency (Workers deploys only) and is left out.
COPY mcp-app-server/package.json mcp-app-server/package-lock.json ./
RUN npm ci --omit=dev

# What src/index.js reads at startup, laid out as in the repository.
COPY shared /app/shared
COPY shape-search/search-index.json /app/shape-search/search-index.json
COPY mcp-app-server/src ./src
COPY mcp-app-server/favicon.png ./

USER node
EXPOSE 3001
CMD ["node", "src/index.js"]
