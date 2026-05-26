import type { UUID } from 'crypto'
import type { FileHistorySnapshot } from '../utils/fileHistory.js'
import type { ContentReplacementRecord } from '../utils/toolResultStorage.js'
import type { AgentId } from './ids.js'
import type { Message } from './message.js'
import type { QueueOperationMessage } from './messageQueueTypes.js'

export type SerializedMessage = Message & {
  cwd: string
  userType: string
  entrypoint?: string // AXIOMATE_CODE_ENTRYPOINT — distinguishes cli/sdk-ts/sdk-py/etc.
  sessionId: string
  timestamp: string
  version: string
  gitBranch?: string
  slug?: string // Session slug for files like plans (used for resume)
}

export type LogOption = {
  date: string
  messages: SerializedMessage[]
  fullPath?: string
  value: number
  created: Date
  modified: Date
  firstPrompt: string
  messageCount: number
  fileSize?: number // File size in bytes (for display)
  isSidechain: boolean
  isLite?: boolean // True for lite logs (messages not loaded)
  sessionId?: string // Session ID for lite logs
  teamName?: string // Team name if this is a spawned agent session
  agentName?: string // Agent's custom name (from /rename or swarm)
  agentColor?: string // Agent's color (from /rename or swarm)
  agentSetting?: string // Agent definition used (from --agent flag or settings.agent)
  isTeammate?: boolean // Whether this session was created by a swarm teammate
  leafUuid?: UUID // If given, this uuid must appear in the DB
  summary?: string // Optional conversation summary
  customTitle?: string // Optional user-set custom title
  tag?: string // Optional tag for the session (searchable in /resume)
  fileHistorySnapshots?: FileHistorySnapshot[] // Optional file history snapshots
  attributionSnapshots?: AttributionSnapshotMessage[] // Optional attribution snapshots
  contextCollapseCommits?: ContextCollapseCommitEntry[] // Ordered — commit B may reference commit A's summary
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry // Last-wins — staged queue + spawn state
  gitBranch?: string // Git branch at the end of the session
  projectPath?: string // Original project directory path
  prNumber?: number // GitHub PR number linked to this session
  prUrl?: string // Full URL to the linked PR
  prRepository?: string // Repository in "owner/repo" format
  mode?: 'coordinator' | 'normal' // Session mode for coordinator/normal detection
  worktreeSession?: PersistedWorktreeSession | null // Worktree state at session end (null = exited, undefined = never entered)
  contentReplacements?: ContentReplacementRecord[] // Replacement decisions for resume reconstruction
}

export type SummaryMessage = {
  type: 'summary'
  leafUuid: UUID
  summary: string
}

/**
 * Explicit conversation head marker. Written by `restoreMessageSync`
 * when the user runs Restore conversation in /rewind, so subsequent
 * `/resume` / `--continue` reloads pick the rewound branch instead of
 * the latest-leaf heuristic (which silently undid the rewind whenever
 * the user reloaded without first typing a new message).
 *
 * The record is NOT a chain participant — it doesn't carry parentUuid,
 * doesn't appear in the messages Map, and doesn't enter the model
 * prompt. It's a pointer-style metadata record consumed only by
 * loadTranscriptFile when picking which leaf to walk back from.
 *
 * Multiple entries are allowed (every rewind appends a new one);
 * loadTranscriptFile picks the latest by timestamp. Falls back to the
 * latest-leaf heuristic when:
 *   - No head record exists (old session before this format).
 *   - The head's `headUuid` doesn't resolve (message pruned, or fork
 *     dropped chain participants this points at).
 *
 * Forks (`/branch`, `--fork-session`) deliberately drop head records
 * from the cloned transcript — the new session starts fresh, and the
 * forked-into branch's "latest leaf at fork time" is the right entry
 * point, not a head marker carried over from the source.
 */
export type ConversationHeadEntry = {
  type: 'head'
  uuid: UUID
  /** UUID of the user/assistant/attachment/system message this head points at. */
  headUuid: UUID
  /** ISO 8601 timestamp; latest wins when multiple head records are present. */
  timestamp: string
  sessionId: UUID
}

/**
 * Persistent goal state for the Ralph-style /goal loop.
 *
 * Like {@link ConversationHeadEntry}, this is a non-chain pointer-style
 * record: not a transcript message, not part of {@link buildConversationChain},
 * not visible to the model. It's just a serialized {@link GoalState}
 * snapshot keyed by sessionId.
 *
 * Append-only with last-wins semantics: every mutation
 * ({@link GoalManager} `set` / `pause` / `resume` / `clear` / `evaluateAfterTurn`)
 * writes a new entry; readers pick the latest by timestamp (see
 * `loadGoalState` in `utils/goal/goalStore.ts`).
 *
 * `status: 'cleared'` is the tombstone — `loadGoalState` returns null.
 * Forks ({@link branch}, --fork-session) drop these along with other
 * non-transcript metadata, giving the new session a fresh goal slate.
 */
export type GoalStateEntry = {
  type: 'goal-state'
  uuid: UUID
  sessionId: UUID
  /** ISO 8601; latest entry per sessionId wins. */
  timestamp: string
  /** Empty string when status==='cleared'. */
  goal: string
  status: 'active' | 'paused' | 'done' | 'cleared'
  turnsUsed: number
  maxTurns: number
  /** Epoch ms when /goal was originally set. */
  createdAt: number
  /** Epoch ms of the most recent evaluateAfterTurn call. */
  lastTurnAt: number
  lastVerdict?: 'done' | 'continue' | 'skipped'
  lastReason?: string
  /** Human-readable why for status==='paused' (budget, judge, Ctrl+C, user). */
  pausedReason?: string
  /** Counts consecutive unparseable judge replies. Reset on any usable reply. */
  consecutiveParseFailures: number
  /** Mid-loop user-added criteria; checked by judge and surfaced to agent. */
  subgoals: string[]
}

export type CustomTitleMessage = {
  type: 'custom-title'
  sessionId: UUID
  customTitle: string
}

/**
 * AI-generated session title. Distinct from CustomTitleMessage so that:
 * - User renames (custom-title) always win over AI titles in read preference
 * - reAppendSessionMetadata never re-appends AI titles (they're ephemeral/
 *   regeneratable; re-appending would clobber user renames on resume)
 * - VS Code's onlyIfNoCustomTitle CAS check only matches user titles,
 *   allowing AI to overwrite its own previous AI title but not user titles
 */
export type AiTitleMessage = {
  type: 'ai-title'
  sessionId: UUID
  aiTitle: string
}

export type LastPromptMessage = {
  type: 'last-prompt'
  sessionId: UUID
  lastPrompt: string
}

/**
 * Periodic fork-generated summary of what the agent is currently doing.
 * Written every min(5 steps, 2min) by forking the main thread mid-turn so
 * `axiomate ps` can show something more useful than the last user prompt
 * (which is often "ok go" or "fix it").
 */
export type TaskSummaryMessage = {
  type: 'task-summary'
  sessionId: UUID
  summary: string
  timestamp: string
}

export type TagMessage = {
  type: 'tag'
  sessionId: UUID
  tag: string
}

export type AgentNameMessage = {
  type: 'agent-name'
  sessionId: UUID
  agentName: string
}

export type AgentColorMessage = {
  type: 'agent-color'
  sessionId: UUID
  agentColor: string
}

export type AgentSettingMessage = {
  type: 'agent-setting'
  sessionId: UUID
  agentSetting: string
}

/**
 * PR link message stored in session transcript.
 * Links a session to a GitHub pull request for tracking and navigation.
 */
export type PRLinkMessage = {
  type: 'pr-link'
  sessionId: UUID
  prNumber: number
  prUrl: string
  prRepository: string // e.g., "owner/repo"
  timestamp: string // ISO timestamp when linked
}

export type ModeEntry = {
  type: 'mode'
  sessionId: UUID
  mode: 'coordinator' | 'normal'
}

/**
 * Worktree session state persisted to the transcript for resume.
 * Subset of WorktreeSession from utils/worktree.ts — excludes ephemeral
 * fields (creationDurationMs, usedSparsePaths) that are only used for
 * first-run analytics.
 */
export type PersistedWorktreeSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
}

/**
 * Records whether the session is currently inside a worktree created by
 * EnterWorktree or --worktree. Last-wins: an enter writes the session,
 * an exit writes null. On --resume, restored only if the worktreePath
 * still exists on disk (the /exit dialog may have removed it).
 */
export type WorktreeStateEntry = {
  type: 'worktree-state'
  sessionId: UUID
  worktreeSession: PersistedWorktreeSession | null
}

/**
 * Records content blocks whose in-context representation was replaced with a
 * smaller stub (the full content was persisted elsewhere). Replayed on resume
 * for prompt cache stability. Written once per enforcement pass that replaces
 * at least one block. When agentId is set, the record belongs to a subagent
 * sidechain (AgentTool resume reads these); when absent, it's main-thread
 * (/resume reads these).
 */
export type ContentReplacementEntry = {
  type: 'content-replacement'
  sessionId: UUID
  agentId?: AgentId
  replacements: ContentReplacementRecord[]
}

export type FileHistorySnapshotMessage = {
  type: 'file-history-snapshot'
  messageId: UUID
  snapshot: FileHistorySnapshot
  isSnapshotUpdate: boolean
}

/**
 * Per-file attribution state tracking Axiomate's character contributions.
 */
export type FileAttributionState = {
  contentHash: string // SHA-256 hash of file content
  axiomateContribution: number // Characters written by the agent
  mtime: number // File modification time
}

/**
 * Attribution snapshot message stored in session transcript.
 * Tracks character-level contributions by the agent for commit attribution.
 */
export type AttributionSnapshotMessage = {
  type: 'attribution-snapshot'
  messageId: UUID
  surface: string // Client surface (cli, ide, web, api)
  fileStates: Record<string, FileAttributionState>
  promptCount?: number // Total prompts in session
  promptCountAtLastCommit?: number // Prompts at last commit
  permissionPromptCount?: number // Total permission prompts shown
  permissionPromptCountAtLastCommit?: number // Permission prompts at last commit
  escapeCount?: number // Total ESC presses (cancelled permission prompts)
  escapeCountAtLastCommit?: number // ESC presses at last commit
}

export type TranscriptMessage = SerializedMessage & {
  parentUuid: UUID | null
  logicalParentUuid?: UUID | null // Preserves logical parent when parentUuid is nullified for session breaks
  isSidechain: boolean
  gitBranch?: string
  agentId?: string // Agent ID for sidechain transcripts to enable resuming agents
  teamName?: string // Team name if this is a spawned agent session
  agentName?: string // Agent's custom name (from /rename or swarm)
  agentColor?: string // Agent's color (from /rename or swarm)
  promptId?: string // Correlates with OTel prompt.id for user prompt messages
}

export type SpeculationAcceptMessage = {
  type: 'speculation-accept'
  timestamp: string
  timeSavedMs: number
}

/**
 * Persisted context-collapse commit. The archived messages themselves are
 * NOT persisted — they're already in the transcript as ordinary user/
 * assistant messages. We only persist enough to reconstruct the splice
 * instruction (boundary uuids) and the summary placeholder (which is NOT
 * in the transcript because it's never yielded to the REPL).
 *
 * On restore, the store reconstructs CommittedCollapse with archived=[];
 * projectView lazily fills the archive the first time it finds the span.
 *
 * Discriminator is obfuscated to match the gate name. sessionStorage.ts
 * isn't feature-gated (it's the generic transcript plumbing used by every
 * entry type), so a descriptive string here would leak into external builds
 * via the appendEntry dispatch / loadTranscriptFile parser even though
 * nothing in an external build ever writes or reads this entry.
 */
export type ContextCollapseCommitEntry = {
  type: 'marble-origami-commit'
  sessionId: UUID
  /** 16-digit collapse ID. Max across entries reseeds the ID counter. */
  collapseId: string
  /** The summary placeholder's uuid — registerSummary() needs it. */
  summaryUuid: string
  /** Full <collapsed id="...">text</collapsed> string for the placeholder. */
  summaryContent: string
  /** Plain summary text for ctx_inspect. */
  summary: string
  /** Span boundaries — projectView finds these in the resumed Message[]. */
  firstArchivedUuid: string
  lastArchivedUuid: string
}

/**
 * Snapshot of the staged queue and spawn trigger state. Unlike commits
 * (append-only, replay-all), snapshots are last-wins — only the most
 * recent snapshot entry is applied on restore. Written after every
 * ctx-agent spawn resolves (when staged contents may have changed).
 *
 * Staged boundaries are UUIDs (session-stable), not collapse IDs (which
 * reset with the uuidToId bimap). Restoring a staged span issues fresh
 * collapse IDs for those messages on the next decorate/display, but the
 * span itself resolves correctly.
 */
export type ContextCollapseSnapshotEntry = {
  type: 'marble-origami-snapshot'
  sessionId: UUID
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
  }>
  /** Spawn trigger state — so the +interval clock picks up where it left off. */
  armed: boolean
  lastSpawnTokens: number
}

export type Entry =
  | TranscriptMessage
  | SummaryMessage
  | CustomTitleMessage
  | AiTitleMessage
  | LastPromptMessage
  | TaskSummaryMessage
  | TagMessage
  | AgentNameMessage
  | AgentColorMessage
  | AgentSettingMessage
  | PRLinkMessage
  | FileHistorySnapshotMessage
  | AttributionSnapshotMessage
  | QueueOperationMessage
  | SpeculationAcceptMessage
  | ModeEntry
  | WorktreeStateEntry
  | ContentReplacementEntry
  | ContextCollapseCommitEntry
  | ContextCollapseSnapshotEntry
  | ConversationHeadEntry
  | GoalStateEntry

export function sortLogs(logs: LogOption[]): LogOption[] {
  return logs.sort((a, b) => {
    // Sort by modified date (newest first)
    const modifiedDiff = b.modified.getTime() - a.modified.getTime()
    if (modifiedDiff !== 0) {
      return modifiedDiff
    }

    // If modified dates are equal, sort by created date (newest first)
    return b.created.getTime() - a.created.getTime()
  })
}
