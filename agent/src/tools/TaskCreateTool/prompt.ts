import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'

export const DESCRIPTION =
  'Create pending tasks in the task list. Use TaskUpdate for every task status change.'

export function getPrompt(): string {
  const teammateContext = isAgentSwarmsEnabled()
    ? ' and potentially assigned to teammates'
    : ''

  const teammateTips = isAgentSwarmsEnabled()
    ? `- Include enough detail in the description for another agent to understand and complete the task
- New tasks are created with status 'pending' and no owner - use TaskUpdate with the \`owner\` parameter to assign them
`
    : ''

  return `Use this tool to create new pending tasks in the structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## Tool Boundary

TaskCreate only creates tasks. It does not start, complete, delete, claim, or update existing tasks.

All tasks created by TaskCreate start with status \`pending\`.

For every status change, use TaskUpdate instead:
- Before starting work on a task, call TaskUpdate with \`status: "in_progress"\`
- Immediately after finishing that task, call TaskUpdate with \`status: "completed"\`
- If a task is obsolete or was created by mistake, call TaskUpdate with \`status: "deleted"\`
- Do not create a replacement task just to change status
- Do not rely on final text to update task status; final answers do not change task state

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations${teammateContext}
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- Before starting implementation - create any missing tasks, then use TaskUpdate to mark the current task as in_progress
- After finishing a task - use TaskUpdate to mark that same task as completed, then create any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: What needs to be done
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) or status changes if needed
${teammateTips}- Check TaskList first to avoid creating duplicate tasks
`
}
