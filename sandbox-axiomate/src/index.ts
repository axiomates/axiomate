// Library exports
export { SandboxManager } from './sandbox/sandbox-manager.js';
export { SandboxViolationStore } from './sandbox/sandbox-violation-store.js';
export { SandboxRuntimeConfigSchema, NetworkConfigSchema, FilesystemConfigSchema, IgnoreViolationsConfigSchema, RipgrepConfigSchema, } from './sandbox/sandbox-config.js';
// Utility functions
export { getDefaultWritePaths } from './sandbox/sandbox-utils.js';
// Platform utilities
export { getWslVersion } from './utils/platform.js';

// Type exports — used by the agent adapter layer
export type {
  SandboxRuntimeConfig,
  ReadConfig,
  WriteConfig,
  NetworkConfig,
  SandboxViolation,
} from './sandbox/sandbox-manager.js';

// Alias types that the agent uses (mapping to internal names)
export type FsReadRestrictionConfig = import('./sandbox/sandbox-manager.js').ReadConfig;
export type FsWriteRestrictionConfig = import('./sandbox/sandbox-manager.js').WriteConfig;
export type NetworkRestrictionConfig = { allowedHosts?: string[]; deniedHosts?: string[] };
export type NetworkHostPattern = { host: string; port?: number };
export type SandboxAskCallback = (hostPattern: NetworkHostPattern) => Promise<boolean>;
export type SandboxDependencyCheck = { errors: string[]; warnings: string[] };
export type IgnoreViolationsConfig = Record<string, string[]>;
export type SandboxViolationEvent = import('./sandbox/sandbox-manager.js').SandboxViolation;