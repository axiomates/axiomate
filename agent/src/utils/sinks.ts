import { initializeErrorLogSink } from './errorLogSink.js'

/**
 * Attach the error log sink, draining any events queued before attachment.
 * Idempotent. Called from setup() for the default command; other entrypoints
 * (subcommands, daemon, bridge) call this directly since they bypass setup().
 */
export function initSinks(): void {
  initializeErrorLogSink()
}
