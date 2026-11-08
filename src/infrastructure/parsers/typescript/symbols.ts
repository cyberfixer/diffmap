import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { SymbolInfo, SymbolKind } from "../../../domain/symbol.js";

export type { SymbolInfo };

export interface SymbolNode {
  info: SymbolInfo;
  node: Node;
  /** Decorators such as "@Patch(':id')". */
  labels: string[];
}

/** Collect every named function / method / class / arrow-variable in the file. */
export function listSymbolNodes(sourceFile: SourceFile): SymbolNode[] {
  const symbols: SymbolNode[] = [];

  function visit(node: Node): void {
    let kind: SymbolKind | null = null;
    let name: string | null = null;

    if (Node.isFunctionDeclaration(node)) {
      name = node.getName() ?? null;
      if (name) kind = "function";
    } else if (Node.isMethodDeclaration(node)) {
      name = buildMethodName(node);
      kind = "method";
    } else if (Node.isConstructorDeclaration(node)) {
      const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
      name = cls?.getName() ? `${cls.getName()}.constructor` : "constructor";
      kind = "method";
    } else if (Node.isClassDeclaration(node)) {
      name = node.getName() ?? null;
      if (name) kind = "class";
    } else if (Node.isInterfaceDeclaration(node)) {
      name = node.getName();
      kind = "interface";
    } else if (Node.isMethodSignature(node)) {
      const owner = node.getFirstAncestorByKind(SyntaxKind.InterfaceDeclaration);
      name = owner ? `${owner.getName()}.${node.getName()}` : node.getName();
      kind = "method";
    } else if (Node.isEnumDeclaration(node)) {
      name = node.getName();
      kind = "enum";
    } else if (Node.isVariableDeclaration(node)) {
      const init = node.getInitializer();
      if (init && Node.isArrowFunction(init)) {
        name = buildVariableName(node);
        kind = "arrow";
      }
    }

    if (kind !== null && name !== null) {
      symbols.push({
        info: {
          name,
          kind,
          range: { start: node.getStartLineNumber(), end: node.getEndLineNumber() },
        },
        node,
        labels: decoratorLabels(node),
      });
    }

    node.forEachChild(visit);
  }

  visit(sourceFile);
  return symbols;
}

function decoratorLabels(node: Node): string[] {
  if (!Node.isDecoratable(node)) return [];
  return node.getDecorators().map((d) => {
    const text = d.getText().replace(/\s+/g, " ");
    return text.length > 48 ? text.slice(0, 47) + "…" : text;
  });
}

function buildMethodName(node: Node): string {
  const methodName = Node.isMethodDeclaration(node) ? node.getName() : "";
  const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  return cls?.getName() ? `${cls.getName()}.${methodName}` : methodName;
}

function buildVariableName(node: Node): string {
  const varName = Node.isVariableDeclaration(node) ? node.getName() : "";
  const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  return cls?.getName() ? `${cls.getName()}.${varName}` : varName;
}
