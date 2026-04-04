// Stub for bun:bundle — not available outside Bun's bundler.
// In claude-code, `feature()` is a compile-time feature flag that Bun resolves
// to true/false at bundle time. At runtime in Node we always return false
// (feature not available), so gated code paths are skipped.
// `MACRO` holds build-time constants injected by Bun's define plugin.
declare module 'bun:bundle' {
  /** Compile-time feature flag — always false outside Bun bundler */
  export function feature(name: string): boolean

  const content: string
  export default content
}

/** Bun global — only available in Bun runtime, checked via typeof */
declare const Bun:
  | {
      hash(input: string, seed?: bigint | number): bigint
      gc(force?: boolean): void
      version: string
      semver: {
        satisfies(version: string, range: string): boolean
        order(a: string, b: string): number
        [key: string]: any
      }
      stringWidth(input: string, options?: any): number
      wrapAnsi(input: string, columns: number, options?: any): string
      embeddedFiles: any[]
      spawn(args: any, options?: any): any
      listen(options: any): any
      which(name: string): string | null
      YAML: { parse(input: string): any; stringify(value: any): string; [key: string]: any }
      JSONL: { parse(input: string): any[]; stringify(values: any[]): string; [key: string]: any }
      indexOfFirstDifference(a: string, b: string): number
      generateHeapSnapshot(): any
    }
  | undefined

/** Compile-time build constants injected by Bun's define plugin */
declare const MACRO: {
  VERSION: string
  BUILD_TIME: string
  PACKAGE_URL: string
  NATIVE_PACKAGE_URL: string
  FEEDBACK_CHANNEL: string
  ISSUES_EXPLAINER: string
  VERSION_CHANGELOG: string
}
