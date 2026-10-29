/**
 * UNUSED — superseded by explicit `.ts` import extensions.
 *
 * Every compression source file now uses `.ts` extensions on relative imports
 * (both tsconfigs set `allowImportingTsExtensions`), which lets `node --test`
 * import the shipped code directly. That removed the need for a resolver hook.
 *
 * This file is inert; nothing imports it. It could not be deleted in the
 * environment where the change was made, so it is left as a documented stub
 * rather than a silent leftover.
 */
export {}
