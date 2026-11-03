import { ts } from "ts-morph";
import type {
  HighlightKind,
  HighlightToken,
  SyntaxHighlighterPort,
} from "../../../application/ports/syntax-highlighter.port.js";

const K = ts.SyntaxKind;

/** After these a "/" divides; after anything else it starts a regex literal. */
const DIVISION_PRECEDERS = new Set<ts.SyntaxKind>([
  K.Identifier, K.PrivateIdentifier, K.NumericLiteral, K.BigIntLiteral, K.StringLiteral,
  K.RegularExpressionLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateTail,
  K.CloseParenToken, K.CloseBracketToken, K.CloseBraceToken, K.PlusPlusToken,
  K.MinusMinusToken, K.ThisKeyword, K.SuperKeyword, K.TrueKeyword, K.FalseKeyword, K.NullKeyword,
]);

/** A contextual keyword followed by one of these is really a name (`{ type: 1 }`, `get(`). */
const NAME_FOLLOWERS = new Set<ts.SyntaxKind>([
  K.ColonToken, K.DotToken, K.QuestionDotToken, K.OpenParenToken,
]);

const isTrivia = (k: ts.SyntaxKind): boolean =>
  k === K.WhitespaceTrivia ||
  k === K.NewLineTrivia ||
  k === K.SingleLineCommentTrivia ||
  k === K.MultiLineCommentTrivia;

interface Raw {
  kind: ts.SyntaxKind;
  text: string;
}

export class TsHighlighter implements SyntaxHighlighterPort {
  readonly supportedExtensions = [".ts", ".tsx"] as const;

  highlight(_path: string, lines: string[]): HighlightToken[][] | null {
    if (lines.length === 0) return [];

    const raw = scan(lines.join("\n"));
    const out: HighlightToken[][] = [[]];

    classify(raw).forEach((kind, i) => {
      // Comments and template strings can span lines: split them per line.
      raw[i].text.split("\n").forEach((part, n) => {
        if (n > 0) out.push([]);
        const text = part.replace(/\r$/, "");
        if (text === "") return;
        const line = out[out.length - 1];
        const last = line[line.length - 1];
        if (last && last.kind === kind && kind === "plain") last.text += text;
        else line.push({ text, kind });
      });
    });

    return out.length === lines.length ? out : null;
  }
}

function scan(source: string): Raw[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    source
  );
  const raw: Raw[] = [];
  const stack: ("brace" | "template")[] = [];
  let prev: ts.SyntaxKind | null = null;

  for (let k = scanner.scan(); k !== K.EndOfFileToken; k = scanner.scan()) {
    if ((k === K.SlashToken || k === K.SlashEqualsToken) && (prev === null || !DIVISION_PRECEDERS.has(prev))) {
      k = scanner.reScanSlashToken();
    } else if (k === K.TemplateHead) {
      stack.push("template");
    } else if (k === K.OpenBraceToken) {
      stack.push("brace");
    } else if (k === K.CloseBraceToken && stack.pop() === "template") {
      // The "}" closing a ${ } substitution continues the template string.
      k = scanner.reScanTemplateToken(false);
      if (k === K.TemplateMiddle) stack.push("template");
    }
    raw.push({ kind: k, text: scanner.getTokenText() });
    if (!isTrivia(k)) prev = k;
  }
  return raw;
}

function classify(raw: Raw[]): HighlightKind[] {
  const sig: number[] = []; // indexes of non-trivia tokens
  raw.forEach((t, i) => {
    if (!isTrivia(t.kind)) sig.push(i);
  });
  const pos = new Map(sig.map((rawIndex, n) => [rawIndex, n]));
  const kinds: HighlightKind[] = raw.map(() => "plain");

  raw.forEach((t, i) => {
    const k = t.kind;
    const n = pos.get(i);
    const prevK = n !== undefined && n > 0 ? raw[sig[n - 1]].kind : null;
    const next = n !== undefined && n + 1 < sig.length ? raw[sig[n + 1]].kind : null;

    if (k === K.SingleLineCommentTrivia || k === K.MultiLineCommentTrivia) {
      kinds[i] = "comment";
    } else if (
      k === K.StringLiteral || k === K.NoSubstitutionTemplateLiteral || k === K.TemplateHead ||
      k === K.TemplateMiddle || k === K.TemplateTail || k === K.RegularExpressionLiteral
    ) {
      kinds[i] = "string";
    } else if (k === K.NumericLiteral || k === K.BigIntLiteral) {
      kinds[i] = "number";
    } else if (k === K.AtToken) {
      kinds[i] = "decorator";
    } else if (k >= K.FirstKeyword && k <= K.LastKeyword) {
      const afterDot = prevK === K.DotToken || prevK === K.QuestionDotToken;
      const asName = k >= K.AbstractKeyword && next !== null && NAME_FOLLOWERS.has(next);
      kinds[i] = afterDot || asName ? (next === K.OpenParenToken ? "function" : "plain") : "keyword";
    } else if (k === K.Identifier) {
      if (prevK === K.AtToken) kinds[i] = "decorator";
      else if (next === K.OpenParenToken) kinds[i] = "function";
      else if (/^[A-Z]/.test(t.text)) kinds[i] = "type";
    }
  });
  return kinds;
}
