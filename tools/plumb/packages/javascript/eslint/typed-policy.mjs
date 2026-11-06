// A fixed release policy: candidate configuration cannot disable typed checks.
export const strictCompilerOptions = Object.freeze({
  strict: true, noCheck: false, noImplicitAny: true, strictNullChecks: true, strictFunctionTypes: true,
  strictBindCallApply: true, strictPropertyInitialization: true, strictBuiltinIteratorReturn: true,
  useUnknownInCatchVariables: true, alwaysStrict: true, allowUnreachableCode: false,
  allowUnusedLabels: false, noImplicitOverride: true, noUnusedLocals: true, noUnusedParameters: true,
  noUncheckedSideEffectImports: true, noFallthroughCasesInSwitch: true, isolatedModules: true,
  verbatimModuleSyntax: true, forceConsistentCasingInFileNames: true,
});

export const typeCheckedRules = Object.freeze({
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false, ignoreIIFE: false, checkThenables: true }],
  "@typescript-eslint/no-misused-promises": ["error", { checksConditionals: true, checksSpreads: true, checksVoidReturn: true }],
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-unsafe-unary-minus": "error",
  "@typescript-eslint/only-throw-error": ["error", { allowRethrowing: false, allowThrowingAny: false, allowThrowingUnknown: false }],
  "@typescript-eslint/prefer-promise-reject-errors": ["error", { allowEmptyReject: false, allowThrowingAny: false, allowThrowingUnknown: false }],
  "@typescript-eslint/return-await": ["error", "always"],
  "@typescript-eslint/switch-exhaustiveness-check": ["error", { allowDefaultCaseForExhaustiveSwitch: false, considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: false }],
  "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
});

export const typeInformationRule = {
  meta: { type: "problem", schema: [], messages: { unresolved: "This source needs a trusted TypeScript Program containing these exact bytes; syntax-only linting cannot complete its typed checks." } },
  create(context) {
    return { Program(node) {
      const services = context.sourceCode.parserServices, program = services?.program;
      const source = program?.getSourceFile(context.filename);
      if (!program || !context.settings?.plumbTrustedPrograms?.includes(program) || !services.esTreeNodeToTSNodeMap || !source || source.text.replace(/^\uFEFF/, "") !== context.sourceCode.text.replace(/^\uFEFF/, "")) context.report({ node, messageId: "unresolved" });
    } };
  },
};
