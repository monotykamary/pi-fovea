// Exact schema/document anchors for protocols whose feature identity is not an
// HTTP path. These readers recognize declared grammar only; malformed or
// computed names are ignored rather than guessed.

import { extname } from "node:path";
import type { AnchorDraft } from "./anchors.js";
import { readAll, type FileSource } from "./source.js";

const PROTOCOL_EXTENSIONS = new Set([".proto", ".graphql", ".gql"]);
const NAME = /[_A-Za-z][_0-9A-Za-z]*/y;

const maskSyntax = (text: string, hashComments: boolean): string => {
  const chars = text.split("");
  const blank = (index: number): void => {
    if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  };
  for (let i = 0; i < chars.length;) {
    if (chars[i] === "/" && chars[i + 1] === "/") {
      while (i < chars.length && chars[i] !== "\n") blank(i++);
      continue;
    }
    if (chars[i] === "/" && chars[i + 1] === "*") {
      blank(i++);
      blank(i++);
      while (i < chars.length && !(chars[i] === "*" && chars[i + 1] === "/")) blank(i++);
      if (i < chars.length) {
        blank(i++);
        blank(i++);
      }
      continue;
    }
    if (hashComments && chars[i] === "#") {
      while (i < chars.length && chars[i] !== "\n") blank(i++);
      continue;
    }
    if (chars[i] === '"' || chars[i] === "'") {
      const quote = chars[i]!;
      const triple = chars[i + 1] === quote && chars[i + 2] === quote;
      const width = triple ? 3 : 1;
      for (let n = 0; n < width; n++) blank(i++);
      while (i < chars.length) {
        if (!triple && chars[i] === "\\") {
          blank(i++);
          if (i < chars.length) blank(i++);
          continue;
        }
        if (triple && chars[i] === quote && chars[i + 1] === quote && chars[i + 2] === quote) {
          for (let n = 0; n < 3; n++) blank(i++);
          break;
        }
        if (!triple && chars[i] === quote) {
          blank(i++);
          break;
        }
        blank(i++);
      }
      continue;
    }
    i++;
  }
  return chars.join("");
};

const closingBrace = (text: string, open: number): number | undefined => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return undefined;
};

interface SyntaxBlock {
  match: RegExpExecArray;
  open: number;
  close: number;
}

const syntaxBlocks = (text: string, pattern: RegExp): SyntaxBlock[] => {
  pattern.lastIndex = 0;
  const out: SyntaxBlock[] = [];
  for (let match; (match = pattern.exec(text));) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = closingBrace(text, open);
    if (close === undefined) continue;
    out.push({ match, open, close });
    pattern.lastIndex = close + 1;
  }
  return out;
};

// Find the first grammar block brace outside variable/directive parentheses
// and list brackets. This avoids treating GraphQL input-object defaults as the
// operation/type body while staying parser-free and fail-closed.
const declarationBlocks = (text: string, pattern: RegExp): SyntaxBlock[] => {
  pattern.lastIndex = 0;
  const out: SyntaxBlock[] = [];
  for (let match; (match = pattern.exec(text));) {
    let parentheses = 0;
    let brackets = 0;
    let open: number | undefined;
    for (let i = pattern.lastIndex; i < text.length; i++) {
      const char = text[i];
      if ((char === "\n" || char === "\r") && parentheses === 0 && brackets === 0) {
        const nextLine = text.slice(i + 1);
        if (/^\s*(?:(?:extend\s+)?(?:type|interface|input|enum|scalar|union)|schema|query|mutation|subscription|fragment)\b/.test(nextLine)) break;
      }
      if (char === "(") parentheses++;
      else if (char === ")") parentheses = Math.max(0, parentheses - 1);
      else if (char === "[") brackets++;
      else if (char === "]") brackets = Math.max(0, brackets - 1);
      else if (char === "{" && parentheses === 0 && brackets === 0) {
        open = i;
        break;
      } else if ((char === "}" || char === ";") && parentheses === 0 && brackets === 0) {
        break;
      }
    }
    if (open === undefined) continue;
    const close = closingBrace(text, open);
    if (close === undefined) continue;
    out.push({ match, open, close });
    pattern.lastIndex = close + 1;
  }
  return out;
};

const lineLookup = (text: string): ((index: number) => number) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (index: number): number => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = low + ((high - low) >> 1);
      if (starts[middle]! <= index) low = middle + 1;
      else high = middle;
    }
    return low;
  };
};

const anchor = (file: string, line: number, id: string, kind: string, ruleId: string): AnchorDraft => ({
  id,
  kind,
  label: id,
  nodeId: `file:${file}`,
  file,
  line,
  ruleId,
});

const PROTO_SCALARS = new Set([
  "double", "float", "int32", "int64", "uint32", "uint64", "sint32", "sint64",
  "fixed32", "fixed64", "sfixed32", "sfixed64", "bool", "string", "bytes",
]);

// Statement keywords the field grammar can otherwise misread as a type
// (`option allow_alias = true;`); none of them can name a message.
const PROTO_STATEMENT_KEYWORDS = new Set([
  "option", "oneof", "reserved", "extensions", "extend", "message", "enum",
  "rpc", "service", "syntax", "package", "import", "stream", "group",
]);

const protoAnchors = (file: string, source: string): AnchorDraft[] => {
  const masked = maskSyntax(source, false);
  const lineOf = lineLookup(source);
  const packageName = /\bpackage\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*;/.exec(masked)?.[1];
  const qualify = (name: string): string => {
    const clean = name.replace(/^\./, "");
    return clean.includes(".") || !packageName ? clean : `${packageName}.${clean}`;
  };
  const out: AnchorDraft[] = [];
  const addMessage = (name: string, index: number, ruleId: string): void => {
    const clean = name.replace(/^\./, "");
    if (PROTO_SCALARS.has(clean)) return;
    out.push(anchor(file, lineOf(index), `RPC MESSAGE ${qualify(clean)}`, "rpc-message", ruleId));
  };

  for (const message of syntaxBlocks(masked, /\bmessage\s+([A-Za-z_]\w*)\s*\{/g)) {
    addMessage(message.match[1]!, message.match.index, "proto-message-declaration");
    const bodyOffset = message.open + 1;
    const body = masked.slice(bodyOffset, message.close);
    for (const field of body.matchAll(/(?:^|[;{}])\s*(?:(?:repeated|optional|required)\s+)?(\.?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+[A-Za-z_]\w*\s*=/gm)) {
      const type = field[1]!;
      if (PROTO_STATEMENT_KEYWORDS.has(type)) continue;
      const local = field[0].indexOf(type);
      addMessage(type, bodyOffset + field.index! + Math.max(0, local), "proto-message-field-type");
    }
    for (const mapField of body.matchAll(/\bmap\s*<\s*[^,>]+,\s*(\.?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*>/g)) {
      addMessage(mapField[1]!, bodyOffset + mapField.index!, "proto-map-value-type");
    }
  }

  for (const service of syntaxBlocks(masked, /\bservice\s+([A-Za-z_]\w*)\s*\{/g)) {
    const serviceName = service.match[1]!;
    const qualified = qualify(serviceName);
    out.push(anchor(file, lineOf(service.match.index), `RPC SERVICE ${qualified}`, "rpc-service", "proto-service-declaration"));
    const bodyOffset = service.open + 1;
    const body = masked.slice(bodyOffset, service.close);
    const rpcPattern = /\brpc\s+([A-Za-z_]\w*)\s*\(\s*(?:stream\s+)?(\.?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\)\s*returns\s*\(\s*(?:stream\s+)?(\.?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\)/g;
    for (let rpc; (rpc = rpcPattern.exec(body));) {
      const index = bodyOffset + rpc.index;
      out.push(anchor(file, lineOf(index), `RPC ${qualified}/${rpc[1]!}`, "rpc", "proto-rpc-declaration"));
      addMessage(rpc[2]!, index + rpc[0].indexOf(rpc[2]!), "proto-rpc-request-type");
      addMessage(rpc[3]!, index + rpc[0].lastIndexOf(rpc[3]!), "proto-rpc-response-type");
    }
  }
  return out;
};
interface NamedSite { name: string; index: number }

const graphqlFields = (text: string, start: number, end: number): NamedSite[] => {
  const out: NamedSite[] = [];
  for (let i = start; i < end;) {
    NAME.lastIndex = i;
    const match = NAME.exec(text);
    if (!match) {
      i++;
      continue;
    }
    const name = match[0];
    let cursor = NAME.lastIndex;
    let resume = NAME.lastIndex;
    while (cursor < end && /\s/.test(text[cursor]!)) cursor++;
    if (text[cursor] === "(") {
      let depth = 0;
      do {
        if (text[cursor] === "(") depth++;
        else if (text[cursor] === ")") depth--;
        cursor++;
      } while (cursor < end && depth > 0);
      resume = cursor;
      while (cursor < end && /\s/.test(text[cursor]!)) cursor++;
    }
    if (text[cursor] === ":") {
      out.push({ name, index: match.index });
      i = cursor + 1;
    } else {
      i = resume;
    }
  }
  return out;
};

const firstOperationField = (text: string, start: number, end: number): NamedSite | undefined => {
  for (let i = start; i < end;) {
    while (i < end && /[\s,]/.test(text[i]!)) i++;
    if (text.startsWith("...", i)) {
      i += 3;
      while (i < end && /\s/.test(text[i]!)) i++;
      NAME.lastIndex = i;
      const spread = NAME.exec(text);
      i = spread ? NAME.lastIndex : i + 1;
      if (spread?.[0] !== "on") continue;
      while (i < end && /\s/.test(text[i]!)) i++;
      NAME.lastIndex = i;
      const typeCondition = NAME.exec(text);
      i = typeCondition ? NAME.lastIndex : i;
      while (i < end) {
        while (i < end && /\s/.test(text[i]!)) i++;
        if (text[i] !== "@") break;
        i++;
        NAME.lastIndex = i;
        const directive = NAME.exec(text);
        i = directive ? NAME.lastIndex : i + 1;
        while (i < end && /\s/.test(text[i]!)) i++;
        if (text[i] === "(") {
          let depth = 0;
          do {
            if (text[i] === "(") depth++;
            else if (text[i] === ")") depth--;
            i++;
          } while (i < end && depth > 0);
        }
      }
      if (text[i] === "{") {
        const close = closingBrace(text, i);
        if (close !== undefined && close <= end) {
          const nested = firstOperationField(text, i + 1, close);
          if (nested) return nested;
          i = close + 1;
        }
      }
      continue;
    }
    if (text[i] === "@") {
      i++;
      NAME.lastIndex = i;
      const directive = NAME.exec(text);
      i = directive ? NAME.lastIndex : i + 1;
      if (text[i] === "(") {
        let depth = 0;
        do {
          if (text[i] === "(") depth++;
          else if (text[i] === ")") depth--;
          i++;
        } while (i < end && depth > 0);
      }
      continue;
    }
    NAME.lastIndex = i;
    const match = NAME.exec(text);
    if (!match) {
      i++;
      continue;
    }
    let name = match[0];
    let index = match.index;
    let cursor = NAME.lastIndex;
    while (cursor < end && /\s/.test(text[cursor]!)) cursor++;
    if (text[cursor] === ":") {
      cursor++;
      while (cursor < end && /\s/.test(text[cursor]!)) cursor++;
      NAME.lastIndex = cursor;
      const target = NAME.exec(text);
      if (!target) return undefined;
      name = target[0];
      index = target.index;
    }
    return { name, index };
  }
  return undefined;
};

const GRAPHQL_BUILTINS = new Set(["String", "Int", "Float", "Boolean", "ID"]);

const graphqlAnchors = (file: string, source: string): AnchorDraft[] => {
  const masked = maskSyntax(source, true);
  const lineOf = lineLookup(source);
  const roots = new Map<string, "QUERY" | "MUTATION" | "SUBSCRIPTION">([
    ["Query", "QUERY"],
    ["Mutation", "MUTATION"],
    ["Subscription", "SUBSCRIPTION"],
  ]);
  for (const schema of declarationBlocks(masked, /\bschema\b/g)) {
    const body = masked.slice(schema.open + 1, schema.close);
    for (const mapping of body.matchAll(/\b(query|mutation|subscription)\s*:\s*([_A-Za-z]\w*)/g)) {
      roots.set(mapping[2]!, mapping[1]!.toUpperCase() as "QUERY" | "MUTATION" | "SUBSCRIPTION");
    }
  }

  const out: AnchorDraft[] = [];
  const addType = (name: string, index: number, ruleId: string): void => {
    if (GRAPHQL_BUILTINS.has(name)) return;
    out.push(anchor(file, lineOf(index), `GRAPHQL TYPE ${name}`, "graphql-type", ruleId));
  };

  for (const declaration of masked.matchAll(/\b(?:extend\s+)?(type|interface|input|enum|scalar|union)\s+([_A-Za-z]\w*)/g)) {
    addType(declaration[2]!, declaration.index!, `graphql-${declaration[1]!}-declaration`);
  }

  // Union member references: `union U = A | B` binds A and B to the hub.
  // Members span until the next declaration or block so multi-line unions
  // still resolve; masked text keeps comments out of the name set.
  for (const union of masked.matchAll(/\b(?:extend\s+)?union\s+([_A-Za-z]\w*)/g)) {
    const unionEnd = union.index + union[0].length;
    const boundary = /(?:[\n\r]\s*(?:(?:extend\s+)?(?:type|interface|input|enum|scalar|union|schema|directive)\b|(?:query|mutation|subscription|fragment)\b)|[{])/.exec(masked.slice(unionEnd));
    const regionEnd = boundary ? unionEnd + boundary.index : masked.length;
    for (const member of masked.slice(unionEnd, regionEnd).matchAll(/[_A-Za-z]\w*/g)) {
      addType(member[0], unionEnd + member.index!, "graphql-union-member");
    }
  }

  for (const type of declarationBlocks(masked, /\b(?:extend\s+)?(?:type|interface|input)\s+([_A-Za-z]\w*)/g)) {
    const operation = roots.get(type.match[1]!);
    if (operation) {
      for (const field of graphqlFields(masked, type.open + 1, type.close)) {
        out.push(anchor(file, lineOf(field.index), `GRAPHQL ${operation} ${field.name}`, "graphql", "graphql-root-field"));
      }
    }
    const header = masked.slice(type.match.index, type.open);
    const implementsMatch = /implements\s+([_A-Za-z][\w\s&|,]*)/.exec(header);
    if (implementsMatch) {
      const base = type.match.index + implementsMatch.index + implementsMatch[0].indexOf(implementsMatch[1]!);
      for (const reference of implementsMatch[1]!.matchAll(/[_A-Za-z]\w*/g)) {
        addType(reference[0], base + reference.index!, "graphql-implements-type");
      }
    }
    const bodyOffset = type.open + 1;
    const body = masked.slice(bodyOffset, type.close);
    for (const reference of body.matchAll(/:\s*[!\[\]\s]*([_A-Za-z]\w*)/g)) {
      addType(reference[1]!, bodyOffset + reference.index!, "graphql-field-type");
    }
  }

  const operationPattern = /(?:^|[\n\r])\s*(query|mutation|subscription)\b(?:\s+([_A-Za-z]\w*))?/g;
  for (const operation of declarationBlocks(masked, operationPattern)) {
    const operationKind = operation.match[1]!.toUpperCase() as "QUERY" | "MUTATION" | "SUBSCRIPTION";
    const operationName = operation.match[2];
    const operationIndex = operation.match.index + operation.match[0].indexOf(operation.match[1]!);
    if (operationName) {
      out.push(anchor(file, lineOf(operationIndex), `GRAPHQL OPERATION ${operationKind} ${operationName}`, "graphql-operation", "graphql-operation-declaration"));
    }
    const rootType = [...roots].find(([, kind]) => kind === operationKind)?.[0];
    if (rootType) addType(rootType, operationIndex, "graphql-operation-root");
    const header = masked.slice(operationIndex, operation.open);
    for (const reference of header.matchAll(/\$[_A-Za-z]\w*\s*:\s*[!\[\]\s]*([_A-Za-z]\w*)/g)) {
      addType(reference[1]!, operationIndex + reference.index!, "graphql-variable-type");
    }
    const bodyOffset = operation.open + 1;
    const body = masked.slice(bodyOffset, operation.close);
    for (const inline of body.matchAll(/\.\.\.\s+on\s+([_A-Za-z]\w*)/g)) {
      addType(inline[1]!, bodyOffset + inline.index!, "graphql-inline-fragment-type");
    }
    const field = firstOperationField(masked, bodyOffset, operation.close);
    if (field) {
      out.push(anchor(file, lineOf(field.index), `GRAPHQL ${operationKind} ${field.name}`, "graphql", "graphql-operation"));
    }
  }

  const fragmentPattern = /(?:^|[\n\r])\s*fragment\s+([_A-Za-z]\w*)\s+on\s+([_A-Za-z]\w*)/g;
  for (const fragment of declarationBlocks(masked, fragmentPattern)) {
    const fragmentIndex = fragment.match.index + fragment.match[0].indexOf("fragment");
    out.push(anchor(file, lineOf(fragmentIndex), `GRAPHQL FRAGMENT ${fragment.match[1]!}`, "graphql-fragment", "graphql-fragment-declaration"));
    addType(fragment.match[2]!, fragmentIndex, "graphql-fragment-type");
  }
  return out;
};
export const extractProtocolAnchors = async (
  files: readonly string[],
  source: FileSource,
): Promise<AnchorDraft[]> => {
  const protocolFiles = files.filter((file) => PROTOCOL_EXTENSIONS.has(extname(file).toLowerCase()));
  const texts = await readAll(protocolFiles, source);
  const out: AnchorDraft[] = [];
  for (const file of [...protocolFiles].sort()) {
    const text = texts.get(file);
    if (text === undefined) continue;
    if (file.endsWith(".proto")) out.push(...protoAnchors(file, text));
    else out.push(...graphqlAnchors(file, text));
  }
  out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id) || (a.ruleId ?? "").localeCompare(b.ruleId ?? ""));
  const seen = new Set<string>();
  return out.filter((item) => {
    const key = `${item.id}|${item.file}|${item.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
