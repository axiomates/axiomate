import type { PartialCompactDirection } from '../../types/message.js'

// Aggressive no-tools preamble. The cache-sharing fork path inherits the
// parent's full tool set (required for cache-key match), and some
// adaptive-thinking models attempt a tool call despite the weaker trailer
// instruction. With maxTurns: 1, a denied tool call means no text output and
// falls through to the streaming fallback. Putting this FIRST and making it
// explicit about rejection consequences prevents the wasted turn.
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

// Two variants: BASE scopes to "the conversation", PARTIAL scopes to "the
// recent messages". The <analysis> block is a drafting scratchpad that
// formatCompactSummary() strips before the summary reaches context.
const DETAILED_ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`

const DETAILED_ANALYSIS_INSTRUCTION_PARTIAL = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Analyze the recent messages chronologically. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages: 
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response. 

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>
`

const PARTIAL_COMPACT_PROMPT = `Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized. Focus your summary on what was discussed, learned, and accomplished in the recent messages only.

${DETAILED_ANALYSIS_INSTRUCTION_PARTIAL}

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents from the recent messages
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed recently.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages from the recent portion that are not tool results.
7. Pending Tasks: Outline any pending tasks from the recent messages.
8. Current Work: Describe precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step related to the most recent work. Include direct quotes from the most recent conversation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important Code Snippet]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Problem Solving:
   [Description]

6. All user messages:
    - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the RECENT messages only (after the retained earlier context), following this structure and ensuring precision and thoroughness in your response.
`

// 'up_to': model sees only the summarized prefix (cache hit). Summary will
// precede kept recent messages, hence "Context for Continuing Work" section.
const PARTIAL_COMPACT_UP_TO_PROMPT = `Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session; newer messages that build on this context will follow after your summary (you do not see them here). Summarize thoroughly so that someone reading only your summary and then the newer messages can fully understand what happened and continue the work.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents in detail
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results.
7. Pending Tasks: Outline any pending tasks.
8. Work Completed: Describe what was accomplished by the end of this portion.
9. Context for Continuing Work: Summarize any context, decisions, or state that would be needed to understand and continue the work in subsequent messages.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important Code Snippet]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Problem Solving:
   [Description]

6. All user messages:
    - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]

8. Work Completed:
   [Description of what was accomplished]

9. Context for Continuing Work:
   [Key context, decisions, or state needed to continue the work]

</summary>
</example>

Please provide your summary following this structure, ensuring precision and thoroughness in your response.
`

// Placeholder for iterative compact prompt — replaced at runtime with the
// extracted prior summary text. Exported so tests can assert the literal.
export const ITERATIVE_COMPACT_PREVIOUS_SUMMARY_PLACEHOLDER =
  '{{ previousSummary }}'

// Iterative variant used when a previous compact summary exists in history.
// Instead of asking the LLM to "summarize the conversation so far" (which
// causes it to re-narrate old content or drop still-valid Pending Tasks),
// we explicitly hand it the prior summary and tell it to UPDATE field-by-field.
// The same 9-section schema as BASE_COMPACT_PROMPT is used so downstream
// formatting (formatCompactSummary) stays unchanged.
const ITERATIVE_COMPACT_PROMPT = `Your task is to UPDATE an existing context compaction summary with new conversation turns that have occurred since.

PREVIOUS SUMMARY:
${ITERATIVE_COMPACT_PREVIOUS_SUMMARY_PLACEHOLDER}

Focus your update on what changed — do NOT re-narrate the previous summary's contents. Preserve all existing information that is still valid. The new conversation turns follow this prompt in the conversation history.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Use the SAME 9-section structure as a fresh summary. Field-by-field update rules:

1. Primary Request and Intent — PRESERVE from the previous summary. Only add a "Current Focus:" sub-entry if the user explicitly redirected in the new turns.
2. Key Technical Concepts — APPEND new concepts. Do not remove existing ones.
3. Files and Code Sections — APPEND new files. Keep existing file summaries unless the file was substantially refactored in new turns; in that case UPDATE the entry and note "(updated)".
4. Errors and fixes — APPEND new errors. For old errors fixed in new turns, keep them and add "(resolved in this update)".
5. Problem Solving — APPEND new problems with their status (solved / ongoing / blocked).
6. All user messages — APPEND new user messages. Keep existing ones from the previous summary.
7. Pending Tasks —
   - MOVE completed tasks to a new "Completed This Session:" sub-list
   - APPEND new pending tasks from new turns
   - REMOVE a task only if the user explicitly retracted it
8. Current Work — REPLACE with the description of what's happening at the end of the new turns. This field reflects current frontier, not history.
9. Optional Next Step — REPLACE with the next step at the end of new turns. Include direct quotes from the most recent conversation.

CRITICAL: "Pending Tasks" and "Current Work" are the most load-bearing fields for a continuation assistant. A pending task accidentally dropped means the user's request is forgotten.

Output structure is identical to a fresh summary:

<example>
<analysis>
[Your thought process, ensuring every update rule above was applied to each section]
</analysis>

<summary>
1. Primary Request and Intent:
   [Preserved from previous summary, with any Current Focus addition]

2. Key Technical Concepts:
   - [preserved + appended]

3. Files and Code Sections:
   - [preserved + appended, with (updated) markers if any]

4. Errors and fixes:
    - [preserved + appended, with (resolved in this update) markers if any]

5. Problem Solving:
   [preserved + appended]

6. All user messages:
    - [preserved + appended]

7. Pending Tasks:
   - [remaining pending from previous]
   - [new pending from new turns]

   Completed This Session:
   - [tasks moved from Pending]

8. Current Work:
   [refreshed to reflect end-of-new-turns state]

9. Optional Next Step:
   [refreshed to reflect end-of-new-turns state]
</summary>
</example>

Please provide your updated summary following this structure and the field-by-field rules.
`

const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.'

export function getPartialCompactPrompt(
  customInstructions?: string,
  direction: PartialCompactDirection = 'from',
): string {
  const template =
    direction === 'up_to'
      ? PARTIAL_COMPACT_UP_TO_PROMPT
      : PARTIAL_COMPACT_PROMPT
  let prompt = NO_TOOLS_PREAMBLE + template

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}

export function getCompactPrompt(
  customInstructions?: string,
  previousSummary?: string,
): string {
  let prompt = NO_TOOLS_PREAMBLE
  if (previousSummary && previousSummary.trim() !== '') {
    prompt += ITERATIVE_COMPACT_PROMPT.replace(
      ITERATIVE_COMPACT_PREVIOUS_SUMMARY_PLACEHOLDER,
      previousSummary,
    )
  } else {
    prompt += BASE_COMPACT_PROMPT
  }

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}

/**
 * Formats the compact summary by stripping the <analysis> drafting scratchpad
 * and replacing <summary> XML tags with readable section headers.
 * @param summary The raw summary string potentially containing <analysis> and <summary> XML tags
 * @returns The formatted summary with analysis stripped and summary tags replaced by headers
 */
export function formatCompactSummary(summary: string): string {
  let formattedSummary = summary

  // Strip analysis section — it's a drafting scratchpad that improves summary
  // quality but has no informational value once the summary is written.
  formattedSummary = formattedSummary.replace(
    /<analysis>[\s\S]*?<\/analysis>/,
    '',
  )

  // Extract and format summary section
  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    const content = summaryMatch[1] || ''
    formattedSummary = formattedSummary.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    )
  }

  // Clean up extra whitespace between sections
  formattedSummary = formattedSummary.replace(/\n\n+/g, '\n\n')

  return formattedSummary.trim()
}

// Exported so extractPreviousCompactSummary in compact.ts can reliably
// strip the wrapper without string-duplicating these literals. Updating
// any of these requires updating the extractor's test fixtures too.
export const COMPACT_SUMMARY_PREAMBLE =
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.'
export const COMPACT_SUMMARY_TRANSCRIPT_TRAILER_PREFIX =
  'If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: '
export const COMPACT_SUMMARY_RECENT_TRAILER =
  'Recent messages are preserved verbatim.'
export const COMPACT_SUMMARY_SUPPRESS_TRAILER =
  'Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.'

export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
): string {
  const formattedSummary = formatCompactSummary(summary)

  let baseSummary = `${COMPACT_SUMMARY_PREAMBLE}

${formattedSummary}`

  if (transcriptPath) {
    baseSummary += `\n\n${COMPACT_SUMMARY_TRANSCRIPT_TRAILER_PREFIX}${transcriptPath}`
  }

  if (recentMessagesPreserved) {
    baseSummary += `\n\n${COMPACT_SUMMARY_RECENT_TRAILER}`
  }

  if (suppressFollowUpQuestions) {
    let continuation = `${baseSummary}
${COMPACT_SUMMARY_SUPPRESS_TRAILER}`

    return continuation
  }

  return baseSummary
}
