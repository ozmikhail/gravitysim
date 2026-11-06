import { existsSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";

import { globMatches, safePath } from "./files.mjs";

export const RULES = [
  { id: "files.required", description: "Required repository files exist.", remedy: "Add the required file." },
  { id: "files.forbidden", description: "Forbidden file patterns match no repository files.", remedy: "Remove or relocate the forbidden file." },
  { id: "files.names", description: "File and folder names satisfy the effective naming policy.", remedy: "Rename the file or folder and update its references." },
  { id: "files.max-lines", description: "Text files stay within their declared line budget.", remedy: "Split responsibilities into smaller files." },
  { id: "files.scope", description: "Declared file contracts select existing files.", remedy: "Correct the contract's file patterns.", suppressible: false },
  { id: "docs.links", description: "Local Markdown links and heading anchors resolve inside the repository.", remedy: "Update the link or restore its target." },
  { id: "docs.index", description: "A documentation index links every guide beneath its folder.", remedy: "Add the missing guide to the index." },
  { id: "docs.syntax", description: "Documentation can be inspected without hiding an unfinished code block.", remedy: "Close the fence or HTML comment.", suppressible: false },
];
const entry = (rule, path, message, extra = {}) => ({ rule, path, message, remedy: RULES.find(({ id }) => id === rule)?.remedy ?? "Correct the file contract.", ...extra });

const NAMING = [
  [/\.[cm]?[jt]sx?$/, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.(?:config|d|gen|integration|rules))?(?:\.test)?\.(?:[cm]?[jt]s|[jt]sx)$/, "kebab-case"],
  [/\.css$/, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.module)?\.css$/, "kebab-case"],
  [/\.(?:rb|rake|gemspec)$/, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.(?:rb|rake|gemspec)$/, "snake_case"],
  [/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/, "snake_case"],
];
const entities = (text) => text.replace(/&(?:#(x[\da-f]+|\d+)|(amp|lt|gt|quot|apos|nbsp));/gi, (whole, numeric, name) => {
  if (!numeric) return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[name.toLowerCase()];
  const code = numeric[0].toLowerCase() === "x" ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
});
const unescape = (text) => entities(text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1"));
const label = (text) => unescape(text).trim().replace(/\s+/g, " ").toLowerCase();
const mask = (text) => text.replace(/[^\n]/g, " ");
const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

// This scanner covers ordinary Markdown, reference links, HTML links, and GitHub-style headings.
// Code spans, fenced/indented code, and HTML comments are excluded from link inspection.
function markdown(text) {
  const problems = [];
  let fence;
  let listIndent = 0;
  const visible = text.replace(/<!--[^]*?(?:-->|$)/g, (comment, at) => {
    if (!comment.endsWith("-->")) problems.push({ line: lineOf(text, at), message: "An HTML comment is not closed." });
    return mask(comment);
  }).split(/\r?\n/).map((line, number) => {
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (boundary && boundary[1][0] === fence.char && boundary[1].length >= fence.size && !boundary[2].trim()) fence = undefined;
      return mask(line);
    }
    if (boundary && (boundary[1][0] !== "`" || !boundary[2].includes("`"))) {
      fence = { char: boundary[1][0], size: boundary[1].length, line: number + 1 };
      return mask(line);
    }
    const item = /^\s{0,3}(?:[-+*]|\d+[.)])\s+/.exec(line);
    if (item) listIndent = item[0].length;
    else if (line.trim() && !/^\s/.test(line)) listIndent = 0;
    const indent = line.match(/^ */)[0].length;
    return (line.startsWith("\t") || indent >= listIndent + 4) ? mask(line) : line;
  });
  if (fence) problems.push({ line: fence.line, message: "A fenced code block is not closed." });
  const ids = new Set();
  const addHeading = (heading) => {
    const plain = entities(heading.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/!?\[([^\]]*)\](?:\[[^\]]*\])?/g, "$1").replace(/<[^>]*>/g, "").replace(/[*`~]/g, ""));
    const slug = plain.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").trim().replace(/\s/g, "-");
    let id = slug;
    for (let count = 1; ids.has(id); count++) id = `${slug}-${count}`;
    ids.add(id);
  };
  for (const [number, line] of visible.entries()) {
    const heading = /^ {0,3}#{1,6}(?:[ \t]+(.*)|$)/.exec(line);
    if (heading) addHeading((heading[1] ?? "").replace(/[ \t]+#+[ \t]*$/, ""));
    else if (number && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line) && visible[number - 1].trim()) addHeading(visible[number - 1].trim());
  }
  let body = visible.join("\n");
  // Matching backtick runs may span a line; unmatched runs are ordinary prose.
  body = body.replace(/(`+)([^]*?)\1(?!`)/g, (span, ticks, content, at) => body[at - 1] === "`" || content.startsWith("`") ? span : mask(span));
  const references = new Map();
  const destination = (value) => {
    const match = /^\s*(?:<((?:\\.|[^<>\n])*)>|((?:\\.|[^\s])+))/.exec(value);
    return match ? unescape(match[1] ?? match[2]) : undefined;
  };
  body = body.replace(/^ {0,3}\[([^\]\n]+)\]:[^\n]*$/gm, (definition, key) => {
    const href = destination(definition.slice(definition.indexOf(":") + 1));
    if (href !== undefined && !references.has(label(key))) references.set(label(key), href);
    return mask(definition);
  });
  const links = [];
  for (const tag of body.matchAll(/<([a-z][\w-]*)\b([^<>]*)>/gi)) {
    for (const attribute of tag[2].matchAll(/\b(id|name|href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
      const value = entities(attribute[2] ?? attribute[3] ?? attribute[4]);
      if (["id", "name"].includes(attribute[1].toLowerCase())) ids.add(value);
      else links.push({ href: value, line: lineOf(body, tag.index) });
    }
  }
  for (let at = 0; at < body.length; at++) {
    if (body[at] === "\\") { at++; continue; }
    if (body[at] !== "[") continue;
    let end = at + 1;
    let depth = 1;
    for (; end < body.length && depth; end++) {
      if (body[end] === "\\") end++;
      else if (body[end] === "[") depth++;
      else if (body[end] === "]") depth--;
    }
    if (depth) continue;
    const title = body.slice(at + 1, end - 1);
    let href;
    if (body[end] === "(") {
      let position = end + 1;
      while (/\s/.test(body[position] ?? "") && position < body.length) position++;
      const start = position;
      if (body[position] === "<") {
        position++;
        while (position < body.length && body[position] !== ">" && body[position] !== "\n") { if (body[position] === "\\") position++; position++; }
        if (body[position] !== ">") continue;
        href = unescape(body.slice(start + 1, position++));
      } else {
        depth = 0;
        for (; position < body.length; position++) {
          const char = body[position];
          if (char === "\\") { position++; continue; }
          if (char === "(") depth++;
          else if (char === ")") { if (!depth) break; depth--; }
          else if (/\s/.test(char) && !depth) break;
        }
        if (depth) continue;
        href = unescape(body.slice(start, position));
      }
      while (/\s/.test(body[position] ?? "") && position < body.length) position++;
      if (["'", '"', "("].includes(body[position])) {
        const closing = body[position] === "(" ? ")" : body[position];
        position++;
        while (position < body.length && body[position] !== closing) { if (body[position] === "\\") position++; position++; }
        if (body[position] !== closing) continue;
        position++;
        while (/\s/.test(body[position] ?? "") && position < body.length) position++;
      }
      if (body[position] !== ")") continue;
      end = position + 1;
    } else if (body[end] === "[") {
      const close = body.indexOf("]", end + 1);
      if (close < 0) continue;
      href = references.get(label(body.slice(end + 1, close) || title));
      end = close + 1;
    } else href = references.get(label(title));
    if (href !== undefined) links.push({ href, line: lineOf(body, at) });
    at = end - 1;
  }
  return { ids, links, problems };
}

function checkDocs({ root, files, config, read }) {
  const diagnostics = [];
  const pages = new Set(files.filter((path) => /\.(?:md|markdown)$/i.test(path)));
  if (config.preset === "ozlabs") pages.add("AGENTS.md");
  if (config.docs?.index) pages.add(config.docs.index);
  const documents = new Map();
  const get = (path) => {
    if (!documents.has(path)) documents.set(path, markdown(read(path)));
    return documents.get(path);
  };
  const indexed = new Set();
  for (const path of pages) {
    let document;
    try { document = get(path); }
    catch (error) {
      diagnostics.push(entry("docs.links", path, `Cannot read required documentation: ${error.message}`));
      continue;
    }
    for (const problem of document.problems) diagnostics.push(entry("docs.syntax", path, problem.message, { line: problem.line, status: "incomplete", suppressible: false }));
    for (const { href, line } of document.links) {
      if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) continue;
      try {
        const hash = href.indexOf("#");
        const fragment = hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));
        const location = decodeURIComponent((hash < 0 ? href : href.slice(0, hash)).split("?", 1)[0]);
        if (location.startsWith("/") || location.includes("\\")) throw new Error("link paths must be relative URLs");
        const target = location ? posix.normalize(posix.join(posix.dirname(path), location)) : path;
        const absolute = safePath(root, target);
        if (!existsSync(absolute)) throw new Error("the target does not exist");
        if (fragment && /\.(?:md|markdown)$/i.test(target) && !get(target).ids.has(fragment)) throw new Error(`heading ${fragment} does not exist`);
        if (path === config.docs?.index) indexed.add(target);
      } catch (error) {
        diagnostics.push(entry("docs.links", path, `${href}: ${error.message}`, { line }));
      }
    }
  }
  if (config.docs?.index) {
    const folder = posix.dirname(config.docs.index);
    for (const guide of pages) {
      if (guide !== config.docs.index && (folder === "." || guide.startsWith(`${folder}/`)) && !indexed.has(guide)) diagnostics.push(entry("docs.index", config.docs.index, `Missing guide ${guide}.`));
    }
  }
  return diagnostics;
}

export function checkFiles(context) {
  const { root, files, config } = context;
  const read = context.read ?? ((path) => readFileSync(safePath(root, path), "utf8"));
  const problems = [];
  const required = new Set(config.files?.required ?? []);
  if (config.preset === "ozlabs") required.add("AGENTS.md");
  for (const path of required) {
    try { if (!statSync(safePath(root, path)).isFile()) throw new Error("not a file"); }
    catch { problems.push(entry("files.required", path, "A required repository file is missing or unreadable.")); }
  }
  for (const path of files) {
    if (globMatches(config.files?.forbidden ?? [], path)) problems.push(entry("files.forbidden", path, "This file matches a forbidden repository pattern."));
    if (config.preset === "ozlabs") {
      const rule = NAMING.find(([extension]) => extension.test(path));
      if (rule) {
        const [, pattern, style] = rule;
        if (!pattern.test(posix.basename(path))) problems.push(entry("files.names", path, `Use lowercase ${style} with a supported filename suffix.`));
        const folders = path.split("/").slice(0, -1);
        if (!folders.some((folder) => folder.startsWith("."))) {
          const folderPattern = style === "kebab-case" ? /^[a-z0-9]+(?:-[a-z0-9]+)*$/ : /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
          for (const folder of folders) if (!folderPattern.test(folder)) problems.push(entry("files.names", path, `Rename folder ${folder} in lowercase ${style}.`));
        }
      }
    }
    if (config.files?.maxLines !== undefined) {
      const text = read(path);
      const count = text === "" ? 0 : text.split("\n").length - Number(text.endsWith("\n"));
      if (!text.includes("\0") && count > config.files.maxLines) problems.push(entry("files.max-lines", path, `${count} lines exceeds the limit of ${config.files.maxLines}.`));
    }
  }
  for (const rule of config.files?.names ?? []) {
    const selected = files.filter((path) => globMatches(rule.files, path));
    if (!selected.length) problems.push(entry("files.scope", "plumb.json", `No files match naming contract ${rule.files.join(", ")}.`, { status: "incomplete", suppressible: false }));
    const pattern = new RegExp(rule.pattern);
    for (const path of selected) if (!pattern.test(posix.basename(path))) problems.push(entry("files.names", path, `The filename must match ${rule.pattern}: ${rule.reason}`));
  }
  if (config.preset === "ozlabs" || config.docs !== undefined) problems.push(...checkDocs({ ...context, read }));
  return problems;
}
