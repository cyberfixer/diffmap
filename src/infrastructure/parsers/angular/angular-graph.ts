import { posix } from "node:path";
import { Node, Project, SyntaxKind, type ClassDeclaration, type ObjectLiteralExpression } from "ts-morph";
import type { CallGraphInput, CallGraphPort, CallGraphResult } from "../../../application/ports/call-graph.port.js";
import type { SymbolParserInput, SymbolParserPort } from "../../../application/ports/symbol-parser.port.js";
import { CallCollector, walkNeighbourhood } from "../../../application/call-graph-walk.js";
import type { GraphNode } from "../../../domain/graph.js";
import type { ChangedSymbol } from "../../../domain/symbol.js";

/** A component, directive or pipe class and what its decorator says. */
interface NgClass {
  id: string;
  file: string;
  name: string;
  line: number;
  endLine: number;
  elements: string[]; // element selectors: "app-user-card"
  attributes: string[]; // attribute selectors: "appHighlight"
  pipe: string | null; // pipe name
  methods: Map<string, { line: number; endLine: number }>;
  template: { id: string; file: string; line: number; lines: string[] } | null;
}

const str = (o: ObjectLiteralExpression, key: string): string | null => {
  const p = o.getProperty(key);
  const init = p && Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
  return init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init)) ? init.getLiteralText() : null;
};

function readClass(cls: ClassDeclaration, file: string, html: Map<string, string>): NgClass | null {
  const name = cls.getName();
  const deco = cls.getDecorators().find((d) => /^(Component|Directive|Pipe)$/.test(d.getName()));
  const arg = deco?.getArguments()[0];
  if (!name || !deco || !arg || !Node.isObjectLiteralExpression(arg)) return null;

  const selector = str(arg, "selector") ?? "";
  const elements: string[] = [];
  const attributes: string[] = [];
  for (const part of selector.split(",")) {
    const el = part.trim().match(/^[a-z][\w-]*/);
    if (el) elements.push(el[0]);
    for (const m of part.matchAll(/\[([\w-]+)\]/g)) attributes.push(m[1]);
  }

  const methods = new Map<string, { line: number; endLine: number }>();
  for (const m of cls.getMethods()) methods.set(m.getName(), { line: m.getStartLineNumber(), endLine: m.getEndLineNumber() });

  let template: NgClass["template"] = null;
  const url = str(arg, "templateUrl");
  if (url) {
    const path = posix.normalize(posix.join(posix.dirname(file), url));
    const text = html.get(path);
    if (text !== undefined) template = { id: `${path}#template`, file: path, line: 1, lines: text.split("\n") };
  } else {
    const p = arg.getProperty("template");
    const init = p && Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
    if (init) {
      template = { id: `${file}#${name}.template`, file, line: init.getStartLineNumber(), lines: init.getText().split("\n") };
    }
  }

  return {
    id: `${file}#${name}`,
    file,
    name,
    line: cls.getStartLineNumber(),
    endLine: cls.getEndLineNumber(),
    elements,
    attributes,
    pipe: deco.getName() === "Pipe" ? str(arg, "name") : null,
    methods,
    template,
  };
}

/**
 * Angular templates as part of the map: a template that uses `<app-user-card>`
 * points at UserCardComponent, `(click)="save()"` at its component's save(),
 * `| currency` at the pipe class. Matching is by selector, as Angular does.
 */
export class AngularGraph implements CallGraphPort {
  readonly supportedExtensions = [".ts", ".html"] as const;
  /** Runs next to the language graphs, also when a SCIP index is used. */
  readonly alongsideIndex = true;

  isExact(path: string): boolean {
    return path.endsWith(".html");
  }

  build(input: CallGraphInput): CallGraphResult {
    const html = new Map(input.files.filter((f) => f.path.endsWith(".html")).map((f) => [f.path, f.source]));
    const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
    const classes: NgClass[] = [];
    for (const f of input.files) {
      if (!f.path.endsWith(".ts") || !/@(Component|Directive|Pipe)\s*\(/.test(f.source)) continue;
      const sf = project.createSourceFile("/" + f.path, f.source, { overwrite: true });
      for (const cls of sf.getDescendantsOfKind(SyntaxKind.ClassDeclaration)) {
        const ng = readClass(cls, f.path, html);
        if (ng) classes.push(ng);
      }
    }
    if (classes.length === 0) return { nodes: [], edges: [] };

    const meta = new Map<string, GraphNode>();
    const linesOf = new Map<string, string[]>();
    for (const f of input.files) linesOf.set(f.path, f.source.split("\n").map((l) => l.replace(/\r$/, "")));
    const add = (id: string, file: string, name: string, kind: GraphNode["kind"], line: number, endLine: number) => {
      if (!meta.has(id)) meta.set(id, { id, file, name, kind, changed: false, line, endLine, labels: [] });
    };

    const byElement = new Map<string, NgClass>();
    const byAttribute = new Map<string, NgClass>();
    const byPipe = new Map<string, NgClass>();
    for (const c of classes) {
      add(c.id, c.file, c.name, "class", c.line, c.endLine);
      for (const [m, r] of c.methods) add(`${c.file}#${c.name}.${m}`, c.file, `${c.name}.${m}`, "method", r.line, r.endLine);
      if (c.template) add(c.template.id, c.template.file, `${c.name} template`, "template", c.template.line, c.template.line + c.template.lines.length - 1);
      for (const e of c.elements) byElement.set(e, c);
      for (const a of c.attributes) byAttribute.set(a.toLowerCase(), c);
      if (c.pipe) byPipe.set(c.pipe, c);
    }

    const collector = new CallCollector();
    for (const owner of classes) {
      const t = owner.template;
      if (!t) continue;
      t.lines.forEach((text, i) => {
        const line = t.line + i;
        const clean = text.replace(/\r$/, "");
        const link = (to: string) => collector.add(t.id, to, "calls", line, clean);
        for (const m of clean.matchAll(/<([a-z][\w-]*)/g)) {
          const c = byElement.get(m[1]);
          if (c && c !== owner) link(c.id);
        }
        // attributes inside tags, e.g. <p appHighlight> or [appHighlight]="x"
        for (const m of clean.matchAll(/[\s[(*]([A-Za-z][\w-]*)\]?\)?(?=[\s=>/])/g)) {
          const c = byAttribute.get(m[1].toLowerCase());
          if (c && c !== owner) link(c.id);
        }
        for (const m of clean.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
          if (owner.methods.has(m[1])) link(`${owner.file}#${owner.name}.${m[1]}`);
        }
        for (const m of clean.matchAll(/\|\s*([A-Za-z]\w*)/g)) {
          const c = byPipe.get(m[1]);
          if (!c) continue;
          link(c.id);
          // `| initials` runs the pipe's transform()
          if (c.methods.has("transform")) link(`${c.file}#${c.name}.transform`);
        }
      });
    }
    return walkNeighbourhood({ meta, linesOf, calls: collector.calls, changedIds: input.changedIds, depth: input.depth });
  }
}

/** A changed `*.component.html` counts as a changed symbol: its component's template. */
export class AngularTemplateParser implements SymbolParserPort {
  readonly supportedExtensions = [".html"] as const;

  parse(input: SymbolParserInput): ChangedSymbol[] {
    if (!/\.component\.html$/.test(input.filePath)) return [];
    if (input.addedLines.size === 0 && input.removedLines.size === 0) return [];
    const count = (s: string | null) => (s === null ? 0 : s.split("\n").length);
    return [
      {
        id: `${input.filePath}#template`,
        file: input.filePath,
        name: "template",
        kind: "template",
        status: input.baseSource === null ? "added" : input.headSource === null ? "removed" : "modified",
        baseRange: input.baseSource === null ? null : { start: 1, end: count(input.baseSource) },
        headRange: input.headSource === null ? null : { start: 1, end: count(input.headSource) },
        diff: input.diffLines.filter((l) => l.type !== "ctx"),
      },
    ];
  }
}
