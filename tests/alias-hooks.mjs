/**
 * Resolves the `@/…` alias for the Node test runner.
 *
 * Next understands it from tsconfig; plain Node does not, and the modules
 * under test import each other that way. Without this the tests could only
 * reach files that happen to have no internal imports, which is the opposite
 * of the files worth testing.
 */
import { pathToFileURL } from "node:url";

const ROOT = pathToFileURL(`${process.cwd()}/src/`).href;

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Next resolves extensionless TS imports; Node needs the extension spelled out. */
function withExtension(href) {
  if (/\.[a-z]+$/i.test(href)) return href;
  for (const extension of [".ts", ".tsx", ".mts", ".js"]) {
    if (existsSync(fileURLToPath(href + extension))) return href + extension;
  }
  return href;
}

export function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    return next(withExtension(new URL(specifier.slice(2), ROOT).href), context);
  }
  return next(specifier, context);
}
