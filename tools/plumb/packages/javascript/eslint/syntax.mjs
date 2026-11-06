import { globMatches } from "../shared/glob.mjs";
import { rulesRelativeTo } from "./rules/shared.mjs";

export const syntaxSelectors = ({ root, source, profile, logCalls, errorFactory, syntax = [] }, filename) => {
  const file = rulesRelativeTo(root, filename);
  const selectors = [
    {
      selector: "CatchClause:not(CatchClause CatchClause) > Identifier.param[name!='error']",
      message: "Catch as catch (error), or catch { when the error is not read.",
    },
    {
      selector: "CatchClause > Identifier.param[typeAnnotation]",
      message: "Catch as catch (error), or catch { when the error is not read.",
    },
  ];
  if (logCalls) {
    for (const kind of ["TemplateLiteral", "BinaryExpression"]) selectors.push({
      selector: `CallExpression[callee.name=/${logCalls.replaceAll("/", "\\/")}/] > ${kind}.arguments:first-child`,
      message: "A log message is a fixed string; its values ride in the fields.",
    });
  }
  if (errorFactory && !globMatches(errorFactory.allowIn ?? [], file)) selectors.push({
    selector: "NewExpression[callee.name='Error']",
    message: errorFactory.message,
  });
  if (profile === "react" && globMatches(source, file)) selectors.push({
    selector: "AwaitExpression:not(:function AwaitExpression)",
    message: "Await inside a function: a top-level await holds the entry chunk.",
  });
  for (const row of syntax) {
    if (!row.files || globMatches(row.files, file)) selectors.push(...row.selectors);
  }
  return selectors;
};

// selectors share one rule instance, so overlapping scopes add restrictions rather than replace them
export const syntaxRule = {
  meta: {
    type: "problem",
    schema: [{ type: "object" }],
    messages: { restricted: "{{message}}" },
  },
  create(context) {
    const visitors = {};
    for (const { selector, message } of syntaxSelectors(context.options[0], context.filename)) {
      const previous = visitors[selector];
      visitors[selector] = (node) => {
        previous?.(node);
        context.report({ node, messageId: "restricted", data: { message } });
      };
    }
    return visitors;
  },
};
