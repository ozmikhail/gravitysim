import { plumbBoundaryRules } from "./rules/boundaries.mjs";
import { plumbCallRules } from "./rules/calls.mjs";
import { plumbCommentRules } from "./rules/comments.mjs";
import { plumbLayoutRules } from "./rules/layout.mjs";
import { plumbNameRules } from "./rules/names.mjs";
import { plumbValueRules } from "./rules/values.mjs";

export const plumbTypescriptRules = {
  ...plumbBoundaryRules,
  ...plumbCallRules,
  ...plumbCommentRules,
  ...plumbLayoutRules,
  ...plumbNameRules,
  ...plumbValueRules,
};
