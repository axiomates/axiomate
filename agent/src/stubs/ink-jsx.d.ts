// Stub: declare ink custom JSX intrinsic elements for the agent's
// local ink component copies (Box, Text, Link, RawAnsi, ScrollBox).
// ink-axiomate ships its own jsx.d.ts, but the agent compiles from
// its own src/ tree, so we need these declarations here as well.

import 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': any
      'ink-text': any
      'ink-link': any
      'ink-raw-ansi': any
      'ink-virtual-text': any
    }
  }
}
