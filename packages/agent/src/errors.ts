/**
 * Narrow entry point for runtime helpers that plugins may need.
 *
 * Importing them from the package root would pull the whole agent — including
 * the SQLite session store — into a plugin bundle, which is both wasteful and
 * fragile: the store imports a Node builtin that older 22.x releases gate
 * behind a flag. Plugins are bundled standalone, so they import from here.
 */
export { ModelRequestError, modelHttpError, modelNetworkError } from "./retry.js";
export { SessionGuardError, isSessionGuardError } from "./types.js";
