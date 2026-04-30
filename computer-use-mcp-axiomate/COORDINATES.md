# Computer-use coordinate spaces

Three coordinate spaces matter for click correctness. Every conversion
between them has a single, named owner. Touching the math? Check this
file first; the comments in the code reference these names.

## Spaces

```
                    image-px space         display coord pt          physical px
┌─────────────┐    ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐
│ AI's eyes   │ →  │ image dim    │    │ display.width    │    │ raw screen   │
│             │    │ ≤ 1920 long  │    │ × display.height │    │ pixels       │
└─────────────┘    └──────────────┘    └──────────────────┘    └──────────────┘
```

| Space | What it is | Example values (4K @ 200%) |
|-------|-----------|----------------------------|
| **image-px** | Pixel coords inside the JPEG sent to the model | (0, 0) – (1920, 1080) |
| **display coord pt** | Platform's native cursor coord space. **mac**: logical pt (what apps draw in). **win**: physical virtual-screen px (Per-Monitor V2 DPI-aware — `GetCursorPos`/`SendInput` operate in physical px) | mac: (0,0)–(1920,1080) / win: (0,0)–(3840,2160) |
| **physical px** | Raw GPU framebuffer pixels — what BitBlt copies | (0, 0) – (3840, 2160) |

On Windows, display-coord-pt and physical-px are the same space (both
physical virtual-screen pixels under Per-Monitor V2 DPI awareness). On
mac, display-coord-pt is logical and physical-px is the framebuffer.

`DisplayGeometry.width/height/originX/originY` carries the display-coord-pt
values for the active platform: logical on mac, physical on win. This
lets `scaleCoord` (cross-platform) output the correct coord space for
each platform without platform branches.

**Win32 DPI history**: before Phase 1 the Bun process was DPI-unaware,
so `SetCursorPos`/`GetCursorPos` returned logical pt. The old
COORDINATES.md documented "logical pt end-to-end" based on empirical
evidence from that era. Phase 1 flipped the process to Per-Monitor V2
DPI-aware via `SetProcessDpiAwarenessContext` in `ensure_dpi_aware()`
(lib.rs), which shifts all Win32 coord APIs to physical px.

## Conversion ownership

| Conversion | Owner | When |
|------------|-------|------|
| screen physical-px → image-px | win NAPI `capture_display_scaled` (BitBlt + Lanczos resize) | every win screenshot |
| screen physical-px → image-px | mac swift NAPI `captureExcluding` (CGImage + targetImageSize) | every mac screenshot |
| image-px → display-coord-pt | **scaleCoord** (mode = `pixels`) — `rawX * (display_W / image_W) + originX` | every click |
| display-coord-pt → cursor | win NAPI `move_cursor` (SendInput, takes physical px) | every win click |
| display-coord-pt → cursor | mac swift NAPI `moveMouse` / `mouseButton` (takes logical pt) | every mac click |

**Both paths are identity end-to-end after scaleCoord**: no `× scaleFactor` /
`÷ scaleFactor` anywhere. Coords stay in display-coord-pt space from
scaleCoord output through the platform's input API. The DPI difference
is absorbed by `DisplayGeometry` carrying the right values for each
platform.

## Coordinate modes

`CoordinateMode` (in `types.ts`) tells `scaleCoord` what convention the AI is using:

- **`pixels`** (default, both platforms) — AI emits in image-px space. scaleCoord multiplies by `display_W / image_W` to reach display-coord-pt. The AI only sees the downscaled image (≤1920 long edge) and operates entirely in that virtual resolution. The physical display resolution is never exposed to the AI.
- **`normalized_0_100`** — AI emits a percentage. scaleCoord multiplies by `display_W / 100`.

## Why this matters

Past bugs we fixed by being precise about which conversion happens where:

- `screenshotToLogical` divided by scaleFactor a SECOND time after `scaleCoord` already converted (commit 24b3112). Killed by deletion.
- nut.js silently no-op'd in Bun-compiled exes despite reporting "successful" cursor positions; mac path used its own swift NAPI, win was the only platform hitting nut.js (commit 5860ce7). Killed by replacing with direct Win32 SendInput / SetCursorPos.
- Image dim was forced to equal display logical dim as a hack to make scaleCoord identity, which broke for non-16:9 / non-200%-scaling screens (commit 850dc5a era). Killed by proper `pixels` mode with `display_W / image_W` scaling.
- Initial Win32 input wrapper assumed `SetCursorPos` takes physical px when the process was DPI-unaware, and `× scaleFactor`-multiplied the logical coords. This doubled all coords — killed by removing `logicalToPhysical` helper. Phase 1 then flipped to Per-Monitor V2 DPI-aware and made `DisplayGeometry` carry physical px, so the identity path works in physical space.

If you're tempted to add a `* scaleFactor` or `/ scaleFactor` somewhere,
ask: which space are the inputs in, which space should the outputs be in,
and is the conversion already done by one of the owners above? Prefer
extending an existing owner over inserting a new one. **Both platform
paths should be identity end-to-end** — there's no DPI math anywhere on
the input boundary in the executor.
