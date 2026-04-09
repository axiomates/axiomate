import * as React from 'react'
import { Box, Text, color } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import {
  getLayoutMode,
  calculateLayoutDimensions,
  calculateOptimalLeftWidth,
  formatWelcomeMessage,
  truncatePath,
  getRecentActivitySync,
  getRecentReleaseNotesSync,
  getLogoDisplayData,
} from '../../utils/logoV2Utils.js'
import { truncate } from '../../utils/format.js'
import { Clawd } from './Clawd.js'
import { FeedColumn } from './FeedColumn.js'
import {
  createRecentActivityFeed,
  createWhatsNewFeed,
  createProjectOnboardingFeed,
  createGuestPassesFeed,
} from './feedConfigs.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { resolveThemeSetting } from '../../utils/systemTheme.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import {
  isDebugMode,
  isDebugToStdErr,
  getDebugLogPath,
} from '../../utils/debug.js'
import { useEffect, useState } from 'react'
import {
  getSteps,
  shouldShowProjectOnboarding,
  incrementProjectOnboardingSeenCount,
} from '../../projectOnboardingState.js'
import { CondensedLogo } from './CondensedLogo.js'
import { OffscreenFreeze } from '../OffscreenFreeze.js'
import { checkForReleaseNotesSync } from '../../utils/releaseNotes.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { EmergencyTip } from './EmergencyTip.js'
import { VoiceModeNotice } from './VoiceModeNotice.js'
import { feature } from 'bun:bundle'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import {
  useShowGuestPassesUpsell,
  incrementGuestPassesSeenCount,
} from './GuestPassesUpsell.js'
import {
  useShowOverageCreditUpsell,
  incrementOverageCreditUpsellSeenCount,
  createOverageCreditFeed,
} from './OverageCreditUpsell.js'
import { useAppState } from '../../state/AppState.js'
import { getEffortSuffix } from '../../utils/effort.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { renderModelSetting } from '../../utils/model/model.js'

// Conditional require so ChannelsNotice.tsx tree-shakes when both flags are false.
/* eslint-disable @typescript-eslint/no-require-imports */
const ChannelsNoticeModule =
  feature('KAIROS') || feature('KAIROS_CHANNELS')
    ? (require('./ChannelsNotice.js') as typeof import('./ChannelsNotice.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

const LEFT_PANEL_MAX_WIDTH = 50

export function LogoV2(): React.ReactNode {
  const activities = getRecentActivitySync()
  const { columns } = useTerminalSize()
  const showOnboarding = shouldShowProjectOnboarding()
  const showSandboxStatus = SandboxManager.isSandboxingEnabled()
  const showGuestPassesUpsell = useShowGuestPassesUpsell()
  const showOverageCreditUpsell = useShowOverageCreditUpsell()
  const agent = useAppState(s => s.agent)
  const effortValue = useAppState(s => s.effortValue)

  // Rainbow animation for "Axiomate" brand text in border title
  const [rainbowOffset, setRainbowOffset] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setRainbowOffset(prev => prev + 1), 100)
    return () => clearInterval(timer)
  }, [])

  const config = getGlobalConfig()

  let changelog: string[]
  try {
    changelog = getRecentReleaseNotesSync(3)
  } catch {
    changelog = []
  }

  const [announcement] = useState(() => {
    const announcements = getInitialSettings().companyAnnouncements
    if (!announcements || announcements.length === 0) return undefined
    return config.numStartups === 1
      ? announcements[0]
      : announcements[Math.floor(Math.random() * announcements.length)]
  })
  const { hasReleaseNotes } = checkForReleaseNotesSync(
    config.lastReleaseNotesSeen,
  )

  useEffect(() => {
    const currentConfig = getGlobalConfig()
    if (currentConfig.lastReleaseNotesSeen === MACRO.VERSION) {
      return
    }
    saveGlobalConfig(current => {
      if (current.lastReleaseNotesSeen === MACRO.VERSION) return current
      return { ...current, lastReleaseNotesSeen: MACRO.VERSION }
    })
    if (showOnboarding) {
      incrementProjectOnboardingSeenCount()
    }
  }, [config, showOnboarding])

  const isCondensedMode =
    !hasReleaseNotes &&
    !showOnboarding &&
    !isEnvTruthy(process.env.CLAUDE_CODE_FORCE_FULL_LOGO)

  useEffect(() => {
    if (showGuestPassesUpsell && !showOnboarding && !isCondensedMode) {
      incrementGuestPassesSeenCount()
    }
  }, [showGuestPassesUpsell, showOnboarding, isCondensedMode])

  useEffect(() => {
    if (
      showOverageCreditUpsell &&
      !showOnboarding &&
      !showGuestPassesUpsell &&
      !isCondensedMode
    ) {
      incrementOverageCreditUpsellSeenCount()
    }
  }, [
    showOverageCreditUpsell,
    showOnboarding,
    showGuestPassesUpsell,
    isCondensedMode,
  ])

  const model = useMainLoopModel()
  const fullModelDisplayName = renderModelSetting(model)
  const {
    version,
    cwd,
    agentName: agentNameFromSettings,
  } = getLogoDisplayData()
  const agentName = agent ?? agentNameFromSettings
  const effortSuffix = getEffortSuffix(model, effortValue)
  const modelDisplayName = truncate(
    fullModelDisplayName + effortSuffix,
    LEFT_PANEL_MAX_WIDTH - 20,
  )

  // Show condensed logo if no new changelog and not showing onboarding
  if (isCondensedMode) {
    return (
      <>
        <CondensedLogo />
        <VoiceModeNotice />
        {ChannelsNoticeModule && <ChannelsNoticeModule.ChannelsNotice />}
        {isDebugMode() && (
          <Box paddingLeft={2} flexDirection="column">
            <Text color="warning">Debug mode enabled</Text>
            <Text dimColor>
              Logging to: {isDebugToStdErr() ? 'stderr' : getDebugLogPath()}
            </Text>
          </Box>
        )}
        <EmergencyTip />
        {announcement && (
          <Box paddingLeft={2} flexDirection="column">
            <Text>{announcement}</Text>
          </Box>
        )}
      </>
    )
  }

  // Calculate layout and display values
  const layoutMode = getLayoutMode(columns)

  const userTheme = resolveThemeSetting(getGlobalConfig().theme)
  const RAINBOW_KEYS: Array<keyof import('../../utils/theme.js').Theme> = [
    'rainbow_red', 'rainbow_orange', 'rainbow_yellow', 'rainbow_green',
    'rainbow_blue', 'rainbow_indigo', 'rainbow_violet',
  ]
  const rainbowAxiomate = [...'Axiomate'].map((ch, i) =>
    color(RAINBOW_KEYS[(i + rainbowOffset) % RAINBOW_KEYS.length], userTheme)(ch)
  ).join('')
  const borderTitle = ` ${rainbowAxiomate} ${color('inactive', userTheme)(`v${version}`)} `
  const compactBorderTitle = ` ${rainbowAxiomate} `

  // Early return for compact mode
  if (layoutMode === 'compact') {
    const layoutWidth = 4 // border + padding
    let welcomeMessage = formatWelcomeMessage(null)
    if (stringWidth(welcomeMessage) > columns - layoutWidth) {
      welcomeMessage = formatWelcomeMessage(null)
    }

    const cwdAvailableWidth = agentName
      ? columns - layoutWidth - 1 - stringWidth(agentName) - 3
      : columns - layoutWidth
    const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10))

    return (
      <>
        <OffscreenFreeze>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="claude"
            borderText={{
              content: compactBorderTitle,
              position: 'top',
              align: 'start',
              offset: 1,
            }}
            paddingX={1}
            paddingY={1}
            alignItems="center"
            width={columns}
          >
            <Box marginY={1}>
              <Clawd />
            </Box>
            <Text dimColor>{modelDisplayName}</Text>
            <Text dimColor>
              {agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd}
            </Text>
          </Box>
        </OffscreenFreeze>
        <VoiceModeNotice />
        {ChannelsNoticeModule && <ChannelsNoticeModule.ChannelsNotice />}
        {showSandboxStatus && (
          <Box marginTop={1} flexDirection="column">
            <Text color="warning">
              Your bash commands will be sandboxed. Disable with /sandbox.
            </Text>
          </Box>
        )}
      </>
    )
  }

  const welcomeMessage = formatWelcomeMessage(null)
  const modelLine = modelDisplayName
  const cwdAvailableWidth = agentName
    ? LEFT_PANEL_MAX_WIDTH - 1 - stringWidth(agentName) - 3
    : LEFT_PANEL_MAX_WIDTH
  const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10))
  const cwdLine = agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd
  const optimalLeftWidth = calculateOptimalLeftWidth(
    welcomeMessage,
    cwdLine,
    modelLine,
  )

  const { leftWidth, rightWidth } = calculateLayoutDimensions(
    columns,
    layoutMode,
    optimalLeftWidth,
  )

  return (
    <>
      <OffscreenFreeze>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="claude"
          borderText={{
            content: borderTitle,
            position: 'top',
            align: 'start',
            offset: 3,
          }}
        >
          <Box
            flexDirection={layoutMode === 'horizontal' ? 'row' : 'column'}
            paddingX={1}
            gap={1}
          >
            <Box
              flexDirection="column"
              width={leftWidth}
              justifyContent="space-between"
              alignItems="center"
              minHeight={9}
            >
              <Clawd />
              <Box flexDirection="column" alignItems="center">
                <Text dimColor>{modelLine}</Text>
                <Text dimColor>{cwdLine}</Text>
              </Box>
            </Box>

            {layoutMode === 'horizontal' && (
              <Box
                height="100%"
                borderStyle="single"
                borderColor="claude"
                borderDimColor
                borderTop={false}
                borderBottom={false}
                borderLeft={false}
              />
            )}

            {layoutMode === 'horizontal' && (
              <FeedColumn
                feeds={
                  showOnboarding
                    ? [
                        createProjectOnboardingFeed(getSteps()),
                        createRecentActivityFeed(activities),
                      ]
                    : showGuestPassesUpsell
                      ? [
                          createRecentActivityFeed(activities),
                          createGuestPassesFeed(),
                        ]
                      : showOverageCreditUpsell
                        ? [
                            createRecentActivityFeed(activities),
                            createOverageCreditFeed(),
                          ]
                        : [
                            createRecentActivityFeed(activities),
                            createWhatsNewFeed(changelog),
                          ]
                }
                maxWidth={rightWidth}
              />
            )}
          </Box>
        </Box>
      </OffscreenFreeze>
      <VoiceModeNotice />
      {ChannelsNoticeModule && <ChannelsNoticeModule.ChannelsNotice />}
      {isDebugMode() && (
        <Box paddingLeft={2} flexDirection="column">
          <Text color="warning">Debug mode enabled</Text>
          <Text dimColor>
            Logging to: {isDebugToStdErr() ? 'stderr' : getDebugLogPath()}
          </Text>
        </Box>
      )}
      <EmergencyTip />
      {announcement && (
        <Box paddingLeft={2} flexDirection="column">
          <Text>{announcement}</Text>
        </Box>
      )}
      {showSandboxStatus && (
        <Box paddingLeft={2} flexDirection="column">
          <Text color="warning">
            Your bash commands will be sandboxed. Disable with /sandbox.
          </Text>
        </Box>
      )}
    </>
  )
}
