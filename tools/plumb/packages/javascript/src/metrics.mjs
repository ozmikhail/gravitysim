import ts from "typescript";
import { planConventions } from "@ozlabs/plumb/conventions";
import { canonical, digest } from "@ozlabs/plumb/files";

import { Analysis, AnalysisError, isScript, walk } from "./analysis.mjs";

export const RULES = [
  ["conventions.budget", "Role implementations stay within explicit function size, parameter and nesting limits."],
  ["conventions.duplication", "Token-identical statement blocks stay within their role's explicit copy budget."],
].map(([id, description]) => ({ id, description, remedy: "Simplify the implementation or reuse the shared behavior; review budget changes separately.", suppressible: true }));

const functionLike = (node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
const branch = (node) => ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isTryStatement(node) || ts.isConditionalExpression(node);

function nesting(body) {
  let maximum = 0;
  const visit = (node, depth) => {
    if (functionLike(node)) return;
    const next = depth + (branch(node) ? 1 : 0);
    maximum = Math.max(maximum, next);
    node.forEachChild((child) => { visit(child, next); });
  };
  visit(body, 0); return maximum;
}

// AST token leaves preserve literal/identifier spelling, including regex and template content.
// Trivia and positions are absent; this deliberately does not infer semantic near-duplicates.
function fingerprint(node, source) {
  const tokens = [];
  const visit = (child) => {
    if (child.kind >= ts.SyntaxKind.FirstJSDocNode && child.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = child.getChildren(source);
    if (children.length) for (const entry of children) visit(entry);
    else if (child.kind <= ts.SyntaxKind.LastToken) tokens.push([child.kind, child.getText(source)]);
  };
  visit(node); return digest(canonical(tokens));
}

export function checkMetrics(context, shared, suppliedPlan) {
  const analysis = shared ?? new Analysis(context), plan = suppliedPlan ?? planConventions(context), diagnostics = [];
  if (!context.config.conventions || plan.diagnostics.length) return diagnostics;
  for (const role of context.config.conventions.roles) {
    const budgets = role.javascript?.budgets;
    if (!budgets) continue;
    const copies = new Map(), files = plan.roles.find((entry) => entry.id === role.id)?.files ?? [];
    for (const file of files) {
      try {
        if (!isScript(file)) throw new AnalysisError(file, `Role ${role.id} declares JavaScript budgets for an unsupported source language.`);
        const source = analysis.source(file);
        walk(source, (node) => {
          if (functionLike(node) && node.body) {
            const start = source.getLineAndCharacterOfPosition(node.body.getStart(source)).line;
            const end = source.getLineAndCharacterOfPosition(Math.max(node.body.getStart(source), node.body.end - 1)).line;
            const actual = { functionLines: end - start + 1, maxParameters: node.parameters.length, maxNesting: nesting(node.body) };
            for (const [metric, count] of Object.entries(actual)) if (budgets[metric] !== undefined && count > budgets[metric]) diagnostics.push(analysis.issue("conventions.budget", file, `Role ${role.id}: ${metric} is ${count}; allowed maximum is ${budgets[metric]}.`, "Reduce this function's size, parameter count or control-flow nesting.", node));
          }
          if (budgets.duplicateBlocks && ts.isBlock(node) && node.statements.length >= budgets.duplicateBlocks.minStatements) {
            const hash = fingerprint(node, source), group = copies.get(hash) ?? [];
            group.push({ file, node }); copies.set(hash, group);
          }
        });
      } catch (error) {
        diagnostics.push({ rule: "conventions.analysis", path: error instanceof AnalysisError ? error.path : file, message: `Role ${role.id} budgets: ${error.message}`, remedy: "Restore readable, parsable inputs for every selected budget scope.", status: "incomplete", suppressible: false });
      }
    }
    for (const group of copies.values()) {
      if (group.length <= budgets.duplicateBlocks.maxCopies) continue;
      const [{ file, node }] = group;
      const locations = group.map((entry) => ({ path: entry.file, line: entry.node.getSourceFile().getLineAndCharacterOfPosition(entry.node.getStart()).line + 1 }));
      diagnostics.push({ ...analysis.issue("conventions.duplication", file, `Role ${role.id}: ${group.length} token-identical blocks exceed the ${budgets.duplicateBlocks.maxCopies}-copy limit.`, "Extract the shared behavior or use an explicit, bounded exception for intentional duplication.", node), relatedLocations: locations });
    }
  }
  return diagnostics;
}
