// Stub declarations for names that are referenced in agent code but whose
// definitions were removed during the claude-code -> axiomate extraction.
// These are compile-time stubs only (return inert values / any).

// ---- Ant-model resolution (Anthropic internal model registry) ----
declare function resolveAntModel(modelId: string, ...args: any[]): any
declare function getAntModels(...args: any[]): any
declare function getAntModelOverrideConfig(...args: any[]): any

// ---- API metrics (performance / TTFT tracking) ----
declare const apiMetricsRef: { current: any }
declare function computeTtftText(metrics: any): string

// ---- React components that were not ported ----
declare const GateOverridesWarning: any
declare const ExperimentEnrollmentNotice: any
declare const TungstenPill: any
declare const UltraplanLaunchDialog: any
declare const UltraplanChoiceDialog: any

// ---- Feature gates ----
declare const Gates: any

// ---- Ultraplan (Anthropic internal planning feature) ----
declare function launchUltraplan(...args: any[]): any

// ---- Constants ----
declare const HOOK_TIMING_DISPLAY_THRESHOLD_MS: number

// ---- Node.js ErrnoException (available in @types/node but sometimes missed) ----
interface ErrnoException extends Error {
  errno?: number | undefined
  code?: string | undefined
  path?: string | undefined
  syscall?: string | undefined
}
