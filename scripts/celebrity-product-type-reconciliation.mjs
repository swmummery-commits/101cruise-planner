#!/usr/bin/env node
/**
 * Delegates to CommonJS reconciliation runner (avoids ESM circular require issues).
 */
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const cjs = path.join(path.dirname(fileURLToPath(import.meta.url)), "celebrity-product-type-reconciliation.cjs");
const result = spawnSync(process.execPath, [cjs, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
