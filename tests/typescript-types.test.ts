import { describe, it, expect, afterEach } from "vitest";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";
import { AnalyzeRangeUseCase } from "../src/application/use-cases/analyze-range.js";
import { GitDiffReader } from "../src/infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../src/infrastructure/git/git-source-reader.js";
import { TsMorphAdapter } from "../src/infrastructure/parsers/typescript/ts-morph.adapter.js";
import { TsMorphCallGraph } from "../src/infrastructure/parsers/typescript/ts-morph-call-graph.js";
import { renderHtml } from "../src/interfaces/html/render-html.js";

let repo: FixtureRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const TYPES = (extra: { field?: string; status?: string; kind?: string } = {}) => `export interface Order {
  id: number;
  total: number;${extra.field ?? ""}
}

export type Status = "open" | "paid"${extra.status ?? ""};

export enum Kind {
  Online,
  Shop,${extra.kind ?? ""}
}
`;
const USE = `import { Order, Status, Kind } from "./types";

export function pay(order: Order): Status {
  return order.total > 0 ? "paid" : "open";
}

export class Checkout {
  private last?: Order;
  kind: Kind = Kind.Online;
}

export const label = (s: Status) => s.toUpperCase();

export interface PaidOrder extends Order {
  paidAt: Date;
}

export function many(orders: Promise<Order[]>) {
  return orders;
}
`;

function analyse(before: Record<string, string>, after: Record<string, string>) {
  repo = createFixtureRepo();
  for (const [p, s] of Object.entries(before)) repo.write(p, s);
  repo.commit("initial");
  for (const [p, s] of Object.entries(after)) repo.write(p, s);
  repo.commit("change");
  return new AnalyzeRangeUseCase(new GitDiffReader(repo.dir), new GitSourceReader(repo.dir), [new TsMorphAdapter()], [new TsMorphCallGraph()]).execute("HEAD~1", "HEAD");
}
const users = (r: ReturnType<typeof analyse>, type: string, kind = "uses-type") =>
  r.edges.filter((e) => e.to === `src/types.ts#${type}` && e.kind === kind).map((e) => e.from.split("#")[1]).sort();

describe("TypeScript: where a type is used", () => {
  it("an interface, a type alias and an enum show who writes them", () => {
    const r = analyse(
      { "src/types.ts": TYPES(), "src/use.ts": USE },
      { "src/types.ts": TYPES({ field: "\n  note?: string;", status: ' | "void"', kind: "\n  Phone," }) },
    );
    expect(r.symbols.map((s) => `${s.kind} ${s.name}`).sort()).toEqual(["enum Kind", "interface Order", "type Status"]);
    // A parameter, a field, `extends`, inside a generic.
    expect(users(r, "Order")).toEqual(["Checkout", "PaidOrder", "many", "pay"]);
    // A return type, an arrow function's parameter.
    expect(users(r, "Status")).toEqual(["label", "pay"]);
    // A field's type and `Kind.Online`.
    expect(users(r, "Kind")).toEqual(["Checkout"]);
  });

  it("a changed function does not bring in the types it mentions", () => {
    const r = analyse(
      { "src/types.ts": TYPES(), "src/use.ts": USE },
      { "src/use.ts": USE.replace('return order.total > 0 ? "paid" : "open";', 'return order.total >= 0 ? "paid" : "open";') },
    );
    expect(r.symbols.map((s) => s.name)).toEqual(["pay"]);
    expect(r.nodes.map((n) => n.id).sort()).toEqual(["src/use.ts#pay"]);
  });

  it("a removed type that is still written is a use of removed code", () => {
    const r = analyse({ "src/types.ts": TYPES(), "src/use.ts": USE }, { "src/types.ts": TYPES().replace(/export type Status = [^\n]*\n\n/, "") });
    expect(users(r, "Status", "calls-removed")).toEqual(["label", "pay"]);
  });

  it("the page tags such a usage as a type", () => {
    const r = analyse({ "src/types.ts": TYPES(), "src/use.ts": USE }, { "src/types.ts": TYPES({ field: "\n  note?: string;" }) });
    const data = JSON.parse(renderHtml(r).match(/var DIFFMAP = (.*?);<\/script>/)![1]);
    const order = data.syms.find((s: { name: string }) => s.name === "Order");
    expect(order.kind).toBe("interface");
    expect(order.refs.length).toBe(4);
    expect(order.refs.every((x: { type?: boolean }) => x.type === true)).toBe(true);
  });
});
