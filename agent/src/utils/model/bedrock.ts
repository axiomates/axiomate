/**
 * Bedrock model ID utilities — stub for axiomate.
 * Only region prefix helpers are retained (used by agent.ts for subagent
 * model inheritance). Profile discovery and client creation are no-ops.
 */
import memoize from 'lodash-es/memoize.js'

export const getBedrockInferenceProfiles = memoize(
  async (): Promise<string[]> => [],
)

export function findFirstMatch(
  _profiles: string[],
  _substring: string,
): string | null {
  return null
}

export const getInferenceProfileBackingModel = memoize(
  async (_profileId: string): Promise<string | null> => null,
)

export function isFoundationModel(modelId: string): boolean {
  return modelId.startsWith('anthropic.')
}

export function extractModelIdFromArn(modelId: string): string {
  if (!modelId.startsWith('arn:')) return modelId
  const i = modelId.lastIndexOf('/')
  return i === -1 ? modelId : modelId.substring(i + 1)
}

const BEDROCK_REGION_PREFIXES = ['us', 'eu', 'apac', 'global'] as const
export type BedrockRegionPrefix = (typeof BEDROCK_REGION_PREFIXES)[number]

export function getBedrockRegionPrefix(
  modelId: string,
): BedrockRegionPrefix | undefined {
  const effective = extractModelIdFromArn(modelId)
  for (const prefix of BEDROCK_REGION_PREFIXES) {
    if (effective.startsWith(`${prefix}.anthropic.`)) return prefix
  }
  return undefined
}

export function applyBedrockRegionPrefix(
  modelId: string,
  prefix: BedrockRegionPrefix,
): string {
  const existing = getBedrockRegionPrefix(modelId)
  if (existing) return modelId.replace(`${existing}.`, `${prefix}.`)
  if (isFoundationModel(modelId)) return `${prefix}.${modelId}`
  return modelId
}

// Stub — axiomate does not use Bedrock runtime client
export async function createBedrockRuntimeClient(): Promise<any> {
  throw new Error('Bedrock runtime not available in axiomate')
}
