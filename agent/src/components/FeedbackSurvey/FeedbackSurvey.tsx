import React from 'react'
import { Box, Text } from '../../ink.js'
import {
  FeedbackSurveyView,
  isValidResponseInput,
} from './FeedbackSurveyView.js'
import type { FeedbackSurveyResponse } from './utils.js'

type Props = {
  state: 'closed' | 'open' | 'thanks'
  lastResponse: FeedbackSurveyResponse | null
  handleSelect: (selected: FeedbackSurveyResponse) => void
  inputValue: string
  setInputValue: (value: string) => void
  message?: string
}

export function FeedbackSurvey({
  state,
  lastResponse,
  handleSelect,
  inputValue,
  setInputValue,
  message,
}: Props): React.ReactNode {
  if (state === 'closed') {
    return null
  }

  if (state === 'thanks') {
    return (
      <FeedbackSurveyThanks
        lastResponse={lastResponse}
      />
    )
  }

  // state === 'open'
  // Hide the survey if the user is typing anything other than a survey response.
  // This prevents the survey from showing up when the user is typing a message,
  // which can result in accidental survey submissions (e.g. "s3cmd").
  if (inputValue && !isValidResponseInput(inputValue)) {
    return null
  }

  return (
    <FeedbackSurveyView
      onSelect={handleSelect}
      inputValue={inputValue}
      setInputValue={setInputValue}
      message={message}
    />
  )
}

type ThanksProps = {
  lastResponse: FeedbackSurveyResponse | null
}

function FeedbackSurveyThanks({
  lastResponse,
}: ThanksProps): React.ReactNode {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="success">Thanks for the feedback!</Text>
      {lastResponse === 'bad' ? (
        <Text dimColor>Use /issue to report model behavior issues.</Text>
      ) : null}
    </Box>
  )
}
