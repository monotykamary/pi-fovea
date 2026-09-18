// Bend 2 has no ast-grep grammar. Read its indentation-based declarations
// and explicit references without executing the compiler or fetching packages.
import type { CallSite, ImportSite, LiteralSite, SymbolRec } from "./types.js";

interface BendFacts {
  symbols: SymbolRec[];
  imports: ImportSite[];
  calls: CallSite[];
  literals: LiteralSite[];
}

const NAME = "[A-Za-z_][A-Za-z0-9_.]*";
const DECL = new RegExp(`^(?:@unsafe\\s+)?(def|law|type)\\s+(${NAME})(?=[\\s(<:]|$)`);
const CONSTRUCTOR = new RegExp(`^\\s+(${NAME})\\s*\\{`);
const CALL = new RegExp(`\\b(${NAME})\\s*!?\\s*\\(`, "g");
const CALL_KEYWORDS = new Set(["def", "type", "law", "match", "case", "do", "return", "for", "exs", "where", "is", "import", "Type", "Data", "Kind", "Quant"]);
const IMPORT = new RegExp(`^import\\s+(\\S+?)(?:\\s+as\\s+(${NAME}))?\\s*$`);

export const extractBend = (file: string, text: string): BendFacts => {
  const facts: BendFacts = { symbols: [], imports: [], calls: [], literals: [] };
  let inType = false;
  let header = false;
  let brackets: string[] = [];
  let quote = "";
  let value = "";
  let literalLine = 0;
  const lines = text.split("\n");
  for (let at = 0; at < lines.length; at++) {
    const raw = lines[at]!;
    const line = at + 1;
    // Mask comments and strings, preserving offsets for foreign import paths.
    // Escapes consume the following character, including an escaped quote.
    let code = "";
    let visible = "";
    const strings: Array<{ start: number; text: string }> = [];
    let start = -1;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      if (quote) {
        code += " ";
        visible += ch;
        if (ch === "\\" && i + 1 < raw.length) {
          const escaped = raw[++i]!;
          value += ({ n: "\n", r: "\r", t: "\t", "0": "\0" } as Record<string, string>)[escaped] ?? escaped;
          code += " ";
          visible += escaped;
        } else if (ch === quote) {
          if (quote === '"') {
            strings.push({ start, text: value });
            if (value.length >= 2 && value.length <= 200) facts.literals.push({ file, line: literalLine, text: value });
          }
          quote = "";
        } else value += ch;
      } else if (ch === "#") {
        break;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        value = "";
        literalLine = line;
        start = i;
        code += " ";
        visible += ch;
      } else {
        code += ch;
        visible += ch;
      }
    }
    if (quote) value += "\n";
    if (!code.trim()) continue;
    const decl = DECL.exec(code);
    if (decl) {
      const kind = decl[1] === "def" ? "function" : decl[1] === "type" ? "type" : "decl";
      const sig = visible.trim();
      facts.symbols.push({ file, line, name: decl[2]!, kind, sig: sig.length > 140 ? sig.slice(0, 137) + "..." : sig, lang: "Bend" });
      inType = decl[1] === "type";
      header = true;
      brackets = [];
    } else if (!header && /^\S/.test(code)) {
      inType = false;
    }
    // A colon inside a parameter annotation does not end a multiline header.
    if (header) {
      for (let i = 0; i < code.length; i++) {
        const ch = code[i]!;
        if ("(<{[".includes(ch)) brackets.push(ch);
        else if (")>}]".includes(ch) && !(ch === ">" && code[i - 1] === "-")) {
          if (brackets.at(-1) === ({ ")": "(", ">": "<", "}": "{", "]": "[" } as Record<string, string>)[ch]) brackets.pop();
        } else if (ch === ":" && brackets.length === 0) {
          header = false;
          code = " ".repeat(i + 1) + code.slice(i + 1);
          break;
        }
      }
      if (header) continue;
    }
    const imp = IMPORT.exec(code);
    if (imp) {
      facts.imports.push({ file, line, spec: imp[1]!, ...(imp[2] ? { alias: imp[2] } : {}) });
      continue;
    }
    if (/^\s+import\s+/.test(code)) {
      const path = strings.find((s) => s.start >= 0 && /^\s+import\s+$/.test(code.slice(0, s.start)));
      if (path) facts.imports.push({ file, line, spec: path.text });
      continue;
    }
    if (inType) {
      const ctor = CONSTRUCTOR.exec(code);
      if (ctor) facts.symbols.push({ file, line, name: ctor[1]!, kind: "decl", sig: visible.trim().slice(0, 140), lang: "Bend" });
      continue;
    }
    CALL.lastIndex = 0;
    for (const call of code.matchAll(CALL)) {
      // Kind is syntax, not a user-defined function. Keep dotted names whole:
      // their dots may be literal name characters, not module boundaries.
      if (!CALL_KEYWORDS.has(call[1]!)) facts.calls.push({ file, line, callee: call[1]! });
    }
  }
  // A law and its implementation share a graph identity. Prefer the concrete
  // def's location; likewise a type and its identically named constructor are
  // one symbol, not duplicate nodes with conflicting enclosing locations.
  const symbols = new Map<string, SymbolRec>();
  for (const symbol of facts.symbols) {
    if (!symbols.has(symbol.name) || symbol.kind === "function") symbols.set(symbol.name, symbol);
  }
  facts.symbols = [...symbols.values()].sort((a, b) => a.line - b.line);
  return facts;
};
