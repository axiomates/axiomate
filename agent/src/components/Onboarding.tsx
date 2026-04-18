import React, { useCallback, useEffect, useState } from 'react'
import {
  setupTerminal,
  shouldOfferTerminalSetup,
} from '../commands/terminalSetup/terminalSetup.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Link, Newline, Text, useTheme } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { env } from '../utils/env.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import type { ThemeSetting } from '../utils/theme.js'
import { Select } from './CustomSelect/select.js'
import { WelcomeV2 } from './LogoV2/WelcomeV2.js'
import { OnboardingProviderStep } from './OnboardingProviderStep.js'
import { PressEnterToContinue } from './PressEnterToContinue.js'
import { ThemePicker } from './ThemePicker.js'
import { OrderedList } from './ui/OrderedList.js'

type StepId =
  | 'provider-setup'
  | 'theme'
  | 'security'
  | 'terminal-setup'

interface OnboardingStep {
  id: StepId
  component: React.ReactNode
}

type Props = {
  onDone(): void
}

export function Onboarding({ onDone }: Props): React.ReactNode {
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [theme, setTheme] = useTheme()

  function goToNextStep() {
    if (currentStepIndex < steps.length - 1) {
      const nextIndex = currentStepIndex + 1
      setCurrentStepIndex(nextIndex)

    } else {
      onDone()
    }
  }

  function handleThemeSelection(newTheme: ThemeSetting) {
    setTheme(newTheme)
    goToNextStep()
  }

  const exitState = useExitOnCtrlCDWithKeybindings()

  // Define all onboarding steps
  const themeStep = (
    <Box marginX={1}>
      <ThemePicker
        onThemeSelect={handleThemeSelection}
        showIntroText={true}
        helpText="To change this later, run /theme"
        hideEscToCancel={true}
        skipExitHandling={true} // Skip exit handling as Onboarding already handles it
      />
    </Box>
  )

  const securityStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Security notes:</Text>
      <Box flexDirection="column" width={70}>
        {/**
         * OrderedList misnumbers items when rendering conditionally,
         * so put all items in the if/else
         */}
        <OrderedList>
          <OrderedList.Item>
            <Text>Axiomate can make mistakes</Text>
            <Text dimColor wrap="wrap">
              You should always review Axiomate&apos;s responses, especially when
              <Newline />
              running code.
              <Newline />
            </Text>
          </OrderedList.Item>
          <OrderedList.Item>
            <Text>
              Due to prompt injection risks, only use it with code you trust
            </Text>
            <Text dimColor wrap="wrap">
              For more details see:
              <Newline />
              <Link url="https://github.com/axiomates/axiomate/security" />
            </Text>
          </OrderedList.Item>
        </OrderedList>
      </Box>
      <PressEnterToContinue />
    </Box>
  )

  const handleCancelSetup = useCallback(() => {
    // Esc from the first step (protocol picker) aborts onboarding entirely.
    // Print a short hint and exit cleanly.
    // eslint-disable-next-line no-console -- Ink will be unmounted by gracefulShutdown
    console.log('\nSetup cancelled — run axiomate again to retry.')
    void gracefulShutdown(0)
  }, [])

  // Onboarding only runs on first run (gated upstream in showSetupScreens by
  // "no models configured"), so every step here is first-run-only by construction.
  const steps: OnboardingStep[] = [
    {
      id: 'provider-setup',
      component: (
        <OnboardingProviderStep
          onDone={() => goToNextStep()}
          onCancel={handleCancelSetup}
        />
      ),
    },
    { id: 'theme', component: themeStep },
    { id: 'security', component: securityStep },
  ]

  if (shouldOfferTerminalSetup()) {
    steps.push({
      id: 'terminal-setup',
      component: (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Use Axiomate&apos;s terminal setup?</Text>
          <Box flexDirection="column" width={70} gap={1}>
            <Text>
              For the optimal coding experience, enable the recommended settings
              <Newline />
              for your terminal:{' '}
              {env.terminal === 'Apple_Terminal'
                ? 'Option+Enter for newlines and visual bell'
                : 'Shift+Enter for newlines'}
            </Text>
            <Select
              options={[
                {
                  label: 'Yes, use recommended settings',
                  value: 'install',
                },
                {
                  label: 'No, maybe later with /terminal-setup',
                  value: 'no',
                },
              ]}
              onChange={value => {
                if (value === 'install') {
                  // Errors already logged in setupTerminal, just swallow and proceed
                  void setupTerminal(theme)
                    .catch(() => {})
                    .finally(goToNextStep)
                } else {
                  goToNextStep()
                }
              }}
              onCancel={() => goToNextStep()}
            />
            <Text dimColor>
              {exitState.pending ? (
                <>Press {exitState.keyName} again to exit</>
              ) : (
                <>Enter to confirm · Esc to skip</>
              )}
            </Text>
          </Box>
        </Box>
      ),
    })
  }

  const currentStep = steps[currentStepIndex]

  // Handle Enter on security step and Escape on terminal-setup step
  // Dependencies match what goToNextStep uses internally
  const handleSecurityContinue = useCallback(() => {
    if (currentStepIndex === steps.length - 1) {
      onDone()
    } else {
      goToNextStep()
    }
  }, [currentStepIndex, steps.length, onDone])

  const handleTerminalSetupSkip = useCallback(() => {
    goToNextStep()
  }, [currentStepIndex, steps.length, onDone])

  useKeybindings(
    {
      'confirm:yes': handleSecurityContinue,
    },
    {
      context: 'Confirmation',
      isActive: currentStep?.id === 'security',
    },
  )

  useKeybindings(
    {
      'confirm:no': handleTerminalSetupSkip,
    },
    {
      context: 'Confirmation',
      isActive: currentStep?.id === 'terminal-setup',
    },
  )

  return (
    <Box flexDirection="column">
      <WelcomeV2 />
      <Box flexDirection="column" marginTop={1}>
        {currentStep?.component}
        {exitState.pending && (
          <Box padding={1}>
            <Text dimColor>Press {exitState.keyName} again to exit</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

export function SkippableStep({
  skip,
  onSkip,
  children,
}: {
  skip: boolean
  onSkip(): void
  children: React.ReactNode
}): React.ReactNode {
  useEffect(() => {
    if (skip) {
      onSkip()
    }
  }, [skip, onSkip])
  if (skip) {
    return null
  }
  return children
}
