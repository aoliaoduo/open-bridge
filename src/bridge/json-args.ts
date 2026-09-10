/**
 * The MCP tool-call argument bag: arguments arrive as untyped JSON-RPC
 * objects, and every handler runtime-narrows each property before use.
 * A single documented `any` at this seam is deliberate; everything else in
 * the codebase stays any-free and fully lint-clean.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate JSON-RPC argument bag; handlers runtime-narrow each property
export type JsonArgs = Record<string, any>;
