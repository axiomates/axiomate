import { describe, expect, it } from 'vitest'

import { formatVendorTemplateForShow } from '../../../../commands/template/template.js'

describe('/template command helpers', () => {
  it('shows protocol vendor templates by name', () => {
    const result = formatVendorTemplateForShow('openai-chat', {})

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain('openai-chat')
    expect(result.text).toContain('"protocol": "openai-chat"')
    expect(result.text).toContain('"reasoning_effort"')
  })

  it('reports missing vendor templates', () => {
    expect(formatVendorTemplateForShow('does-not-exist', {})).toEqual({
      ok: false,
      message: "Vendor template 'does-not-exist' not found. Run /template vendor list.",
    })
  })
})
