import { readFileSync } from "node:fs";
import { posix } from "node:path";

import { isWithin, safePath } from "./files.mjs";

// one comment standard for every language: the eslint rule and the text engine both read it

const COMMENT_CHARS_MAX = 100;

const DIRECTIVES =
  /^(?:eslint(?:\s|[-/])|globals?\b|exported\b|(?:istanbul|c8|v8)\s+ignore\b|prettier-ignore\b|@(?:ts-|jsx|license|preserve)|[#@]\s*source(?:Mapping)?URL=|[#@]__PURE__|\/\s*<reference\b|rubocop:|NOLINT|clang-format\s+(?:on|off)|frozen_string_literal:|-\*-|syntax=|escape=)/; // tool directives speak to a tool, not a reader

const DECORATION = /^[-=*_~#\s]{3,}$|^[-=*_~#]{3,}\s*\S[^\n]*[-=*_~#]{3,}$/; // a rule of dashes, or a title fenced by them

const CAPITAL = /^(?:A|[A-Z][a-z]+)[,.:;]?$/; // a sentence's first word; an acronym or an identifier reads as itself

const CODE = {
  script:
    /^(?:(?:export\s+)?(?:const|let|var)\s+[$\w]+(?:\s*:\s*[^=]+)?\s*=\s*\S[\s\S]*|(?:return|throw|await)\s+\S[^\n]*);$/,
  sql: /^(?:SELECT\b[\s\S]+\bFROM\b|INSERT\s+INTO\b|DELETE\s+FROM\b|UPDATE\s+\S+\s+SET\b|(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TYPE|FUNCTION|POLICY)\b)[\s\S]*;$/i,
  prisma:
    /^\w+\s+(?:String|Int|Float|Boolean|DateTime|Json|Bytes|Decimal)(?:\?|\[\])?(?:\s+@[^\n]+)?$/,
  jsonc: /^"(?:\\.|[^"\\])+"\s*:\s*[^\n]+[,}]$/,
  css: /^(?:--)?[a-z][a-z0-9-]*\s*:\s*[^;{}]+;$|^[^{}]+\{[^{}]*\}$/,
  ruby: /^(?:def\s+\w+|end|(?:puts|require|return|raise)\s+\S[^\n]*|[a-z_]\w*\s*=\s*\S[^\n]*)$/,
  cpp: /^(?:(?:return|throw)\s+\S[^\n]*|(?:auto|int|bool|char|double|float|void|std::\w+(?:<[^>]*>)?)\s+[\w:*&]+\s*(?:=|\()[^\n]*)[;{]$/,
}; // a comment that is code, which the history keeps better than a comment does

export const commentMessages = {
  empty: "Remove empty comments; use a blank line for separation.",
  decoration: "Remove decorative comment separators; use a plain explanation when needed.",
  code: "Remove commented-out code; label intentional examples with Example: or @example.",
  spacing: "Separate the comment delimiter from its text with a space.",
  capital: "A comment starts lowercase unless its first word is an acronym or an identifier.",
  long: `A comment line is at most ${COMMENT_CHARS_MAX} characters.`,
};

const normalize = (value) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*(?:\s|$)/, ""))
    .join("\n")
    .trim();

export const commentIsDirective = (value) => DIRECTIVES.test(normalize(value));

const BLOCK_ONLY = /^(?:eslint\s|globals?\b|exported\b)/; // eslint reads these only from a block comment

const isDirective = (text, language) =>
  DIRECTIVES.test(text) && !(language === "script" && BLOCK_ONLY.test(text));

// value: the comment text after its delimiter, exactly as written; language picks the code shapes
// a script comment that reaches here is a line comment, since a block one is refused first
export const commentProblems = (value, language = "script") => {
  const text = normalize(value);
  if (isDirective(text, language)) {
    return [];
  }
  if (!text) {
    return ["empty"];
  }
  if (DECORATION.test(text)) {
    return ["decoration"];
  }
  if (/```|@example\b|^Example:/.test(text)) {
    return [];
  }
  if (CODE[language]?.test(text) || (language !== "script" && CODE.script.test(text))) {
    return ["code"];
  }
  const problems = [];
  if (value && !/^[\s*!/#@]/.test(value)) {
    problems.push("spacing");
  }
  if (CAPITAL.test(text.split(/\s+/)[0] ?? "")) {
    problems.push("capital");
  }
  if (value.split(/\r?\n/).some((line) => line.trim().length > COMMENT_CHARS_MAX)) {
    problems.push("long");
  }
  return problems;
};

export const RULES = [
  ...Object.entries(commentMessages).map(([id, description]) => ({ id: `comments.${id}`, description, remedy: description })),
  { id: "comments.block", description: "Non-CSS/SQL block comments are reserved for tool directives.", remedy: "Write a line comment." },
  { id: "comments.directive", description: "Source comments cannot disable native checks or formatting.", remedy: "Remove the suppression and resolve the tool's finding; policy changes require review.", suppressible: false },
  { id: "comments.syntax", description: "The comment scanner must understand the selected syntax.", remedy: "Use the documented syntax subset or extend the language adapter.", suppressible: false },
];
const SUPPRESSION = /\b(?:NOLINT(?:NEXTLINE|BEGIN|END)?\b|rubocop:\s*(?:(?:disable|todo)\b|push\b[^\r\n]*\s-[A-Za-z])|clang-format\s+off\b|shellcheck\s+disable\s*=|shfmt:?\s+(?:off|skip|ignore)\b|prettier-ignore(?:\b|-))/i;

export function commentsLanguageOf(path) {
  const name = posix.basename(path);
  const extension = posix.extname(path);
  if ([".prisma", ".sql", ".jsonc", ".css"].includes(extension)) return extension.slice(1);
  if ([".yml", ".yaml"].includes(extension) || [".clang-format", ".clang-tidy"].includes(name)) return "yaml";
  if (/^\.env(?:\.(?:schema|example))?$/.test(name)) return "env";
  if (name === "Dockerfile" || name.endsWith(".dockerfile")) return "docker";
  if (extension === ".sh") return "shell";
  if ([".rb", ".rake", ".gemspec"].includes(extension) || ["Gemfile", "Rakefile"].includes(name)) return "ruby";
  if ([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"].includes(extension)) return "cpp";
  return undefined; // JavaScript comments are checked from its parser's tokens in the optional pack.
}

function slashComments(original, language) {
  const found = [];
  const issues = [];
  // C/C++ line splicing happens before tokenization; retain original source positions.
  const positions = [];
  let source = "";
  for (let at = 0; at < original.length; at++) {
    const splice = language === "cpp" && /^\\\r?\n/.exec(original.slice(at));
    if (splice) at += splice[0].length - 1;
    else { positions.push(at); source += original[at]; }
  }
  const issue = (index, message) => issues.push({ index: positions[index] ?? original.length, message });
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const raw = language === "cpp" && /^(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(/.exec(source.slice(index));
    if (raw) {
      const end = source.indexOf(`)${raw[1]}"`, index + raw[0].length);
      if (end < 0) { issue(index, "A C++ raw string is not closed."); break; }
      index = end + raw[1].length + 1;
      continue;
    }
    const dollar = language === "sql" && /^\$(?:[A-Za-z_]\w*)?\$/.exec(source.slice(index));
    if (dollar) {
      const end = source.indexOf(dollar[0], index + dollar[0].length);
      if (end < 0) { issue(index, "A SQL dollar-quoted string is not closed."); break; }
      index = end + dollar[0].length - 1;
      continue;
    }
    if (language === "css" && /^url\(/i.test(source.slice(index))) {
      let end = index + 4;
      let quote;
      for (; end < source.length; end++) {
        if (source[end] === "\\") end++;
        else if (quote) { if (source[end] === quote) quote = undefined; }
        else if (["'", '"'].includes(source[end])) quote = source[end];
        else if (source[end] === ")") break;
      }
      if (end === source.length) { issue(index, "A CSS url() token is not closed."); break; }
      index = end;
      continue;
    }
    const separator = language === "cpp" && char === "'" && /[\da-f]/i.test(source[index + 1] ?? "") && /\b(?:0[xX][\da-fA-F']*|0[bB][01']*|\d[\w.']*)$/.test(source.slice(0, index));
    if (separator) continue;
    if (char === '"' || (char === "'" && ["cpp", "css", "sql"].includes(language))) {
      let end = index + 1;
      for (; end < source.length; end++) {
        if (source[end] === "\\" && (language !== "sql" || /(?:^|\W)[eE]$/.test(source.slice(0, index)))) end++;
        else if (source[end] === char) {
          if (language === "sql" && source[end + 1] === char) end++;
          else break;
        }
      }
      if (end >= source.length) { issue(index, "A quoted string is not closed."); break; }
      index = end;
      continue;
    }
    const line = language === "sql" ? "--" : "//";
    if (language !== "css" && source.startsWith(line, index)) {
      const delimiter = language === "prisma" && source[index + 2] === "/" ? 3 : 2;
      const end = source.indexOf("\n", index);
      found.push({ index: positions[index], text: source.slice(index + delimiter, end < 0 ? source.length : end), block: false });
      index = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", index)) {
      const start = index;
      let depth = 1;
      index += 2;
      for (; index < source.length && depth; index++) {
        if (language === "sql" && source.startsWith("/*", index)) { depth++; index++; }
        else if (source.startsWith("*/", index)) { depth--; index++; }
      }
      if (depth) { issue(start, "A block comment is not closed."); break; }
      found.push({ index: positions[start], text: source.slice(start + 2, index - 2), block: true });
      index--;
    }
  }
  return { found, issues };
}

function hashComments(source, language) {
  const found = [];
  const issues = [];
  let quote;
  let quotedAt = 0;
  let blockIndent;
  let rubyBlock;
  let literal;
  let offset = 0;
  const heredocs = [];
  const issue = (index, message) => issues.push({ index, message });
  const rubyInterpolation = (line, index) => {
    const end = line.indexOf("}", index + 2);
    if (end < 0 || /[{}#]/.test(line.slice(index + 2, end))) { issue(offset + index, "Complex or multiline Ruby interpolation needs a parser-backed comment adapter."); return -1; }
    return end;
  };
  const shellSubstitution = (line, index) => {
    const end = line.indexOf(")", index + 2);
    if (end < 0 || /[#()]/.test(line.slice(index + 2, end))) { issue(offset + index, "Nested or multiline shell command substitution needs a parser-backed comment adapter."); return -1; }
    return end;
  };
  for (const line of source.split("\n")) {
    if (heredocs.length) {
      const doc = heredocs[0];
      const content = doc.indent === "any" ? line.trimStart() : doc.indent === "tabs" ? line.replace(/^\t+/, "") : line;
      if (content.replace(/\r$/, "") === doc.word) heredocs.shift();
      else if (doc.interpolates) {
        for (let index = 0; index < line.length; index++) {
          if (line[index] === "\\") index++;
          else if (language === "ruby" && line.startsWith("#{", index)) {
            index = rubyInterpolation(line, index);
            if (index < 0) return { found, issues };
          } else if (language === "shell" && line.startsWith("$(", index)) {
            index = shellSubstitution(line, index);
            if (index < 0) return { found, issues };
          } else if (language === "shell" && line[index] === "`") {
            issue(offset + index, "Shell heredoc backtick substitution needs a parser-backed comment adapter."); return { found, issues };
          }
        }
      }
      offset += line.length + 1;
      continue;
    }
    if (language === "ruby" && !quote && !literal && (rubyBlock !== undefined || /^=begin(?:\s|$)/.test(line))) {
      rubyBlock ??= offset;
      if (/^=end(?:\s|$)/.test(line)) { found.push({ index: rubyBlock, text: source.slice(rubyBlock + 6, offset), block: true }); rubyBlock = undefined; }
      offset += line.length + 1;
      continue;
    }
    const indentation = line.length - line.trimStart().length;
    if (blockIndent !== undefined) {
      if (!line.trim() || indentation > blockIndent) { offset += line.length + 1; continue; }
      blockIndent = undefined;
    }
    let content = line;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (literal) {
        if (char === "\\") index++;
        else if (literal.interpolates && line.startsWith("#{", index)) {
          index = rubyInterpolation(line, index);
          if (index < 0) return { found, issues };
        }
        else if (literal.regexp && char === "[") literal.characterClass = true;
        else if (literal.regexp && char === "]") literal.characterClass = false;
        else if (literal.characterClass) continue;
        else if (literal.open !== literal.close && char === literal.open) literal.depth++;
        else if (char === literal.close && --literal.depth === 0) literal = undefined;
        continue;
      }
      if (quote) {
        if (char === "\\" && (quote !== "'" || language === "ruby") && !(language === "yaml" && quote === "'")) index++;
        else if (char === quote) {
          if (language === "yaml" && quote === "'" && line[index + 1] === "'") index++;
          else quote = undefined;
        } else if (language === "ruby" && quote !== "'" && line.startsWith("#{", index)) {
          index = rubyInterpolation(line, index);
          if (index < 0) return { found, issues };
        } else if (language === "shell" && quote === '"' && line.startsWith("$(", index)) {
          index = shellSubstitution(line, index);
          if (index < 0) return { found, issues };
        } else if (language === "shell" && quote === "`" && char === "#" && (index === 0 || /[\s;|&()]/.test(line[index - 1]))) {
          issue(offset + index, "A comment inside shell backtick substitution needs a parser-backed comment adapter."); return { found, issues };
        }
        continue;
      }
      if (language === "shell" && char === "\\") { index++; continue; }
      if (language === "ruby" && char === "?" && /["'`#\\]/.test(line[index + 1] ?? "")) {
        issue(offset + index, "Ruby character literals or compact ternaries need a parser-backed comment adapter."); return { found, issues };
      }
      if (language === "ruby" && char === "%" && line[index + 1] !== "=") {
        const token = /^%([qQwWiIrxs]?)([^\w\s])/.exec(line.slice(index));
        if (token) {
          const open = token[2];
          literal = { open, close: { "(": ")", "[": "]", "{": "}", "<": ">" }[open] ?? open, depth: 1, at: offset + index, interpolates: !["q", "w", "i", "s"].includes(token[1]) };
          index += token[0].length - 1;
          continue;
        }
      }
      if (language === "ruby" && char === "/") {
        const before = line.slice(0, index).trimEnd();
        if (!before || /(?:[=(,:\[!~]|\b(?:if|unless|when|return))$/.test(before)) literal = { open: "/", close: "/", depth: 1, at: offset + index, regexp: true, interpolates: true };
        else if (line.slice(index + 1).includes("#") && /[^\\]\//.test(line.slice(index + 1))) { issue(offset + index, "An ambiguous Ruby regexp/division expression needs a parser-backed comment adapter."); return { found, issues }; }
        continue;
      }
      if ((char === '"' || char === "'" || (["shell", "ruby"].includes(language) && char === "`")) && (language !== "yaml" || !line.slice(0, index).trim() || /[:[{,\-]$/.test(line.slice(0, index).trimEnd()))) {
        quote = char; quotedAt = offset + index;
      } else if (["shell", "docker", "ruby"].includes(language) && line.startsWith("<<", index) && line[index + 2] !== "<") {
        const token = (language === "ruby" ? /^<<([-~]?)(['"`]?)([A-Za-z_]\w*)\2/ : /^<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/).exec(line.slice(index));
        if (token) {
          heredocs.push({ word: token[3], indent: token[1] ? (language === "ruby" ? "any" : "tabs") : "none", at: offset + index, interpolates: language === "ruby" ? token[2] !== "'" : !token[2] });
          index += token[0].length - 1;
        }
      } else if (char === "#" && (language === "ruby" || index === 0 || (language === "shell" ? /[\s;|&()]/ : /\s/).test(line[index - 1]))) {
        content = line.slice(0, index);
        if (!(language === "docker" && content.trim()) && !(offset === 0 && index === 0 && line.startsWith("#!"))) {
          const text = line.slice(index + 1);
          if (!(language === "env" && /^\s*[A-Z][A-Z0-9_]*=/.test(text))) found.push({ index: offset + index, text, block: false });
        }
        break;
      }
    }
    if (language === "yaml" && !quote && /(?:^\s*-|:)\s*[|>][+-]?[1-9]?[+-]?\s*$/.test(content)) blockIndent = indentation;
    if (language === "docker") quote = undefined;
    offset += line.length + 1;
  }
  if (quote) issue(quotedAt, "A quoted string is not closed.");
  if (literal) issue(literal.at, "A Ruby percent or regexp literal is not closed.");
  if (rubyBlock !== undefined) issue(rubyBlock, "A Ruby block comment is not closed.");
  if (heredocs.length) issue(heredocs[0].at, "A heredoc is not closed.");
  return { found, issues };
}

export function commentsFind(source, language) {
  const lineOf = (index) => source.slice(0, index).split("\n").length;
  const { found, issues } = ["shell", "yaml", "env", "docker", "ruby"].includes(language) ? hashComments(source, language) : slashComments(source, language);
  return [
    ...found.flatMap(({ index, text, block }) => SUPPRESSION.test(text)
      ? [{ line: lineOf(index), code: "directive", message: "Source comments cannot disable native checks or formatting.", suppressible: false }]
      : block && !["css", "sql"].includes(language) && !commentIsDirective(text)
        ? [{ line: lineOf(index), code: "block", message: "Write a line comment; a block comment is reserved for tool directives." }]
        : commentProblems(text, language).map((code) => ({ line: lineOf(index), code, message: commentMessages[code] }))),
    ...issues.map(({ index, message }) => ({ line: lineOf(index), code: "syntax", message, status: "incomplete", suppressible: false })),
  ];
}

export function checkComments({ root, files, config, read = (path) => readFileSync(safePath(root, path), "utf8") }) {
  const wording = config.preset === "ozlabs";
  return files.flatMap((path) => {
    const language = commentsLanguageOf(path);
    const governed = wording || (config.projects ?? []).some((project) => project.profile === language && ["ruby", "cpp"].includes(language) && isWithin(project.root, path));
    return language && governed ? commentsFind(read(path), language).filter(({ code }) => wording || ["directive", "syntax"].includes(code)).map(({ code, ...finding }) => ({ rule: `comments.${code}`, path, remedy: RULES.find(({ id }) => id === `comments.${code}`).remedy, ...finding })) : [];
  });
}
