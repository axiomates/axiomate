import { BASH_TOOL_NAME } from '../../BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from '../../FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../GrepTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../SendMessageTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from '../../WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '../../WebSearchTool/prompt.js'
import { hasEmbeddedSearchTools } from '../../../utils/embeddedTools.js'
import { getSettings_DEPRECATED } from '../../../utils/settings/settings.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../loadAgentsDir.js'

export const AXIOMATE_GUIDE_AGENT_TYPE = 'axiomate-guide'

function getAxiomateGuideBasePrompt(): string {
  // Some builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find/grep instead.
  const localSearchHint = hasEmbeddedSearchTools()
    ? `${FILE_READ_TOOL_NAME}, \`find\`, and \`grep\``
    : `${FILE_READ_TOOL_NAME}, ${GLOB_TOOL_NAME}, and ${GREP_TOOL_NAME}`

  return `You are the code guide agent. Your job is to help users understand and use Axiomate effectively.

**Axiomate** is a multi-provider AI agent CLI: installation, configuration, hooks, skills, MCP servers, keyboard shortcuts, IDE integrations, settings, subagents, plugins, and workflows.

**Approach:**
1. Reference local project files (AXIOMATE.md, .axiomate/ directory) when relevant using ${localSearchHint}
2. Use ${WEB_SEARCH_TOOL_NAME} or ${WEB_FETCH_TOOL_NAME} to look up topics the user asks about
3. Provide clear, actionable guidance grounded in what's actually in the repo or the docs you find
4. If the user is asking about their configured model provider's API (Anthropic, OpenAI, Gemini, etc.), refer them to that provider's own docs

**Guidelines:**
- Prioritize the user's actual configuration (.axiomate/, AXIOMATE.md, settings.json) over assumptions
- Keep responses concise and actionable
- Include specific examples or code snippets when helpful
- Help users discover features by proactively suggesting related commands, shortcuts, or capabilities

Complete the user's request by providing accurate guidance.`
}

function getFeedbackGuideline(): string {
  return `- When you cannot find an answer or the feature doesn't exist, direct the user to ${MACRO.ISSUES_EXPLAINER}`
}

export const AXIOMATE_CODE_GUIDE_AGENT: BuiltInAgentDefinition = {
  agentType: AXIOMATE_GUIDE_AGENT_TYPE,
  whenToUse: `Use this agent when the user asks questions ("Can axiomate...", "How do I...") about Axiomate: features, hooks, slash commands, MCP servers, settings, IDE integrations, keyboard shortcuts, subagents, plugins. **IMPORTANT:** Before spawning a new agent, check if there is already a running or recently completed axiomate-guide agent that you can continue via ${SEND_MESSAGE_TOOL_NAME}.`,
  // Some builds remove the dedicated Glob/Grep tools; use Bash (with embedded
  // bfs/ugrep via find/grep aliases) for local file search instead.
  tools: hasEmbeddedSearchTools()
    ? [
        BASH_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ]
    : [
        GLOB_TOOL_NAME,
        GREP_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ],
  source: 'built-in',
  baseDir: 'built-in',
  model: 'inherit',
  permissionMode: 'dontAsk',
  getSystemPrompt({ toolUseContext }) {
    const commands = toolUseContext.options.commands

    // Build context sections
    const contextSections: string[] = []

    // 1. Custom skills
    const customCommands = commands.filter(cmd => cmd.type === 'prompt')
    if (customCommands.length > 0) {
      const commandList = customCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(
        `**Available custom skills in this project:**\n${commandList}`,
      )
    }

    // 2. Custom agents from .axiomate/agents/
    const customAgents =
      toolUseContext.options.agentDefinitions.activeAgents.filter(
        (a: AgentDefinition) => a.source !== 'built-in',
      )
    if (customAgents.length > 0) {
      const agentList = customAgents
        .map((a: AgentDefinition) => `- ${a.agentType}: ${a.whenToUse}`)
        .join('\n')
      contextSections.push(
        `**Available custom agents configured:**\n${agentList}`,
      )
    }

    // 3. MCP servers
    const mcpClients = toolUseContext.options.mcpClients
    if (mcpClients && mcpClients.length > 0) {
      const mcpList = mcpClients
        .map((client: { name: string }) => `- ${client.name}`)
        .join('\n')
      contextSections.push(`**Configured MCP servers:**\n${mcpList}`)
    }

    // 4. Plugin commands
    const pluginCommands = commands.filter(
      cmd => cmd.type === 'prompt' && cmd.source === 'plugin',
    )
    if (pluginCommands.length > 0) {
      const pluginList = pluginCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(`**Available plugin skills:**\n${pluginList}`)
    }

    // 5. User settings
    const settings = getSettings_DEPRECATED()
    if (Object.keys(settings).length > 0) {
      // eslint-disable-next-line no-restricted-syntax -- human-facing UI, not tool_result
      const settingsJson = jsonStringify(settings, null, 2)
      contextSections.push(
        `**User's settings.json:**\n\`\`\`json\n${settingsJson}\n\`\`\``,
      )
    }

    // Add the support guideline.
    const feedbackGuideline = getFeedbackGuideline()
    const basePromptWithFeedback = `${getAxiomateGuideBasePrompt()}
${feedbackGuideline}`

    // If we have any context to add, append it to the base system prompt
    if (contextSections.length > 0) {
      return `${basePromptWithFeedback}

---

# User's Current Configuration

The user has the following custom setup in their environment:

${contextSections.join('\n\n')}

When answering questions, consider these configured features and proactively suggest them when relevant.`
    }

    // Return the base prompt if no context to add
    return basePromptWithFeedback
  },
}
