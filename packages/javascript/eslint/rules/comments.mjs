import { commentMessages, commentProblems } from "@ozlabs/plumb/comments";

const commentsRule = {
  meta: {
    type: "suggestion",
    fixable: "whitespace",
    schema: [],
    messages: {
      ...commentMessages,
      block: "A script comment is a // line comment; a block comment is reserved for @__PURE__.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === "Shebang") {
            continue;
          }
          if (comment.type === "Block") {
            if (!/^\s*[#@]__PURE__\s*$/.test(comment.value)) {
              context.report({ loc: comment.loc, messageId: "block" });
            }
            continue;
          }
          for (const messageId of commentProblems(comment.value)) {
            context.report({
              loc: comment.loc,
              messageId,
              ...(messageId === "spacing" && {
                fix: (fixer) =>
                  fixer.insertTextAfterRange([comment.range[0], comment.range[0] + 2], " "),
              }),
            });
          }
        }
      },
    };
  },
}; // a comment explains, briefly and in lowercase, why the code is as it is

const DIRECTIVE = {
  Block: /^\s*(?:eslint-(?:disable|enable)|eslint\s+[@\w/-]+\s*:|globals?\s|exported\s)/,
  Line: /^\s*eslint-(?:disable|enable)/, // eslint reads a line comment only as a disable or enable
};

const SUPPRESSION = /(?:^|\n)\s*[*\/]*\s*(?:@ts-(?:ignore|nocheck|expect-error)\b|prettier-ignore\b|(?:istanbul|c8|v8)\s+ignore\b)/i;

const directiveRule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      directive:
        "Record a narrow, reasoned exception in plumb.json; inline tool suppressions cannot change approved policy",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const directive = DIRECTIVE[comment.type]?.test(comment.value) || SUPPRESSION.test(comment.value);
          if (directive) {
            context.report({ loc: comment.loc, messageId: "directive" });
          }
        }
      },
    };
  },
}; // exceptions are checked separately, so a directive cannot turn off its own governance

export const plumbCommentRules = {
  comments: commentsRule,
  directive: directiveRule,
};
