// Minimal type stub for Bun's FFI module — not available on npm and not part of
// @types/node. browser-bridge-axiomate is an independent workspace package, so
// it carries its own declaration rather than borrowing the agent package's.
//
// Only the surface processJail.ts uses is declared. At runtime this resolves to
// Bun's real module (packaged axiomate is a Bun-compiled exe); under Node/vitest
// the dynamic import throws and processJail falls back to a no-op.
declare module "bun:ffi" {
  export enum FFIType {
    ptr = 12,
    i32 = 5,
    u32 = 6,
  }
  export const ptr: (buf: ArrayBufferView | ArrayBuffer) => number;
  export function dlopen(
    path: string,
    symbols: Record<string, { args: FFIType[]; returns: FFIType }>,
  ): { symbols: Record<string, (...args: unknown[]) => unknown> };
}
