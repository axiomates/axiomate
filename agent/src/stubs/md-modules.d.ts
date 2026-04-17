// Allow importing .md files as string content.
// In axiomate these are inlined by bun:bundle at build time.
declare module '*.md' {
  const content: string
  export default content
}
