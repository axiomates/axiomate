/**
 * Connector text block types -- a custom content block type used by the
 * Anthropic API (feature-gated behind CONNECTOR_TEXT).
 *
 * These are not part of the standard SDK types, so we define them here.
 */

/**
 * A content block of type `connector_text`, returned by the API when the
 * CONNECTOR_TEXT feature flag is enabled.
 */
export type ConnectorTextBlock = {
  type: 'connector_text'
  connector_text: string
}

/**
 * Streaming delta for a `connector_text` content block.
 */
export type ConnectorTextDelta = {
  type: 'connector_text_delta'
  connector_text: string
}

/**
 * Type guard: checks if a content block is a ConnectorTextBlock.
 */
export function isConnectorTextBlock(
  block: unknown,
): block is ConnectorTextBlock {
  return (
    block !== null &&
    typeof block === 'object' &&
    (block as Record<string, unknown>).type === 'connector_text'
  )
}
