// Stub for bun:bundle — resolved at bundle time by Bun's bundler.
declare module 'bun:bundle' {
  export function feature(name: string): boolean
  const content: string
  export default content
}

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
      spawnSync(args: any, options?: any): any
      listen(options: any): any
      which(name: string): string | null
      YAML: { parse(input: string): any; stringify(value: any): string; [key: string]: any }
      JSONL: { parse(input: string): any[]; stringify(values: any[]): string; [key: string]: any }
      indexOfFirstDifference(a: string, b: string): number
      generateHeapSnapshot(): any
    }
  | undefined

declare const MACRO: {
  VERSION: string
  BUILD_TIME: string
  PACKAGE_URL: string
  NATIVE_PACKAGE_URL: string
  FEEDBACK_CHANNEL: string
  ISSUES_EXPLAINER: string
  VERSION_CHANGELOG: string
}
