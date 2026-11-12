# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
# Keep only the tree-sitter grammars diffmap uses (see src/infrastructure/parsers/tree-sitter/languages.ts).
# Swift's is not among them: it comes from grammars/ (see grammars/README.md).
RUN cd node_modules/tree-sitter-wasms/out && for f in *.wasm; do \
      case "$f" in tree-sitter-javascript.wasm|tree-sitter-python.wasm|tree-sitter-java.wasm|tree-sitter-go.wasm|\
        tree-sitter-c_sharp.wasm|tree-sitter-php.wasm|tree-sitter-ruby.wasm|tree-sitter-rust.wasm|tree-sitter-kotlin.wasm|\
        tree-sitter-scala.wasm|tree-sitter-c.wasm|tree-sitter-cpp.wasm) ;; *) rm "$f" ;; esac; done

# ---- run ----
FROM node:20-alpine
# git is needed to fetch merge request code; tini forwards stop signals.
RUN apk add --no-cache git tini
WORKDIR /app
ENV NODE_ENV=production PORT=8080 CACHE_DIR=/data/repos
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY grammars ./grammars
COPY package.json ./
RUN mkdir -p /data/repos && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
