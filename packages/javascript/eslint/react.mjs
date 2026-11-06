import { plumbClassRules } from "./react/classes.mjs";
import { plumbComponentRules } from "./react/components.mjs";

export const plumbReactRules = { ...plumbClassRules, ...plumbComponentRules };
