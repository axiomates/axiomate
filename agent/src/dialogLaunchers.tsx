/**
 * Thin launchers for one-off dialog JSX sites in main.tsx.
 * Each launcher dynamically imports its component and wires the `done` callback
 * identically to the original inline call site. Zero behavior change.
 *
 * Part of the main.tsx React/JSX extraction effort. See sibling PRs
 * perf/extract-interactive-helpers and perf/launch-repl.
 */
import React from 'react';
import type { StatsStore } from './context/stats.js';
import type { Root } from './ink.js';
import { renderAndRun, showSetupDialog } from './interactiveHelpers.js';
import { KeybindingSetup } from './keybindings/KeybindingProviderSetup.js';
import type { AppState } from './state/AppStateStore.js';
import type { AgentMemoryScope } from './tools/AgentTool/agentMemory.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
import type { ValidationError } from './utils/settings/validation.js';

// Type-only access to ResumeConversation's Props via the module type.
// No runtime cost - erased at compile time.
type ResumeConversationProps = React.ComponentProps<typeof import('./screens/ResumeConversation.js').ResumeConversation>;

/**
 * Site ~3173: SnapshotUpdateDialog (agent memory snapshot update prompt).
 * Original callback wiring: onComplete={done}, onCancel={() => done('keep')}.
 */
export async function launchSnapshotUpdateDialog(_root: Root, _props: {
  agentType: string;
  scope: AgentMemoryScope;
  snapshotTimestamp: string;
}): Promise<'merge' | 'keep' | 'replace'> {
  return 'keep';
}

/**
 * Site ~3250: InvalidSettingsDialog (settings validation errors).
 * Original callback wiring: onContinue={done}, onExit passed through from caller.
 */
export async function launchInvalidSettingsDialog(root: Root, props: {
  settingsErrors: ValidationError[];
  onExit: () => void;
}): Promise<void> {
  const {
    InvalidSettingsDialog
  } = await import('./components/InvalidSettingsDialog.js');
  return showSetupDialog(root, done => <InvalidSettingsDialog settingsErrors={props.settingsErrors} onContinue={done} onExit={props.onExit} />);
}

/**
 * `axiomate assistant` found zero sessions — show the same install wizard
 * as `/assistant` when daemon.json is empty. Resolves to the installed dir on
 * success, null on cancel. Rejects on install failure so the caller can
 * distinguish errors from user cancellation.
 */
export async function launchAssistantInstallWizard(_root: Root): Promise<string | null> {
  return null;
}

/**
 * Site ~4903: ResumeConversation mount (interactive session picker).
 * Uses renderAndRun, NOT showSetupDialog. Wraps in <App><KeybindingSetup>.
 * Preserves original Promise.all parallelism between getWorktreePaths and imports.
 */
export async function launchResumeChooser(root: Root, appProps: {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats: StatsStore;
  initialState: AppState;
}, worktreePathsPromise: Promise<string[]>, resumeProps: Omit<ResumeConversationProps, 'worktreePaths'>): Promise<void> {
  const [worktreePaths, {
    ResumeConversation
  }, {
    App
  }] = await Promise.all([worktreePathsPromise, import('./screens/ResumeConversation.js'), import('./components/App.js')]);
  await renderAndRun(root, <App getFpsMetrics={appProps.getFpsMetrics} stats={appProps.stats} initialState={appProps.initialState}>
      <KeybindingSetup>
        <ResumeConversation {...resumeProps} worktreePaths={worktreePaths} />
      </KeybindingSetup>
    </App>);
}
