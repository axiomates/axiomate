// Stub for React Compiler runtime.
// The React Compiler (formerly React Forget) injects `import { c as _c } from
// "react/compiler-runtime"` into compiled components. The `c()` function is a
// memoization cache constructor. In non-compiled builds we provide a no-op stub.
declare module 'react/compiler-runtime' {
  /**
   * Creates a memoization cache with `size` slots.
   * Returns an opaque cache object used by compiled components.
   */
  export function c(size: number): any
}
