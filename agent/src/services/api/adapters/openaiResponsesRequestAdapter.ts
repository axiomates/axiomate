/**
 * Neutral → OpenAI Responses API request conversion.
 *
 * Converts protocol-neutral types (MessageParam, NeutralToolSchema, ToolChoice)
 * into the input / tools / tool_choice shapes expected by
 * client.responses.create().
 */
import type {
  ContentBlockParam,
  MessageParam,
  NeutralToolSchema,
  ThinkingRoundTrip,
  ToolChoice,
} from '../streamTypes.js'
import type {
  EasyInputMessage,
  FunctionTool,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseReasoningItem,
} from 'openai/resources/responses/responses'

// ---------------------------------------------------------------------------
// Input items
// ---------------------------------------------------------------------------

type InputItem = ResponseInputItem

type InputImageContent = {
  type: 'input_image'
  image_url: string
  detail?: 'auto' | 'low' | 'high'
}

type InputTextContent = {
  type: 'input_text'
  text: string
}

type OutputTextContent = {
  type: 'output_text'
  text: string
}

/**
 * Convert neutral MessageParam[] → ResponseInputItem[].
 *
 * Flattens axiomate's mixed-content messages into the Responses API's
 * typed input item array. Preserves chronological ordering.
 */
export function messagesToOpenAIResponsesInput(
  messages: MessageParam[],
  options?: { supportsImages?: boolean },
): InputItem[] {
  const supportsImages = options?.supportsImages ?? false
  const result: InputItem[] = []

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({
        role: msg.role,
        content: msg.content,
      } as EasyInputMessage)
      continue
    }

    if (msg.role === 'user') {
      emitUserBlocks(msg.content, supportsImages, result)
    } else {
      emitAssistantBlocks(msg.content, supportsImages, result)
    }
  }

  return result
}

function emitUserBlocks(
  blocks: ContentBlockParam[],
  supportsImages: boolean,
  result: InputItem[],
): void {
  const contentParts: (InputTextContent | InputImageContent)[] = []

  function flushContent(): void {
    if (contentParts.length > 0) {
      result.push({
        role: 'user',
        content: [...contentParts],
      } as unknown as InputItem)
      contentParts.length = 0
    }
  }

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        contentParts.push({ type: 'input_text', text: block.text })
        break
      case 'image': {
        if (!supportsImages) {
          contentParts.push({
            type: 'input_text',
            text: '[Image omitted: model does not support image input]',
          })
          break
        }
        const src = block.source
        if (src.type === 'base64') {
          contentParts.push({
            type: 'input_image',
            image_url: `data:${src.media_type};base64,${src.data}`,
            detail: 'auto',
          })
        } else if (src.type === 'url') {
          contentParts.push({
            type: 'input_image',
            image_url: src.url,
            detail: 'auto',
          })
        }
        break
      }
      case 'tool_result': {
        // tool_result always emits as its own function_call_output item.
        // Flush any pending user content first.
        flushContent()

        let textContent = ''
        const pendingImages: InputImageContent[] = []

        if (typeof block.content === 'string') {
          textContent = block.content
        } else if (Array.isArray(block.content)) {
          const textChunks: string[] = []
          for (const inner of block.content) {
            if (inner.type === 'text') {
              textChunks.push((inner as { text: string }).text)
            } else if (inner.type === 'image') {
              if (!supportsImages) continue
              const src = (inner as any).source
              if (src?.type === 'base64' && src.data && src.media_type) {
                pendingImages.push({
                  type: 'input_image',
                  image_url: `data:${src.media_type};base64,${src.data}`,
                  detail: 'auto',
                })
              } else if (src?.type === 'url' && src.url) {
                pendingImages.push({
                  type: 'input_image',
                  image_url: src.url,
                  detail: 'auto',
                })
              }
            }
          }
          textContent = textChunks.join('\n')
        }

        if (textContent.length === 0) {
          textContent = pendingImages.length > 0
            ? '[image attached, see next message]'
            : '(no output)'
        }

        const output = block.is_error ? `Error: ${textContent}` : textContent

        result.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output,
        } as unknown as InputItem)

        // Defer images as a follow-up user message
        if (pendingImages.length > 0) {
          result.push({
            role: 'user',
            content: pendingImages,
          } as unknown as InputItem)
        }
        break
      }
      case 'thinking':
      case 'redacted_thinking':
      case 'document':
        break
    }
  }

  flushContent()
}

function emitAssistantBlocks(
  blocks: ContentBlockParam[],
  supportsImages: boolean,
  result: InputItem[],
): void {
  const textParts: OutputTextContent[] = []

  function flushAssistantText(): void {
    if (textParts.length > 0) {
      result.push({
        role: 'assistant',
        content: [...textParts],
      } as unknown as InputItem)
      textParts.length = 0
    }
  }

  for (const block of blocks) {
    switch (block.type) {
      case 'thinking': {
        const rt: ThinkingRoundTrip = block.roundTrip
        if (rt.provider === 'openai-responses') {
          // Emit reasoning item before any assistant text/tool_use that follows
          flushAssistantText()
          const reasoningItem: ResponseReasoningItem = {
            type: 'reasoning',
            id: rt.id,
            summary: rt.summaryParts.map(t => ({ type: 'summary_text' as const, text: t })),
            ...(rt.encryptedContent ? { encrypted_content: rt.encryptedContent } : {}),
          }
          result.push(reasoningItem as unknown as InputItem)
        }
        // Other providers (anthropic, none): skip
        break
      }
      case 'tool_use': {
        flushAssistantText()
        const toolCall: ResponseFunctionToolCall = {
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: typeof block.input === 'string'
            ? block.input
            : JSON.stringify(block.input),
        }
        result.push(toolCall as unknown as InputItem)
        break
      }
      case 'text':
        textParts.push({ type: 'output_text', text: block.text })
        break
      case 'image': {
        // Assistant messages shouldn't normally contain images, but handle gracefully
        if (supportsImages) {
          textParts.push({ type: 'output_text', text: '[Image output]' })
        }
        break
      }
      case 'redacted_thinking':
      case 'document':
        break
    }
  }

  flushAssistantText()
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Convert neutral tool schemas to Responses API FunctionTool format.
 * Responses API uses flat { type, name, description, parameters, strict }
 * without the nested function:{} wrapper that Chat Completions uses.
 */
export function toolsToOpenAIResponses(tools: NeutralToolSchema[]): FunctionTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    name: t.name,
    description: t.description ?? null,
    parameters: { type: 'object', ...t.inputSchema },
    strict: t.strict ?? null,
  }))
}

// ---------------------------------------------------------------------------
// Tool choice
// ---------------------------------------------------------------------------

type ResponseToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; name: string }

export function toolChoiceToOpenAIResponses(choice?: ToolChoice): ResponseToolChoice | undefined {
  if (!choice) return undefined
  switch (choice.type) {
    case 'auto':
      return 'auto'
    case 'none':
      return 'none'
    case 'required':
      return 'required'
    case 'specific':
      return { type: 'function', name: choice.name }
  }
}
