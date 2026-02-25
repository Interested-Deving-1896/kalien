/**
 * Load env vars from the fallback chain, later entries take precedence:
 *   .env (root)  →  .dev.vars (root)  →  scripts/.env
 *
 * Use this instead of manually parsing individual files so scripts work
 * regardless of which file the user keeps their secrets in.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return vars;
}

export const env: Record<string, string> = {
  ...parseEnvFile(resolve(root, ".env")),
  ...parseEnvFile(resolve(root, ".dev.vars")),
  ...parseEnvFile(resolve(import.meta.dirname, ".env")),
};
