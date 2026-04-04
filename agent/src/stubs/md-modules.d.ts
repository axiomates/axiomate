// Allow importing .md files as string content.
// In claude-code these are inlined by bun:bundle at build time.
declare module '*.md' {
  const content: string
  export default content
}
