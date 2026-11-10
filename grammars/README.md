# Grammars diffmap ships itself

Most tree-sitter grammars come from the `tree-sitter-wasms` package. A grammar in
this folder is used instead when a language's entry in
[languages.ts](../src/infrastructure/parsers/tree-sitter/languages.ts) names it (`wasm:`).

| File | Grammar | Version | SHA-256 |
|---|---|---|---|
| `tree-sitter-swift.wasm` | [alex-pinkus/tree-sitter-swift](https://github.com/alex-pinkus/tree-sitter-swift) (MIT) | 0.7.3 | `0258a7ef17303a8079ffe0748b3583d59656b5c3e8653fca7b6451b3e6689eb2` |

**Why Swift is here:** `tree-sitter-wasms` 0.1.13 carries tree-sitter-swift 0.4 (2023),
which cannot read macros (`#Preview`, `#expect`), `package` access, raw strings
(`#"..."#`) or typed throws. The file is the `tree-sitter-swift.wasm` asset of the
upstream release, unchanged. The grammar's npm package does not contain a wasm build,
so it cannot be a dependency.

**To update:** download the asset of a newer
[release](https://github.com/alex-pinkus/tree-sitter-swift/releases), replace the
file, update the table, and run `npm test`: `tests/swift.test.ts` covers the node
names the Swift rules rely on. The grammar must be one `web-tree-sitter` can load
(language version 13 to 15 with web-tree-sitter 0.25).
