import * as React from 'react';
import { ErrorBoundary } from '../../ErrorBoundary.js';
import { Box, useTheme } from '../../../ink.js';
import { filterToolProgressMessages, type Tool, type Tools } from '../../../Tool.js';
import type { NormalizedUserMessage, ProgressMessage } from '../../../types/message.js';
import type { buildMessageLookups } from '../../../utils/messages.js';
import { HookProgressMessage } from '../HookProgressMessage.js';
type Props = {
  message: NormalizedUserMessage;
  lookups: ReturnType<typeof buildMessageLookups>;
  toolUseID: string;
  progressMessagesForMessage: ProgressMessage[];
  style?: 'condensed';
  tool?: Tool;
  tools: Tools;
  verbose: boolean;
  width: number | string;
  isTranscriptMode?: boolean;
};
export function UserToolSuccessMessage({
  message,
  lookups,
  toolUseID,
  progressMessagesForMessage,
  style,
  tool,
  tools,
  verbose,
  width,
  isTranscriptMode
}: Props): React.ReactNode {
  const [theme] = useTheme();

  if (!message.toolUseResult || !tool) {
    return null;
  }

  // Resumed transcripts deserialize toolUseResult via raw JSON.parse with no
  // validation (parseJSONL). A partial/corrupt/old-format result crashes
  // renderToolResultMessage on first field access (axiomates/axiomate#39817).
  // Validate against outputSchema before rendering — mirrors CollapsedReadSearchContent.
  const parsedOutput = tool.outputSchema?.safeParse(message.toolUseResult);
  if (parsedOutput && !parsedOutput.success) {
    return null;
  }
  const toolResult = parsedOutput?.data ?? message.toolUseResult;
  const renderedMessage = tool.renderToolResultMessage?.(toolResult as never, filterToolProgressMessages(progressMessagesForMessage), {
    style,
    theme,
    tools,
    verbose,
    isTranscriptMode,
    input: lookups.toolUseByToolUseID.get(toolUseID)?.input
  }) ?? null;

  // Don't render anything if the tool result message is null
  if (renderedMessage === null) {
    return null;
  }

  // Tools that return '' from userFacingName opt out of tool chrome and
  // render like plain assistant text. Skip the tool-result width constraint
  // so MarkdownTable's SAFETY_MARGIN=4 (tuned for the assistant-text 2-col
  // dot gutter) holds — otherwise tables wrap their box-drawing chars.
  const rendersAsAssistantText = tool.userFacingName(undefined) === '';
  return <Box flexDirection="column">
      <Box flexDirection="column" width={rendersAsAssistantText ? undefined : width}>
        {renderedMessage}
      </Box>
      <ErrorBoundary>
        <HookProgressMessage hookEvent="PostToolUse" lookups={lookups} toolUseID={toolUseID} verbose={verbose} isTranscriptMode={isTranscriptMode} />
      </ErrorBoundary>
    </Box>;
}
