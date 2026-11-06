import { writeFileSync } from "node:fs";
import { schema } from "../src/config.mjs";

writeFileSync(new URL("../plumb.schema.json", import.meta.url), `${JSON.stringify(schema, null, 2)}\n`);
