// Bun runtime globals (for Bun fast-path compatibility)
declare const Bun: any

declare module 'bidi-js' {
  interface BidiResult {
    levels: number[]
    paragraphs: Array<{ start: number; end: number; level: number }>
  }
  function bidiFactory(): {
    getEmbeddingLevels(text: string, direction?: 'ltr' | 'rtl' | 'auto'): BidiResult
    getReorderSegments(
      text: string,
      embeddingLevels: BidiResult,
      start?: number,
      end?: number,
    ): Array<[number, number]>
  }
  export default bidiFactory
}

declare module 'react/compiler-runtime' {
  export function c(size: number): Array<any>
}

declare module 'react-reconciler-axiomate' {
  import type { ReactNode } from 'react'
  function createReconciler<
    Type = any, Props = any, Container = any, Instance = any, TextInstance = any,
    SuspenseInstance = any, HydratableInstance = any, PublicInstance = any,
    HostContext = any, UpdatePayload = any, ChildSet = any, TimeoutHandle = any,
    NoTimeout = any, TransitionStatus = any,
  >(config: any): any
  export default createReconciler
  export type FiberRoot = any
}

declare module 'react-reconciler-axiomate/constants.js' {
  export const ConcurrentRoot: number
  export const LegacyRoot: number
  export const ContinuousEventPriority: number
  export const DefaultEventPriority: number
  export const DiscreteEventPriority: number
  export const NoEventPriority: number
}
