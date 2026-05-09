//! Windows native bindings for axiomate's computer-use suite.
//!
//! Stage 1 exposes four sync `#[napi]` functions used by the
//! winExecutor (TS) running on Windows:
//!
//! 1. `list_installed_apps` — registry walk over the standard 3 Uninstall
//!    keys (HKLM 64-bit, HKLM WoW6432 32-bit redirect, HKCU per-user) to
//!    feed `request_access` with installed-app candidates. macOS uses
//!    `mdfind` + `plutil` for this; Windows uses Add-Or-Remove-Programs.
//! 2. `app_under_point(p: VPoint)` — `WindowFromPoint` → owning pid → exe path.
//!    Used by the click safety gate to reject clicks landing on overlay
//!    windows that aren't in the user's allowlist.
//! 3. `find_window_displays(app_identifiers)` — for each requested app's
//!    visible windows, return the set of monitor indices its windows
//!    intersect. Mirrors the mac binding of the same name.
//! 4. `is_running_elevated` — reads the current process token's
//!    TokenElevation field. Used by winExecutor at startup to log a
//!    warn line when axiomate is launched as admin (not blocking, just
//!    diagnostic).
//!
//! Non-windows builds compile to a stub that returns empty/null/false
//! for every function, so the JS side's existing fallbacks engage
//! automatically (mirrors the mac-napi crate's pattern).

use napi_derive::napi;

#[cfg(target_os = "windows")]
mod esc_hook;

// ───────────────────────────────────────────────────────────────────────────
// Public NAPI types
// ───────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct InstalledApp {
    /// Stable identifier for the install. On Windows this is the registry
    /// sub-key name (often a GUID like `{ABCD-...}` or a product code).
    /// Treated as opaque by callers.
    pub app_identifier: String,
    pub display_name: String,
    /// Best-effort exe / install path. Empty when neither InstallLocation
    /// nor DisplayIcon yielded a usable path.
    pub path: String,
}

#[napi(object)]
pub struct AppHitInfo {
    /// Full exe path of the owning process — used as a stable identifier
    /// on Windows where there's no bundle-id concept analogous to mac.
    pub app_identifier: String,
    /// Basename of the exe (e.g. "chrome.exe") for display.
    pub display_name: String,
}

// ───────────────────────────────────────────────────────────────────────────
// VPoint / VSize / VRect — canonical virtual-screen coord types. PHYSICAL
// pixels in the Windows virtual-screen bounding box (multi-monitor; negative
// x/y permitted for monitors left/above the primary). The module is
// Per-Monitor V2 DPI-aware, so every Win32 coord-bearing API
// (`GetCursorPos`, `SendInput(MOUSEEVENTF_ABSOLUTE)` against
// `SM_*VIRTUALSCREEN`, `BitBlt` source rect, `GetCursorInfo`,
// `GetWindowRect`, `GetMonitorInfoW`) speaks these units uniformly.
//
// Exactly TWO code paths transform out of this coord system; everything
// else — including the NAPI-to-TS surface — speaks VPoint/VRect natively:
//   1. mouse-input simulation: `vpoint_to_normalized_absolute`
//      (VPoint → 0..65535 for `SendInput(MOUSEEVENTF_VIRTUALDESK)`).
//   2. screenshot scaling: Lanczos resize from a `VRect` source to the
//      JPEG output dims inside `capture_display_scaled`.
// `RECT → VRect` repacking after a Win32 syscall is NOT a transform —
// same coord system, different struct shape.
// ───────────────────────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Copy, Clone, Debug)]
pub struct VPoint {
    pub x: i32,
    pub y: i32,
}

#[napi(object)]
#[derive(Copy, Clone, Debug)]
pub struct VSize {
    pub w: u32,
    pub h: u32,
}

#[napi(object)]
#[derive(Copy, Clone, Debug)]
pub struct VRect {
    pub origin: VPoint,
    pub size: VSize,
}

impl VRect {
    pub fn new(x: i32, y: i32, w: u32, h: u32) -> Self {
        VRect {
            origin: VPoint { x, y },
            size: VSize { w, h },
        }
    }

    /// Half-open `[x, x+w) × [y, y+h)` overlap test against another VRect.
    /// Used by `find_window_monitor_rects` to test which monitors a given
    /// window's rect intersects.
    pub fn intersects(&self, other: &VRect) -> bool {
        let r1 = self.origin.x + self.size.w as i32;
        let b1 = self.origin.y + self.size.h as i32;
        let r2 = other.origin.x + other.size.w as i32;
        let b2 = other.origin.y + other.size.h as i32;
        self.origin.x < r2 && r1 > other.origin.x && self.origin.y < b2 && b1 > other.origin.y
    }
}

/// Win32 `RECT` → `VRect` at the syscall instant (after `GetWindowRect` /
/// `GetMonitorInfoW`). Same coord system (physical px, virtual-screen
/// space) — just struct repacking. Width/height clamped at 0 if right <
/// left (defensive against degenerate RECTs).
#[cfg(target_os = "windows")]
impl From<windows::Win32::Foundation::RECT> for VRect {
    fn from(r: windows::Win32::Foundation::RECT) -> Self {
        let w = (r.right - r.left).max(0) as u32;
        let h = (r.bottom - r.top).max(0) as u32;
        VRect {
            origin: VPoint {
                x: r.left,
                y: r.top,
            },
            size: VSize { w, h },
        }
    }
}

#[napi(object)]
pub struct WindowMonitorInfo {
    pub app_identifier: String,
    /// All monitor rects (`VRect` — virtual-screen physical px, same
    /// space as `node-screenshots` Monitor.x()/y()/width()/height() on
    /// Windows) whose bounds intersect any of this app's visible
    /// top-level window rects. The agent layer matches these against
    /// `node-screenshots` to recover the displayId — see
    /// winExecutor.findWindowDisplays. This decouples the win NAPI
    /// from node-screenshots' internal ID scheme (which derives from
    /// device path hash, not HMONITOR). Multi-monitor windows produce
    /// multiple rects (matches mac NAPI semantics — mac uses CGRect
    /// intersection across all CGDisplays).
    pub monitor_rects: Vec<VRect>,
}

/// JPEG image returned by capture_window. Same {base64, width, height}
/// shape as mac NAPI's CaptureWindowImage so the agent's screenshotWindow
/// adapter doesn't need a platform branch in the result handling.
#[napi(object)]
pub struct CaptureWindowImage {
    pub base64: String,
    pub width: i64,
    pub height: i64,
    /// Window's left edge in virtual-screen physical pixels.
    pub origin_x: i32,
    /// Window's top edge in virtual-screen physical pixels.
    pub origin_y: i32,
    /// Window's physical pixel width at capture time.
    pub display_width: i64,
    /// Window's physical pixel height at capture time.
    pub display_height: i64,
}

/// Outcome of capture_window. Mirrors mac NAPI exactly. `image` is null
/// when any step failed; `diagnostic` says why so the agent can surface
/// it via logForDebugging.
#[napi(object)]
pub struct CaptureWindowOutcome {
    pub image: Option<CaptureWindowImage>,
    pub diagnostic: String,
}

// CursorPos removed — `move_cursor` and `get_cursor_pos` now return
// `VPoint` directly: same coord system, same struct shape, one canonical
// type for virtual-screen physical-px coords.

/// Resized full-screen JPEG returned by capture_display_scaled. The
/// width/height fields are the post-resize dims (= target_w/target_h
/// the caller passed in, unless equal-to-source short-circuit fires).
/// scaleCoord on the agent side divides raw model coords by these
/// dims, so they MUST be the dims of the actual JPEG bytes the model
/// will see — which is why we resize in native code instead of letting
/// the API server do it (server-side resize would leave dims field
/// stale and break click coords; that bug was exactly what motivated
/// this binding — see plan file).
#[napi(object)]
pub struct DisplayCaptureResult {
    pub base64: String,
    pub width: i64,
    pub height: i64,
}

/// SoM (Set-of-Mark) overlay marker — one numbered red circle to draw on
/// the captured image. Used by `capture_display_scaled` when the agent
/// wants to highlight UI elements detected by `enumerate_ui_elements_in_rect`.
/// `(x, y)` is in the SAME coordinate space as `grid_origin_*` — i.e. the
/// virtual-coord space that the rulers label, NOT image pixels.
#[napi(object)]
pub struct MarkOverlay {
    pub id: u32,
    pub x: i32,
    pub y: i32,
}

/// One UI element returned by `enumerate_ui_elements_in_rect`. `bbox` is in
/// the same physical-pixel virtual-screen space as everything else in this
/// crate (VRect convention — see top of file).
#[napi(object)]
pub struct UiElement {
    pub bbox: VRect,
    /// UIAutomation `CurrentName` — control's accessible name. Empty when
    /// the control didn't expose one.
    pub name: String,
    /// Human-readable control type ("Button", "Edit", "MenuItem", ...).
    /// Mapped from the integer `UIA_*ControlTypeId`. "Unknown" if the
    /// type ID didn't match any of the standard values.
    pub role: String,
    /// UIAutomation `CurrentAutomationId` — stable per-control identifier
    /// when the app sets one. None when empty.
    pub automation_id: Option<String>,
    /// Which enumeration source produced this element:
    /// "taskbar", "desktop", or "foreground".
    pub uia_source: Option<String>,
}

// ───────────────────────────────────────────────────────────────────────────
// Public NAPI functions
// ───────────────────────────────────────────────────────────────────────────

#[napi]
pub fn list_installed_apps() -> napi::Result<Vec<InstalledApp>> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::list_installed_apps())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

#[napi]
pub fn app_under_point(p: VPoint) -> napi::Result<Option<AppHitInfo>> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::app_under_point(p))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = p;
        Ok(None)
    }
}

/// For each requested app identifier, return monitor RECTs (Win32 physical
/// pixel coords) that intersect any of that app's visible top-level
/// windows. The agent layer (winExecutor.findWindowDisplays) maps
/// these RECTs to `node-screenshots` displayIds by origin coord match
/// — that decouples this binding from node-screenshots' opaque
/// internal ID scheme (the integers it returns aren't HMONITORs).
///
/// Multi-monitor windows produce multiple rects (matches mac NAPI
/// semantics: mac intersects window rect against every CGDisplay).
/// Empty `monitor_rects` means the app has no visible top-level
/// windows on any monitor.
#[napi]
pub fn find_window_monitor_rects(
    app_identifiers: Vec<String>,
) -> napi::Result<Vec<WindowMonitorInfo>> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::find_window_monitor_rects(&app_identifiers))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(app_identifiers
            .into_iter()
            .map(|app_identifier| WindowMonitorInfo {
                app_identifier,
                monitor_rects: vec![],
            })
            .collect())
    }
}

#[napi]
pub fn is_running_elevated() -> bool {
    #[cfg(target_os = "windows")]
    {
        windows_impl::is_running_elevated()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Get the app identifier (full exe path) + display name (basename) of the
/// process owning the foreground window — Win32 fast path replacing the
/// PowerShell `Get-Process | Where-Object MainWindowHandle` approach in
/// apps.ts (~80ms → microseconds).
///
/// Returns None when GetForegroundWindow returns NULL (lock screen, UAC
/// secure desktop, no foreground process).
#[napi]
pub fn get_foreground_window() -> napi::Result<Option<AppHitInfo>> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::get_foreground_window())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}

/// Hide all currently-visible top-level windows owned by the given app.
/// `app_identifier` is the full exe path (e.g. `C:\\Program Files\\Slack\\Slack.exe`)
/// — same value as `app_under_point().appIdentifier` and `find_window_displays`
/// inputs. Returns true if at least one window was hidden.
///
/// Used by winExecutor's `prepareForAction` to clear non-allowlist apps
/// before a screenshot or click action. Mirror of mac
/// `NSRunningApplication.hide`. UIPI: non-elevated axiomate calling
/// ShowWindow on an admin-owned window silently fails (returns false) —
/// no UAC, no error. caller logs a warn but doesn't refuse the action.
#[napi]
pub fn hide_app(app_identifier: String) -> napi::Result<bool> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::set_app_visibility(&app_identifier, false))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app_identifier;
        Ok(false)
    }
}

/// Walk the parent process chain starting from the current process and
/// return the exe paths of every ancestor up to a hop limit. Used by
/// winExecutor.prepareForAction to add ALL ancestor exes to the
/// no-hide allowlist — covering the actual visible terminal window
/// owner, which may be several hops up (e.g. axiomate runs in node →
/// node spawned by bash → bash hosted by mintty → mintty has the
/// visible window). The shell itself (bash / pwsh / cmd) often runs
/// console-only and isn't in listRunningApps; the visible terminal
/// is up-chain.
///
/// Analogous to mac's `surrogateHost` but broader — instead of
/// guessing one terminal, we exempt every ancestor and let the
/// system-process deny-list inside hide_app filter out the truly
/// system-critical ancestors (services.exe, svchost.exe, etc).
///
/// Returns empty Vec when no ancestors can be walked.
#[napi]
pub fn get_host_ancestor_paths() -> napi::Result<Vec<String>> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::get_host_ancestor_paths())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

/// Inverse of `hide_app` — shows all currently-invisible top-level
/// windows owned by the given app. Used by cleanup.ts at turn-end to
/// restore the apps that prepareForAction hid. SW_SHOWNOACTIVATE so we
/// don't steal focus when restoring multiple apps.
#[napi]
pub fn unhide_app(app_identifier: String) -> napi::Result<bool> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::set_app_visibility(&app_identifier, true))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app_identifier;
        Ok(false)
    }
}

/// Capture the frontmost visible window of the given app. `app_identifier`
/// is the full exe path (same value as elsewhere in this crate). Returns
/// a structured outcome { image, diagnostic } that always carries a
/// human-readable diagnostic string (matches mac NAPI). Internally uses
/// PrintWindow with PW_RENDERFULLCONTENT — required for DWM-composited
/// windows (Chrome / Electron / WebView2 / modern Win32). BitBlt alone
/// would produce a black image for those.
///
/// On failure (no running window, PrintWindow returns 0, GetDIBits 0
/// rows copied, JPEG encode fails) image is None and diagnostic names
/// the failed step. Agent surfaces the diagnostic via logForDebugging,
/// same path as mac.
#[napi]
pub fn capture_window(
    app_identifier: String,
    grid_mode: Option<u32>,
    marks: Option<Vec<MarkOverlay>>,
) -> napi::Result<CaptureWindowOutcome> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::capture_window(
            &app_identifier,
            grid_mode.unwrap_or(0) as u8,
            marks,
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app_identifier, grid_mode, marks);
        Ok(CaptureWindowOutcome {
            image: None,
            diagnostic: "native binding not built for this platform".to_string(),
        })
    }
}

/// Full-screen capture of a single display, BitBlt'd from the desktop
/// DC and resized natively to (target_w, target_h) before JPEG encode.
///
/// This is the win counterpart to mac's `cu.screenshot.captureExcluding`
/// (the swift NAPI does the resize before returning). Pre-resizing here
/// — instead of letting the API server's image transcoder do it — keeps
/// `ScreenshotResult.width/height` aligned with the actual JPEG bytes
/// the model sees, which `scaleCoord` divides by to convert model coords
/// to logical screen pt. Without this, the client said "image is 3840"
/// but the server-resized version the model saw was 1568, and clicks
/// landed at 0.4× the right position. See COORDINATES.md.
///
/// Source rect `src` is a `VRect` — virtual-screen physical pixels
/// (multi-monitor bounding box; negative origin permitted for monitors
/// left/above the primary). The caller (TS-side `winExecutor`) reads
/// these straight from `node-screenshots` Monitor.x()/y()/width()/
/// height(), which are already physical px — no logical→physical
/// multiplication on the JS side either.
///
/// Returns `None` on failure (BitBlt 0 / GetDIBits 0 lines / encode
/// fails) — agent layer falls back to `base.screenshot` (unfiltered,
/// unresized; click coords will be off but better than no screenshot).
/// `jpeg_quality` is 0–100 (75 to match mac path's 0.75 default).
///
/// Phase 1 dropped the previous `logical_w/h` parameters: under
/// Per-Monitor V2 DPI awareness `GetCursorInfo` returns physical
/// virtual-screen px directly, so the cursor compositor doesn't need
/// the logical→physical bridge anymore.
#[napi]
pub fn capture_display_scaled(
    src: VRect,
    target_w: u32,
    target_h: u32,
    jpeg_quality: u32,
    grid_mode: Option<u32>,
    grid_origin_x: Option<i32>,
    grid_origin_y: Option<i32>,
    grid_range_w: Option<u32>,
    grid_range_h: Option<u32>,
    marks: Option<Vec<MarkOverlay>>,
) -> napi::Result<Option<DisplayCaptureResult>> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::capture_display_scaled(
            src,
            target_w,
            target_h,
            jpeg_quality.min(100) as u8,
            grid_mode.unwrap_or(0) as u8,
            grid_origin_x,
            grid_origin_y,
            grid_range_w,
            grid_range_h,
            marks,
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (
            src,
            target_w,
            target_h,
            jpeg_quality,
            grid_mode,
            grid_origin_x,
            grid_origin_y,
            grid_range_w,
            grid_range_h,
            marks,
        );
        Ok(None)
    }
}

/// Enumerate visible interactable UI elements within a screen rect using
/// IUIAutomation. Used by the click_target SoM (Set-of-Mark) overlay path:
/// when the AI zooms into a region inside an active click_target loop, the
/// system asks the OS for exact bboxes of buttons/menus/edits/etc. and
/// hands them back as numbered markers + structured text so the AI doesn't
/// have to estimate pixel positions from a downscaled image.
///
/// Scope: rooted at `IUIAutomation::GetRootElement` (the desktop), NOT the
/// foreground window — this is intentional so taskbar (`Shell_TrayWnd`),
/// system tray, and floating top-level windows are included. Without root
/// scope the "click QQ icon in taskbar" use case would never see the icon.
///
/// Filtering: `IsControlElement = true` removes pure-content nodes
/// (TextBlock, Image without click handler) so the result list stays
/// focused on actually-clickable surfaces. Capped at 50 results to bound
/// per-call latency on dense desktops.
///
/// Returns empty Vec on COM failure (apartment not init'd, IUIAutomation
/// unavailable on stripped Windows installs) — the agent layer treats
/// `[]` as "no marks available, fall back to ruler-based positioning"
/// gracefully.
#[napi]
pub async fn enumerate_ui_elements_in_rect(
    rect: VRect,
    window_only: Option<bool>,
) -> napi::Result<Vec<UiElement>> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::enumerate_ui_elements_in_rect(
            rect,
            window_only.unwrap_or(false),
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (rect, window_only);
        Ok(Vec::new())
    }
}

/// Allowlist-filtered full-screen capture. Windows analog of mac's
/// SCContentFilter (computer-use-mac-napi-axiomate's sc_capture). Both
/// are skeletons today — they return None so the agent's screenshot
/// path falls back to node-screenshots full-screen unfiltered capture.
///
/// Real implementation: Windows.Graphics.Capture (WGC) via the WinRT
/// bindings in `windows::Graphics::Capture` + a D3D11 device for the
/// frame buffer. WGC since Win10 1903. ~250 lines of COM lifetime +
/// async + D3D11 surface readback. The agent's
/// `CLI_CU_CAPABILITIES.screenshotFiltering` stays at 'none' until
/// the implementation lands and one platform's path is verified
/// end-to-end (mac SCContentFilter or this — whichever ships first
/// becomes the reference for the other).
///
/// Stage 3 placeholder. Don't touch until mac SCContentFilter has
/// shipped a working pipeline to mirror.
#[napi(object)]
pub struct CaptureExcludingOpts {
    pub allowed_app_identifiers: Vec<String>,
    pub display_id: i64,
    pub quality: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

#[napi(object)]
pub struct CaptureExcludingResult {
    pub base64: String,
    pub width: i64,
    pub height: i64,
}

#[napi]
pub fn capture_excluding(
    opts: CaptureExcludingOpts,
) -> napi::Result<Option<CaptureExcludingResult>> {
    // SKELETON — see doc comment above. Returning None lets the agent
    // layer fall back to node-screenshots full-screen capture.
    let _ = opts;
    Ok(None)
}

/// Move the cursor to a virtual-screen point.
///
/// **Coord space**: PHYSICAL pixels in the Windows virtual-screen
/// bounding box (`VPoint`). Negative x/y are fine for monitors
/// left/above the primary. The module is Per-Monitor V2 DPI-aware
/// (set at first-call init via `ensure_dpi_aware()`), so every Win32
/// coord-bearing API in this file — `GetCursorPos`,
/// `SendInput(MOUSEEVENTF_ABSOLUTE)` against `SM_*VIRTUALSCREEN`,
/// `BitBlt` source rect, `GetCursorInfo` — operates in physical
/// pixels uniformly. There are exactly two coord transforms in the
/// module: `vpoint_to_normalized_absolute` (VPoint → 0..65535 for
/// SendInput) and the screenshot Lanczos resize (VRect-source →
/// JPEG dims). Callers below the agent's `scaleCoord` boundary work
/// directly in `VPoint` / `VRect` — no DPI multiplication anywhere
/// inside this module.
///
/// The TS-side `winExecutor` converts the agent's logical screen pt
/// to physical pixels (via per-monitor `scaleFactor`) before calling
/// any napi entry point that takes coords. That single boundary keeps
/// the cross-platform `scaleCoord` contract logical while the Win
/// internals stay physical end-to-end.
///
/// Replaces nut.js's `mouse.move()` on Windows. nut.js has been
/// silently failing in Bun-compiled axiomate exes — standalone Node
/// moves the cursor fine, but in the packaged exe the move JS-resolves
/// without actually delivering to Win32 (suspected libnut .node
/// resolution / dlopen hiccup).
///
/// Implementation uses `SendInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE
/// | MOUSEEVENTF_VIRTUALDESK)` rather than `SetCursorPos`. The latter
/// updates the logical cursor coord but Win10/11 doesn't always redraw
/// the visible cursor for it — the click path historically masked this
/// because subsequent SendInput(LEFTDOWN/UP) forced the redraw, but
/// standalone mouse_move calls were leaving the visible cursor frozen.
/// SendInput goes through the same input pipeline as a physical mouse
/// and guarantees both the coord update and the visible redraw.
///
/// Returns the post-move cursor position from Win32 GetCursorPos —
/// agent uses this to verify the move actually landed (delta would be
/// zero on success, non-zero if Win32 clamped to a monitor edge / UAC
/// secure desktop is up / process lacks foreground rights).
#[napi]
pub fn move_cursor(p: VPoint) -> napi::Result<VPoint> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::move_cursor(p).map_err(|e| napi::Error::from_reason(e))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = p;
        Ok(VPoint { x: 0, y: 0 })
    }
}

/// Fire a mouse click at the current cursor position. Pre-position
/// the cursor with `move_cursor` first if you want to click somewhere
/// specific — splitting the move and click matches nut.js's API and
/// lets the agent log the intermediate cursor position for
/// diagnostics.
///
/// `button`: 0 = left, 1 = right, 2 = middle. `count`: 1 = single,
/// 2 = double, 3 = triple — fires DOWN+UP pairs back-to-back. The
/// system handles double-click timing detection itself; we just
/// deliver the events fast enough.
#[napi]
pub fn click_mouse(button: u32, count: u32) -> napi::Result<()> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::click_mouse(button, count).map_err(|e| napi::Error::from_reason(e))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (button, count);
        Ok(())
    }
}

/// Single mouse-button event (down or up alone) at the current cursor
/// position. `button`: 0=left, 1=right, 2=middle. Used by drag (down at
/// from, move, up at to), explicit mouseDown/Up tools, and the modifier-
/// click path in winExecutor (mods down → moveCursor → button down → up
/// → mods up). Pairs with `click_mouse` which is the press-and-release
/// shortcut.
#[napi]
pub fn mouse_button_event(button: u32, down: bool) -> napi::Result<()> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::mouse_button_event(button, down).map_err(|e| napi::Error::from_reason(e))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (button, down);
        Ok(())
    }
}

/// Mouse wheel scroll. `dx` and `dy` are wheel deltas; one tick is
/// 120 (Win32 WHEEL_DELTA constant). Positive `dy` scrolls up, negative
/// scrolls down. Positive `dx` scrolls right (HWHEEL). The agent
/// pre-positions the cursor with `move_cursor` before calling this so
/// the scroll event lands in the intended window.
#[napi]
pub fn mouse_scroll(dx: i32, dy: i32) -> napi::Result<()> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::mouse_scroll(dx, dy).map_err(|e| napi::Error::from_reason(e))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (dx, dy);
        Ok(())
    }
}

/// Single keyboard event (down or up) for a virtual-key code. `vk` is a
/// Win32 VK_* constant (VK_LWIN=0x5B, VK_CONTROL=0x11, VK_SHIFT=0x10,
/// VK_MENU=0x12, VK_RETURN=0x0D, etc; letters A-Z = 0x41-0x5A; digits
/// 0-9 = 0x30-0x39; F1-F24 = 0x70-0x87). `extended`: set for keys that
/// need the EXTENDED_KEY flag — arrows (VK_UP/DOWN/LEFT/RIGHT), numpad
/// vs main-row distinctions, right-side modifier keys. Most keys don't
/// need it.
///
/// Replaces nut.js's keyboard.pressKey on Windows. nut.js silently
/// drops events in Bun-compiled exes (same failure mode as mouse
/// events before commit 5860ce7); going through SendInput INPUT_KEYBOARD
/// directly avoids the libnut .node intermediate that fails to load.
///
/// Caller composes chord sequences (mods down → key down → key up →
/// mods up) by issuing multiple key_event calls. Each call is one
/// SendInput.
#[napi]
pub fn key_event(vk: u32, down: bool, extended: bool) -> napi::Result<()> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::key_event(vk, down, extended).map_err(|e| napi::Error::from_reason(e))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (vk, down, extended);
        Ok(())
    }
}

/// Type Unicode text. Each UTF-16 code unit is delivered via SendInput
/// INPUT_KEYBOARD with KEYEVENTF_UNICODE (vk=0, scan=code-unit). This
/// works for any Unicode character including non-BMP via surrogate pairs.
///
/// Used by winExecutor's `type` handler when not via clipboard. For
/// clipboard paste the agent goes through the system clipboard +
/// `key_event` for ctrl+v.
#[napi]
pub fn type_text_unicode(text: String) -> napi::Result<()> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::type_text_unicode(&text).map_err(|e| napi::Error::from_reason(e))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = text;
        Ok(())
    }
}

/// Win32 GetCursorPos — VPoint in virtual-screen physical-px space.
/// Used by the agent's post-click verification log and by tools that
/// need to report current cursor location (drag-from origin etc.).
#[napi]
pub fn get_cursor_pos() -> napi::Result<VPoint> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::get_cursor_pos().map_err(|e| napi::Error::from_reason(e))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(VPoint { x: 0, y: 0 })
    }
}

/// Enumerate currently-running apps that have at least one visible
/// top-level window. Returns each unique app once with its full exe
/// path as `app_identifier` (matching what `hide_app` / `find_window_displays`
/// expect), and the exe basename as `display_name`.
///
/// Equivalent of mac's `NSWorkspace.runningApplications` filtered to
/// `activationPolicy == .regular`, but exe-path-based instead of bundle-
/// id-based since Windows has no formal bundle identifier.
///
/// winExecutor uses this to drive `prepareForAction`'s hide loop —
/// PowerShell-based listRunningApps returns ProcessName ("chrome") which
/// doesn't match the exe-path appIdentifier model the rest of the win NAPI
/// uses. This binding keeps the appIdentifier space consistent.
#[napi]
pub fn list_running_apps() -> napi::Result<Vec<AppHitInfo>> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::list_running_apps())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Global Escape hotkey (WH_KEYBOARD_LL) — mirrors mac NAPI's CGEventTap.
// While registered, system-wide ESC keydown invokes the JS callback (turn
// abort) and is consumed before reaching any application — PI defense.
// See `esc_hook.rs` for the threading model + decay-window rationale.
// ───────────────────────────────────────────────────────────────────────────

/// Install the global ESC hook. Returns `true` if the hook is active and
/// the callback will fire on real user ESC; `false` if installation failed
/// (low-integrity desktop, hook count saturated, etc.) — caller falls back
/// to "no ESC abort, use Ctrl+C" UX.
///
/// Idempotent: calling again while already registered updates the callback
/// and returns true. Pair every successful register with `unregister` at
/// CU turn end so the worker thread + hook are released.
#[napi(ts_args_type = "callback: () => void")]
pub fn register_escape_hotkey(callback: napi::threadsafe_function::ThreadsafeFunction<()>) -> bool {
    #[cfg(target_os = "windows")]
    {
        esc_hook::register(callback)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = callback;
        false
    }
}

/// Tear down the global ESC hook + worker thread. Safe to call when not
/// registered (no-op).
#[napi]
pub fn unregister_escape_hotkey() {
    #[cfg(target_os = "windows")]
    {
        esc_hook::unregister();
    }
}

/// Open a 100ms window during which the next ESC keydown is treated as
/// model-synthesized (passed through to its target, no abort callback,
/// not consumed). Called by the executor immediately before injecting a
/// synthetic ESC via SendInput so our own hook doesn't abort our own turn.
#[napi]
pub fn notify_expected_escape() {
    #[cfg(target_os = "windows")]
    {
        esc_hook::notify_expected_escape();
    }
}

/// Keyboard-input foreground guard. SendInput INPUT_KEYBOARD events route to
/// whichever window has the keyboard focus at SendInput time. When the user
/// types a prompt in axiomate's terminal and submits, axiomate IS the
/// foreground window — so a model-synthesized `key("escape")` / `type(...)`
/// directly after submission would land in axiomate's terminal (cancelling
/// its own turn or typing nonsense into the input box).
///
/// macOS sidesteps this via `prepareForAction`: hide axiomate, bring
/// allowlisted apps forward. Windows has no such allowlist model, so we
/// take a lighter approach: if axiomate is currently foreground, walk the
/// Z-order via EnumWindows (which iterates top-to-bottom in Z-order on
/// Win 8+) and SetForegroundWindow to the first visible non-our-PID
/// window above a minimum size threshold (skipping toolbars / IME
/// indicators / system overlays). That's "the app the user was using
/// right before clicking into axiomate".
///
/// Returns true iff a switch happened. False means either:
///   - axiomate wasn't foreground (AI already clicked target → key flows
///     to the right place; nothing to do), or
///   - no suitable Z-order target found (only axiomate windows visible).
///
/// SetForegroundWindow's UIPI restrictions don't apply when switching AWAY
/// from ourselves — the calling process owns the current foreground.
///
/// Caller (winExecutor.ts) sleeps ~20ms after a true return to let the OS
/// process the focus change before SendInput fires; otherwise the keyboard
/// input can race the focus-change message and still land in axiomate.
#[napi]
pub fn defocus_self_to_previous_foreground() -> bool {
    #[cfg(target_os = "windows")]
    {
        windows_impl::defocus_self_to_previous_foreground()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Move focus away from axiomate's host windows toward the visible non-host
/// top-level window currently under the given screen point. Intended for zoom:
/// caller first moves axiomate off-screen, then asks us to foreground the app
/// actually under the zoom target instead of blindly restoring the previous
/// Z-order window.
#[napi]
pub fn focus_non_host_window_at_point(p: VPoint) -> bool {
    #[cfg(target_os = "windows")]
    {
        windows_impl::focus_non_host_window_at_point(p)
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Minimize every visible top-level window owned by any process in our
/// host chain (axiomate + ancestors: terminal, shell, etc). Stores the
/// HWNDs so `show_self_windows` can bring them back.
///
/// Returns the number of windows minimized. 0 means no host windows were
/// foreground-visible (or the platform doesn't support this).
#[napi]
pub fn hide_self_windows() -> u32 {
    #[cfg(target_os = "windows")]
    {
        windows_impl::hide_self_windows()
    }
    #[cfg(not(target_os = "windows"))]
    {
        0
    }
}

/// Restore every window previously minimized by `hide_self_windows`.
/// Idempotent — callers safely invoke this even when minimize returned 0.
#[napi]
pub fn show_self_windows() {
    #[cfg(target_os = "windows")]
    {
        windows_impl::show_self_windows();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // no-op
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Windows-specific implementations
// ───────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{
        AppHitInfo, CaptureWindowImage, CaptureWindowOutcome, DisplayCaptureResult, InstalledApp,
        MarkOverlay, UiElement, VPoint, VRect, WindowMonitorInfo,
    };
    use base64::Engine;
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::Path;

    use windows::core::{GUID, PROPVARIANT, VARIANT};
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, BOOL, ERROR_NO_MORE_ITEMS, HANDLE, HWND, LPARAM, POINT, RECT,
    };
    use windows::Win32::Graphics::Dwm::{DwmFlush, DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
        EnumDisplayMonitors, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HMONITOR, SRCCOPY,
    };
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
        HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY, REG_VALUE_TYPE,
    };
    use windows::Win32::System::Threading::{
        AttachThreadInput, GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId, OpenProcess,
        OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE,
        MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
        MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
        MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::{
        IPropertyStore, SHGetPropertyStoreForWindow, PROPERTYKEY,
    };
    use windows::Win32::UI::Shell::{IShellItem, SHCreateItemFromParsingName, SIGDN_NORMALDISPLAY};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, DrawIconEx, EnumWindows, FindWindowExW, FindWindowW, GetClassNameW,
        GetCursorInfo, GetCursorPos, GetForegroundWindow, GetIconInfo, GetSystemMetrics,
        GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        SetForegroundWindow, SetWindowPos, ShowWindow, WindowFromPoint, GWL_EXSTYLE,
        CURSORINFO, CURSOR_SHOWING, DI_NORMAL, HWND_TOP, ICONINFO, SHOW_WINDOW_CMD,
        SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
        SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
    };
    // UIAutomation — IUIAutomation::FindAll path used by enumerate_ui_elements_in_rect
    // for the SoM (Set-of-Mark) overlay. CUIAutomation is the COM CLSID;
    // IUIAutomation* are the COM interfaces; UIA_*PropertyId / UIA_*ControlTypeId
    // are typed constants windows-rs generated from the UIA TLB. We root at
    // GetRootElement (the desktop) so taskbar / Shell_TrayWnd are included —
    // foreground-window-scoped FindAll would miss them.
    use std::sync::{Mutex, OnceLock};
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, ExpandCollapseState_Collapsed, IUIAutomation, IUIAutomationCondition,
        IUIAutomationElement, IUIAutomationElementArray, IUIAutomationExpandCollapsePattern,
        TreeScope_Children, TreeScope_Subtree, UIA_AppBarControlTypeId, UIA_ButtonControlTypeId,
        UIA_CalendarControlTypeId, UIA_CheckBoxControlTypeId, UIA_ComboBoxControlTypeId,
        UIA_CustomControlTypeId, UIA_DataGridControlTypeId, UIA_DataItemControlTypeId,
        UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_ExpandCollapsePatternId,
        UIA_GroupControlTypeId, UIA_HeaderControlTypeId, UIA_HeaderItemControlTypeId,
        UIA_HyperlinkControlTypeId, UIA_ImageControlTypeId, UIA_IsControlElementPropertyId,
        UIA_ListControlTypeId, UIA_ListItemControlTypeId, UIA_MenuBarControlTypeId,
        UIA_MenuControlTypeId, UIA_MenuItemControlTypeId, UIA_PaneControlTypeId,
        UIA_ProgressBarControlTypeId, UIA_RadioButtonControlTypeId, UIA_ScrollBarControlTypeId,
        UIA_SemanticZoomControlTypeId, UIA_SeparatorControlTypeId, UIA_SliderControlTypeId,
        UIA_SpinnerControlTypeId, UIA_SplitButtonControlTypeId, UIA_StatusBarControlTypeId,
        UIA_TabControlTypeId, UIA_TabItemControlTypeId, UIA_TableControlTypeId,
        UIA_TextControlTypeId, UIA_TitleBarControlTypeId, UIA_ToolBarControlTypeId,
        UIA_ToolTipControlTypeId, UIA_TreeControlTypeId, UIA_TreeItemControlTypeId,
        UIA_WindowControlTypeId, UIA_CONTROLTYPE_ID,
    };

    // VPoint / VSize / VRect are crate-root #[napi(object)] types — see
    // top of file for the canonical-coord-system contract and the two
    // transform paths that live outside it.

    /// Per-Monitor V2 DPI awareness gate. Win32's coord APIs change unit
    /// (logical px → physical px) the moment this is called, so it must
    /// run before any cursor / virtual-screen / monitor-info call. Idempotent
    /// (Win32's SetProcessDpiAwarenessContext is one-shot per process; second
    /// call is a no-op error we ignore). All public napi entry points that
    /// touch coords call `ensure_dpi_aware()` first.
    static DPI_INITIALIZED: OnceLock<()> = OnceLock::new();
    pub fn ensure_dpi_aware() {
        DPI_INITIALIZED.get_or_init(|| unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        });
    }

    /// Localized message for the calling thread's last Win32 error +
    /// numeric HRESULT. Use immediately after a Win32 BOOL/handle return-
    /// failure path so the AI sees actionable text ("Access is denied")
    /// instead of opaque "GetLastError 0x80070005".
    ///
    /// Backed by `windows::core::Error::from_win32()` which captures
    /// GetLastError + lazily fetches the FormatMessage string.
    fn last_win_error() -> String {
        let err = windows::core::Error::from_win32();
        if err.code().0 == 0 {
            return "no last error set".to_string();
        }
        err.to_string()
    }

    /// True if the HWND is cloaked — Win10+ DWM hides windows on other
    /// virtual desktops (and a few app-cloaking edge cases) without
    /// clearing IsWindowVisible. `aumid_find_enum_proc` /
    /// `find_window_enum_proc` / `list_running_enum_proc` filter on this
    /// so multi-desktop UWP apps (Calculator open on desktop 2 while
    /// user is on desktop 1) don't surface as the "active" window.
    /// DwmGetWindowAttribute failure is treated as not-cloaked (the
    /// classic case — non-DWM-aware windows / VM hosts).
    fn is_window_cloaked(hwnd: HWND) -> bool {
        let mut cloaked: u32 = 0;
        let res = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as *mut _,
                std::mem::size_of::<u32>() as u32,
            )
        };
        res.is_ok() && cloaked != 0
    }

    /// PW_RENDERFULLCONTENT — render DWM-composited content (Chrome, Electron,
    /// WebView2). Without this, modern Windows apps capture as a black bitmap.
    /// 0x2 per Win32 docs (windows crate's PRINT_WINDOW_FLAGS is open enum).
    const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(0x2);

    /// PKEY_AppUserModel_ID — UWP windows have this property set to their
    /// AUMID (e.g. `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`). Lets us
    /// match a UWP-form appIdentifier against the visible HWND owned by
    /// ApplicationFrameHost.exe (the actual UWP-app process has no
    /// top-level visible HWND). Classic Win32 windows return VT_EMPTY.
    /// Format: SDK propkey.h — fmtid {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, pid 5.
    const PKEY_APPUSERMODEL_ID: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9F4C2855_9F79_4B39_A8D0_E1D42DE1D5F3),
        pid: 5,
    };

    // Per-thread COM refcount so we can pair `CoInitializeEx` with
    // `CoUninitialize` when the last guard on a thread drops.
    thread_local! {
        static COM_REFCOUNT: std::cell::RefCell<u32> = std::cell::RefCell::new(0);
    }

    /// RAII guard that calls `CoInitializeEx(STA)` when the first guard is
    /// created on a thread, and `CoUninitialize` when the last guard drops.
    struct ComGuard;

    impl ComGuard {
        fn init() -> Self {
            COM_REFCOUNT.with(|c| {
                let mut n = c.borrow_mut();
                if *n == 0 {
                    unsafe {
                        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                    }
                }
                *n += 1;
            });
            ComGuard
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            COM_REFCOUNT.with(|c| {
                let mut n = c.borrow_mut();
                *n -= 1;
                if *n == 0 {
                    unsafe {
                        CoUninitialize();
                    }
                }
            });
        }
    }

    /// Read PKEY_AppUserModel_ID off `hwnd`'s shell property store. UWP
    /// hosts (ApplicationFrameWindow / Windows.UI.Core.CoreWindow) have it
    /// set; classic Win32 windows return VT_EMPTY → PropVariantToStringAlloc
    /// fails with E_INVALIDARG → we surface None.
    fn get_aumid_for_window(hwnd: HWND) -> Option<String> {
        let _com = ComGuard::init();
        unsafe {
            let store: IPropertyStore = SHGetPropertyStoreForWindow(hwnd).ok()?;
            let value: PROPVARIANT = store.GetValue(&PKEY_APPUSERMODEL_ID).ok()?;
            // PropVariantToStringAlloc returns a CoTaskMemAlloc'd PWSTR.
            // Caller must CoTaskMemFree. windows-rs wraps the raw alloc as
            // PWSTR; .to_string() decodes UTF-16 to a Rust String, then we
            // free.
            let pwstr = PropVariantToStringAlloc(&value).ok()?;
            if pwstr.0.is_null() {
                return None;
            }
            let result = pwstr.to_string().ok();
            CoTaskMemFree(Some(pwstr.0 as _));
            result
        }
    }

    /// Resolve a Shell parsing name (e.g. `shell:AppsFolder\<AUMID>`) to its
    /// localized display name — same string Explorer / Start menu shows.
    /// Pure COM via `IShellItem::GetDisplayName(SIGDN_NORMALDISPLAY)` —
    /// no PowerShell, no Get-StartApps. Locale-correct, covers system /
    /// dev-mode / Start-menu apps uniformly.
    ///
    /// Used by `list_running_apps` to surface friendly names for UWP
    /// entries (the AUMID itself is unfriendly: e.g.
    /// `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App` vs `Calculator`).
    /// Returns None when SHCreateItemFromParsingName can't resolve the
    /// name (uninstalled / sideloaded with broken manifest); caller falls
    /// back to the AUMID itself.
    fn get_shell_display_name(parsing_name: &str) -> Option<String> {
        let _com = ComGuard::init();
        let wide = to_wide(parsing_name);
        unsafe {
            let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).ok()?;
            let pwstr = item.GetDisplayName(SIGDN_NORMALDISPLAY).ok()?;
            if pwstr.0.is_null() {
                return None;
            }
            let result = pwstr.to_string().ok();
            CoTaskMemFree(Some(pwstr.0 as _));
            result
        }
    }

    // ────────────── UIAutomation enumeration (SoM overlay) ──────────────

    /// Map a UIAutomation `UIA_*ControlTypeId` integer to a short
    /// human-readable role string. Falls through to "Unknown" for IDs we
    /// don't enumerate explicitly. The agent layer feeds these to VL as
    /// part of the per-mark structured-text item, so the names should be
    /// short and self-explanatory ("Button", "Edit", "MenuItem") rather
    /// than the raw int. Mirrors the strings WAI-ARIA / accessibility
    /// inspectors typically use.
    #[allow(non_upper_case_globals)]
    fn control_type_to_string(id: UIA_CONTROLTYPE_ID) -> &'static str {
        match id {
            UIA_ButtonControlTypeId => "Button",
            UIA_EditControlTypeId => "Edit",
            UIA_MenuItemControlTypeId => "MenuItem",
            UIA_HyperlinkControlTypeId => "Hyperlink",
            UIA_TextControlTypeId => "Text",
            UIA_ListItemControlTypeId => "ListItem",
            UIA_TabItemControlTypeId => "TabItem",
            UIA_CheckBoxControlTypeId => "CheckBox",
            UIA_ComboBoxControlTypeId => "ComboBox",
            UIA_RadioButtonControlTypeId => "RadioButton",
            UIA_ScrollBarControlTypeId => "ScrollBar",
            UIA_SliderControlTypeId => "Slider",
            UIA_SpinnerControlTypeId => "Spinner",
            UIA_StatusBarControlTypeId => "StatusBar",
            UIA_ToolBarControlTypeId => "ToolBar",
            UIA_TreeItemControlTypeId => "TreeItem",
            UIA_ImageControlTypeId => "Image",
            UIA_DocumentControlTypeId => "Document",
            UIA_PaneControlTypeId => "Pane",
            UIA_GroupControlTypeId => "Group",
            UIA_WindowControlTypeId => "Window",
            UIA_MenuControlTypeId => "Menu",
            UIA_MenuBarControlTypeId => "MenuBar",
            UIA_HeaderControlTypeId => "Header",
            UIA_HeaderItemControlTypeId => "HeaderItem",
            UIA_DataItemControlTypeId => "DataItem",
            UIA_DataGridControlTypeId => "DataGrid",
            UIA_TableControlTypeId => "Table",
            UIA_ToolTipControlTypeId => "ToolTip",
            UIA_TreeControlTypeId => "Tree",
            UIA_CalendarControlTypeId => "Calendar",
            UIA_ListControlTypeId => "List",
            UIA_TabControlTypeId => "Tab",
            UIA_SemanticZoomControlTypeId => "SemanticZoom",
            UIA_AppBarControlTypeId => "AppBar",
            UIA_TitleBarControlTypeId => "TitleBar",
            UIA_SeparatorControlTypeId => "Separator",
            UIA_ProgressBarControlTypeId => "ProgressBar",
            UIA_SplitButtonControlTypeId => "SplitButton",
            UIA_CustomControlTypeId => "Custom",
            _ => "Unknown",
        }
    }

    /// Return true when `candidate` is meaningfully visible on screen.
    ///
    /// UIA's `CurrentIsOffscreen=false` is too weak for some controls:
    /// collapsed dropdown options and similar virtualized descendants can
    /// still remain in the tree with plausible bounding boxes. To approximate
    /// "the user can currently see this element", sample a few points inside
    /// the bbox and require UIA hit-testing at one of those points to land on
    /// the element itself or within its subtree.
    ///
    /// This intentionally rejects elements whose bbox exists only in the UIA
    /// tree but whose pixels are not currently painted at those sample points.
    unsafe fn is_uia_element_hit_visible(
        automation: &IUIAutomation,
        candidate: &IUIAutomationElement,
        bbox: &VRect,
    ) -> bool {
        if bbox.size.w == 0 || bbox.size.h == 0 {
            return false;
        }

        let sample_xs = if bbox.size.w <= 2 {
            [bbox.origin.x, bbox.origin.x, bbox.origin.x]
        } else {
            let x0 = bbox.origin.x;
            let x1 = bbox.origin.x + bbox.size.w as i32 - 1;
            [
                x0 + ((bbox.size.w as i32 - 1) / 2),
                x0 + ((bbox.size.w as i32 - 1) / 4),
                x1 - ((bbox.size.w as i32 - 1) / 4),
            ]
        };
        let sample_ys = if bbox.size.h <= 2 {
            [bbox.origin.y, bbox.origin.y, bbox.origin.y]
        } else {
            let y0 = bbox.origin.y;
            let y1 = bbox.origin.y + bbox.size.h as i32 - 1;
            [
                y0 + ((bbox.size.h as i32 - 1) / 2),
                y0 + ((bbox.size.h as i32 - 1) / 4),
                y1 - ((bbox.size.h as i32 - 1) / 4),
            ]
        };

        let walker = match automation.RawViewWalker() {
            Ok(w) => w,
            Err(_) => return true, // best-effort: don't drop everything if walker unavailable
        };

        for x in sample_xs {
            for y in sample_ys {
                let hit = match automation.ElementFromPoint(POINT { x, y }) {
                    Ok(h) => h,
                    Err(_) => continue,
                };

                if automation
                    .CompareElements(&hit, candidate)
                    .map(|same| same.as_bool())
                    .unwrap_or(false)
                {
                    return true;
                }

                let mut cur = hit;
                for _ in 0..MAX_UIA_TREE_DEPTH {
                    if automation
                        .CompareElements(&cur, candidate)
                        .map(|same| same.as_bool())
                        .unwrap_or(false)
                    {
                        return true;
                    }
                    let parent = match walker.GetParentElement(&cur) {
                        Ok(p) => p,
                        Err(_) => break,
                    };
                    cur = parent;
                }
            }
        }

        false
    }

    /// Enumerate UI elements whose bounding rect is mostly contained in
    /// `rect`. Caps at 50 to bound latency on busy desktops.
    ///
    /// Strategy — `IUIAutomation::FindAll(TreeScope_Subtree)` from the
    /// desktop root does NOT reliably reach into modern app processes
    /// (Win11 taskbar lives in StartMenuExperienceHost.exe; UIA's cross-
    /// process proxy only surfaces top-level Window/Pane containers, not
    /// deeper Buttons). Workaround: enumerate THREE specific subtrees
    /// individually via `ElementFromHandle`, dedup by bbox:
    ///   1. `Shell_TrayWnd` — the taskbar (covers "click X in taskbar").
    ///   2. The foreground window — covers app controls in zoom region.
    ///   3. The desktop root's direct children — fallback for popups /
    ///      context menus / floating windows not under the above two.
    ///
    /// Filtering — for each candidate:
    ///   - bbox must overlap `rect` AND ≥50% of bbox area must lie inside
    ///     `rect`. Catches taskbar buttons (small, fully contained); rejects
    ///     whole-screen Window/Pane containers whose bbox technically
    ///     intersects the input rect but whose useful pixels are far outside.
    ///   - exclude container roles (Window, Pane, Group, Document, TitleBar)
    ///     since they're not actually clickable targets.
    ///
    /// Returns `Vec::new()` on any COM failure — caller treats empty as
    /// "no marks available, fall back to ruler positioning".
    /// System-chrome element caps — independent from regular cap so a
    /// dense foreground window doesn't starve taskbar/desktop icon detection.
    const TASKBAR_CAP: usize = 20;
    const DESKTOP_CAP: usize = 30;
    const REGULAR_CAP: usize = 50;

    /// Enumerate UI elements whose bounding rect is mostly contained in
    /// `rect`. System-chrome sources (taskbar, desktop icons) enumerate first
    /// with independent caps so they're never starved by foreground controls.
    ///
    /// Strategy — four specific subtrees via `ElementFromHandle`, dedup by bbox:
    ///   1. (system chrome) `Shell_TrayWnd` — taskbar icon container.
    ///   2. (system chrome) `Progman`/`WorkerW` → `SysListView32` — desktop icons.
    ///   3. Foreground window — app controls in zoom region.
    ///   4. Desktop root's direct children — fallback for popups/context menus.
    ///
    /// Filtering (all sources, unified):
    ///   - bbox must overlap `rect` AND ≥50% of bbox area inside `rect`.
    ///   - exclude container roles (Window, Pane, Group, Document, TitleBar).
    /// Out-of-bounds elements `continue` and don't consume the source's cap.

    pub fn enumerate_ui_elements_in_rect(rect: VRect, window_only: bool) -> Vec<UiElement> {
        ensure_dpi_aware();
        let _com = ComGuard::init();
        unsafe {
            let automation: IUIAutomation =
                match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
                    Ok(a) => a,
                    Err(_) => return Vec::new(),
                };
            let true_var: VARIANT = VARIANT::from(true);
            let condition: IUIAutomationCondition = match automation
                .CreatePropertyCondition(UIA_IsControlElementPropertyId, &true_var)
            {
                Ok(c) => c,
                Err(_) => return Vec::new(),
            };

            let mut results: Vec<UiElement> = Vec::new();
            let mut seen: BTreeSet<(i32, i32, u32, u32)> = BTreeSet::new();

            // ── System chrome sources (enumerate first, independent caps) ──

            if !window_only {
                // Source 1: Taskbar icons — Shell_TrayWnd.
                let taskbar_class = to_wide("Shell_TrayWnd");
                if let Ok(hwnd) = FindWindowW(PCWSTR(taskbar_class.as_ptr()), PCWSTR::null()) {
                    if !hwnd.0.is_null() {
                        if let Ok(el) = automation.ElementFromHandle(hwnd) {
                            if let Ok(arr) = el.FindAll(TreeScope_Subtree, &condition) {
                                let before = results.len();
                                collect_into(
                                    &automation,
                                    &arr,
                                    &rect,
                                    &mut results,
                                    &mut seen,
                                    TASKBAR_CAP,
                                );
                                for r in &mut results[before..] {
                                    r.uia_source = Some("taskbar".to_string());
                                }
                            }
                        }
                    }
                }
            } // !window_only

            // ── Regular sources (enumerate after system chrome) ──

            // Source 3: Foreground window subtree — app controls in zoom region.
            // Caller already moved axiomate off-screen; now prefer the real
            // window under the zoom target instead of blindly restoring the
            // previous Z-order window.
            let center = POINT {
                x: rect.origin.x + (rect.size.w as i32 / 2),
                y: rect.origin.y + (rect.size.h as i32 / 2),
            };
            focus_non_host_window_at_point(VPoint {
                x: center.x,
                y: center.y,
            });
            std::thread::sleep(std::time::Duration::from_millis(50));
            let cur_fg = GetForegroundWindow();
            if !cur_fg.0.is_null() {
                let mut fg_pid: u32 = 0;
                GetWindowThreadProcessId(cur_fg, Some(&mut fg_pid));
                let is_host = fg_pid != 0 && host_pid_set().contains(&fg_pid);
                if !is_host {
                    if let Ok(el) = automation.ElementFromHandle(cur_fg) {
                        if let Ok(arr) = el.FindAll(TreeScope_Subtree, &condition) {
                            let before = results.len();
                            collect_into(
                                &automation,
                                &arr,
                                &rect,
                                &mut results,
                                &mut seen,
                                REGULAR_CAP,
                            );
                            for r in &mut results[before..] {
                                r.uia_source = Some("foreground".to_string());
                            }
                        }
                    }
                }
            }

            if !window_only {
                // Source 2: Desktop icons — enumerate, then keep only icons
                // whose center point hits the desktop itself (Progman/WorkerW)
                // via WindowFromPoint. Icons covered by other windows are
                // dropped. No class-name, area-ratio, or cloak heuristics.
                {
                    let before = results.len();
                    enumerate_desktop_icons(
                        &automation,
                        &condition,
                        &rect,
                        &mut results,
                        &mut seen,
                    );
                    let mut kept_new: Vec<UiElement> = results
                        .drain(before..)
                        .filter(|el| {
                            let cx = el.bbox.origin.x + (el.bbox.size.w as i32 / 2);
                            let cy = el.bbox.origin.y + (el.bbox.size.h as i32 / 2);
                            let hit = WindowFromPoint(POINT { x: cx, y: cy });
                            if hit.0.is_null() {
                                return false;
                            }
                            let mut cls = [0u16; 32];
                            let len = GetClassNameW(hit, &mut cls) as usize;
                            if len == 0 {
                                return false;
                            }
                            let cls_str = String::from_utf16_lossy(&cls[..len.min(32)]);
                            let cls_str = cls_str.trim_end_matches('\0');
                            cls_str == "Progman"
                                || cls_str == "WorkerW"
                                || cls_str == "SHELLDLL_DefView"
                                || cls_str == "SysListView32"
                        })
                        .collect();
                    for r in &mut kept_new {
                        r.uia_source = Some("desktop".to_string());
                    }
                    results.append(&mut kept_new);
                }

                // Source 4 (fallback): desktop root's direct children — covers
                // floating popups / context menus / system tray flyouts that
                // aren't subtrees of the foreground app or the above sources.
                if let Ok(root) = automation.GetRootElement() {
                    if let Ok(arr) = root.FindAll(TreeScope_Children, &condition) {
                        let before = results.len();
                        collect_into(
                            &automation,
                            &arr,
                            &rect,
                            &mut results,
                            &mut seen,
                            REGULAR_CAP,
                        );
                        for r in &mut results[before..] {
                            r.uia_source = Some("foreground".to_string());
                        }
                    }
                }
            } // !window_only

            results
        }
    }

    /// Walk Progman (or WorkerW fallback) → SHELLDLL_DefView → SysListView32
    /// to enumerate desktop icon list items.
    ///
    /// On some multi-monitor / fullscreen-app configurations, the desktop
    /// icon view is hosted by a `WorkerW` window instead of `Progman`.
    /// We try Progman first; if it lacks a `SHELLDLL_DefView` child, we
    /// enumerate all `WorkerW` windows to find the one that hosts it.
    unsafe fn enumerate_desktop_icons(
        automation: &IUIAutomation,
        condition: &IUIAutomationCondition,
        rect: &VRect,
        results: &mut Vec<UiElement>,
        seen: &mut BTreeSet<(i32, i32, u32, u32)>,
    ) {
        let progman_class = to_wide("Progman");
        if let Ok(hwnd) = FindWindowW(PCWSTR(progman_class.as_ptr()), PCWSTR::null()) {
            if !hwnd.0.is_null() {
                let defview_class = to_wide("SHELLDLL_DefView");
                let child = FindWindowExW(
                    hwnd,
                    HWND::default(),
                    PCWSTR(defview_class.as_ptr()),
                    PCWSTR::null(),
                );
                if let Ok(child_hwnd) = child {
                    if !child_hwnd.0.is_null() {
                        if enumerate_listview_icons(
                            automation, condition, rect, results, seen, hwnd,
                        ) {
                            return; // Progman worked.
                        }
                    }
                }
            }
        }
        // Fallback: enumerate WorkerW windows to find the one hosting
        // SHELLDLL_DefView.
        let worker_class = to_wide("WorkerW");
        let mut hwnd = FindWindowW(PCWSTR(worker_class.as_ptr()), PCWSTR::null());
        while let Ok(cur) = hwnd {
            if cur.0.is_null() {
                break;
            }
            let defview_class = to_wide("SHELLDLL_DefView");
            let child = FindWindowExW(
                cur,
                HWND::default(),
                PCWSTR(defview_class.as_ptr()),
                PCWSTR::null(),
            );
            if let Ok(child_hwnd) = child {
                if !child_hwnd.0.is_null() {
                    if enumerate_listview_icons(automation, condition, rect, results, seen, cur) {
                        return; // Found the right WorkerW.
                    }
                }
            }
            hwnd = FindWindowExW(
                HWND::default(),
                cur,
                PCWSTR(worker_class.as_ptr()),
                PCWSTR::null(),
            );
        }
    }

    /// Enumerate SysListView32 icon items under a desktop host window
    /// (Progman or WorkerW). Returns true if enumeration succeeded.
    unsafe fn enumerate_listview_icons(
        automation: &IUIAutomation,
        condition: &IUIAutomationCondition,
        rect: &VRect,
        results: &mut Vec<UiElement>,
        seen: &mut BTreeSet<(i32, i32, u32, u32)>,
        host_hwnd: HWND,
    ) -> bool {
        // Walk: host → SHELLDLL_DefView → SysListView32
        let defview_class = to_wide("SHELLDLL_DefView");
        let defview = match FindWindowExW(
            host_hwnd,
            HWND::default(),
            PCWSTR(defview_class.as_ptr()),
            PCWSTR::null(),
        ) {
            Ok(h) if !h.0.is_null() => h,
            _ => return false,
        };
        let listview_class = to_wide("SysListView32");
        let listview = match FindWindowExW(
            defview,
            HWND::default(),
            PCWSTR(listview_class.as_ptr()),
            PCWSTR::null(),
        ) {
            Ok(h) if !h.0.is_null() => h,
            _ => return false,
        };
        // Get UIA element for SysListView32 and enumerate its children
        // (each child is a ListItem representing one desktop icon).
        if let Ok(el) = automation.ElementFromHandle(listview) {
            if let Ok(arr) = el.FindAll(TreeScope_Children, condition) {
                collect_into(&automation, &arr, rect, results, seen, DESKTOP_CAP);
                return true;
            }
        }
        false
    }

    /// Iterate `array` and append qualifying elements to `results`.
    ///
    /// `cap` — max elements this source may contribute. The source stops
    /// once it has added `cap` elements; out-of-bounds elements `continue`
    /// without consuming quota. Containment + role filters applied uniformly.
    ///
    /// `seen` dedups by bbox tuple — same element can appear in multiple
    /// subtree walks (foreground window often shows up under the desktop
    /// root's children too).
    #[allow(non_upper_case_globals)]
    unsafe fn collect_into(
        automation: &IUIAutomation,
        array: &IUIAutomationElementArray,
        rect: &VRect,
        results: &mut Vec<UiElement>,
        seen: &mut BTreeSet<(i32, i32, u32, u32)>,
        cap: usize,
    ) {
        let count = match array.Length() {
            Ok(c) => c,
            Err(_) => return,
        };
        let start_count = results.len();
        for i in 0..count {
            let contributed = results.len() - start_count;
            if contributed >= cap {
                return;
            }
            let el: IUIAutomationElement = match array.GetElement(i) {
                Ok(e) => e,
                Err(_) => continue,
            };
            let bbox_rect = match el.CurrentBoundingRectangle() {
                Ok(r) => r,
                Err(_) => continue,
            };
            let bbox: VRect = bbox_rect.into();
            if bbox.size.w == 0 || bbox.size.h == 0 {
                continue;
            }
            if !bbox.intersects(rect) {
                continue;
            }
            // Containment: at least 50% of bbox area must lie inside `rect`.
            let intersect_w = ((bbox.origin.x + bbox.size.w as i32)
                .min(rect.origin.x + rect.size.w as i32)
                - bbox.origin.x.max(rect.origin.x))
            .max(0) as u64;
            let intersect_h = ((bbox.origin.y + bbox.size.h as i32)
                .min(rect.origin.y + rect.size.h as i32)
                - bbox.origin.y.max(rect.origin.y))
            .max(0) as u64;
            let intersect_area = intersect_w * intersect_h;
            let bbox_area = (bbox.size.w as u64) * (bbox.size.h as u64);
            if bbox_area == 0 || (intersect_area * 2) < bbox_area {
                continue;
            }
            // CurrentIsOffscreen catches scrolled-out-of-view items.
            if el
                .CurrentIsOffscreen()
                .map(|v| v.as_bool())
                .unwrap_or(false)
            {
                continue;
            }
            if !is_uia_element_hit_visible(automation, &el, &bbox) {
                continue;
            }
            // Walk ancestors: if any has ExpandCollapseState.Collapsed,
            // this element is inside a collapsed container (ComboBox
            // dropdown, menu, tree node) and is not visible.
            // Role + ExpandCollapse filtering: compute role_id once,
            // shared by the ExpandCollapse type guard and the container
            // role exclusion below.
            let role_id = el.CurrentControlType().unwrap_or(UIA_CustomControlTypeId);

            // ExpandCollapse ancestor check — only for dropdown/expand types.
            if matches!(
                role_id,
                UIA_DataItemControlTypeId
                    | UIA_ListItemControlTypeId
                    | UIA_MenuItemControlTypeId
                    | UIA_TreeItemControlTypeId
            ) {
                let mut ancestor = el.clone();
                let mut collapsed = false;
                for _ in 0..MAX_UIA_TREE_DEPTH {
                    if ancestor
                        .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                            UIA_ExpandCollapsePatternId,
                        )
                        .ok()
                        .and_then(|p| p.CurrentExpandCollapseState().ok())
                        .map(|s| s == ExpandCollapseState_Collapsed)
                        .unwrap_or(false)
                    {
                        collapsed = true;
                        break;
                    }
                    let parent = automation
                        .RawViewWalker()
                        .ok()
                        .and_then(|w| w.GetParentElement(&ancestor).ok());
                    match parent {
                        Some(p) => ancestor = p,
                        None => break,
                    }
                }
                if collapsed {
                    continue;
                }
            }

            // Role-based exclusion: skip pure-container/decorative types.
            if matches!(
                role_id,
                UIA_WindowControlTypeId
                    | UIA_PaneControlTypeId
                    | UIA_GroupControlTypeId
                    | UIA_DocumentControlTypeId
                    | UIA_TitleBarControlTypeId
                    | UIA_AppBarControlTypeId
                    | UIA_MenuBarControlTypeId
                    | UIA_SeparatorControlTypeId
                    | UIA_SemanticZoomControlTypeId
                    | UIA_TreeControlTypeId
                    | UIA_TableControlTypeId
                    | UIA_DataGridControlTypeId
                    | UIA_ListControlTypeId
                    | UIA_MenuControlTypeId
                    | UIA_TabControlTypeId
                    | UIA_StatusBarControlTypeId
            ) {
                continue;
            }
            let key = (bbox.origin.x, bbox.origin.y, bbox.size.w, bbox.size.h);
            if seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            let name = el
                .CurrentName()
                .ok()
                .map(|s| s.to_string())
                .unwrap_or_default();
            let role = control_type_to_string(role_id).to_string();
            let automation_id = el
                .CurrentAutomationId()
                .ok()
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            results.push(UiElement {
                bbox,
                name,
                role,
                automation_id,
                uia_source: None, // set by caller via slice
            });
        }
    }

    // ────────────── 1. list_installed_apps ──────────────

    /// The three registry roots the Add-Or-Remove-Programs snap-in walks.
    /// Each (root, view) pair hits a different physical key — HKLM 64-bit
    /// view, HKLM 32-bit redirect view (WoW6432Node), HKCU per-user.
    const UNINSTALL_ROOTS: &[(HKEY, u32)] = &[
        (HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY.0),
        (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY.0),
        (HKEY_CURRENT_USER, 0),
    ];

    const UNINSTALL_SUBKEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

    pub fn list_installed_apps() -> Vec<InstalledApp> {
        let mut out: Vec<InstalledApp> = Vec::new();
        // Dedupe by exe path (lower-cased) — same app installed under
        // multiple registry sub-keys (e.g. `Slack` + `{GUID}_is1`
        // installer variant) collapses to one entry. Same app in
        // 64-bit and 32-bit views also collapses.
        let mut seen_paths: BTreeSet<String> = BTreeSet::new();
        for (root, view_flag) in UNINSTALL_ROOTS {
            collect_from_root(*root, *view_flag, &mut out, &mut seen_paths);
        }
        out
    }

    fn collect_from_root(
        root: HKEY,
        view_flag: u32,
        out: &mut Vec<InstalledApp>,
        seen_paths: &mut BTreeSet<String>,
    ) {
        let access = windows::Win32::System::Registry::REG_SAM_FLAGS(KEY_READ.0 | view_flag);
        let subkey_w = to_wide(UNINSTALL_SUBKEY);
        let mut hkey = HKEY::default();
        unsafe {
            if RegOpenKeyExW(root, PCWSTR(subkey_w.as_ptr()), 0, access, &mut hkey).is_err() {
                return;
            }
        }
        // Iterate sub-keys until ERROR_NO_MORE_ITEMS.
        let mut idx = 0u32;
        loop {
            let mut name_buf = [0u16; 256];
            let mut name_len = name_buf.len() as u32;
            let res = unsafe {
                RegEnumKeyExW(
                    hkey,
                    idx,
                    PWSTR(name_buf.as_mut_ptr()),
                    &mut name_len,
                    None,
                    PWSTR::null(),
                    None,
                    None,
                )
            };
            if res == ERROR_NO_MORE_ITEMS {
                break;
            }
            if res.is_err() {
                break;
            }
            idx += 1;
            let sub_name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
            // Open sub-key, read DisplayName / InstallLocation / DisplayIcon.
            let sub_path = format!("{}\\{}", UNINSTALL_SUBKEY, sub_name);
            let sub_w = to_wide(&sub_path);
            let mut sub_hkey = HKEY::default();
            unsafe {
                if RegOpenKeyExW(root, PCWSTR(sub_w.as_ptr()), 0, access, &mut sub_hkey).is_err() {
                    continue;
                }
            }
            let display_name = read_string_value(sub_hkey, "DisplayName").unwrap_or_default();
            // InstallLocation read but unused after the appIdentifier-unification:
            // we now require a launchable .exe path, which only DisplayIcon
            // reliably gives. InstallLocation is typically a folder.
            // Kept here for future use (debug logs, "where is this app?"
            // surface) — drop with `let _` to silence unused warn.
            let _install_location =
                read_string_value(sub_hkey, "InstallLocation").unwrap_or_default();
            let display_icon = read_string_value(sub_hkey, "DisplayIcon").unwrap_or_default();
            unsafe {
                let _ = RegCloseKey(sub_hkey);
            }
            // Skip rows without a usable display name — they're typically
            // hotfixes / runtime components, not user-facing apps.
            if display_name.is_empty() {
                continue;
            }
            // Resolve an exe path. We REQUIRE one — entries without a
            // launchable .exe path don't go into the list, because their
            // app_identifier (= path, see below) wouldn't round-trip with
            // app_under_point / list_running_apps which always return
            // full exe paths. Filtering also drops ~700 noise entries
            // (Windows Updates / runtime components / uninstall stubs).
            let icon_path = normalize_display_icon(&display_icon);
            let path = if !icon_path.is_empty() && icon_path.to_lowercase().ends_with(".exe") {
                icon_path
            } else {
                continue;
            };
            // Reject paths that are bare basenames (e.g. "msiexec.exe")
            // — those don't round-trip with app_under_point's full-path
            // outputs and aren't launchable targets the user means.
            if !path.contains('\\') && !path.contains('/') {
                continue;
            }
            // Reject obvious uninstaller stubs. The Uninstall registry
            // hive includes per-app uninstallers under the same DisplayIcon
            // for some installers (Inno Setup / NSIS), even though
            // DisplayName names the actual app. We don't want
            // "open_application(MyApp)" to launch its uninstaller.
            let lower_basename = path
                .to_lowercase()
                .rsplit(['\\', '/'])
                .next()
                .unwrap_or("")
                .to_string();
            const UNINSTALLER_BASENAMES: &[&str] = &[
                "uninst.exe",
                "uninstall.exe",
                "unins000.exe",
                "unins001.exe",
                "unins002.exe",
                "uninstaller.exe",
                "setup.exe", // sometimes installers self-register their setup as DisplayIcon
            ];
            if UNINSTALLER_BASENAMES.contains(&lower_basename.as_str()) {
                continue;
            }
            // Reject MSI Windows Installer source-cache paths. The
            // ProgramData\Package Cache\{GUID}\xxxSetup.exe pattern is
            // the cached installer for the original MSI — used by
            // Add/Remove Programs to do repair / uninstall — but it's
            // NOT the actual app exe. Many drivers / SDKs / RGB-fan
            // utilities show up under DisplayName for their installer
            // there, which would launch the installer not the app.
            if path.to_lowercase().contains("\\package cache\\") {
                continue;
            }
            // Dedupe by exe path (case-insensitive). Same app can have
            // multiple sub-keys (e.g. `Slack` + `{GUID}_is1` from the
            // installer's record-keeping). Keep the first hit.
            let path_key = path.to_lowercase();
            if !seen_paths.insert(path_key) {
                continue;
            }
            // app_identifier = path. **Critical**: this is the SAME identifier
            // shape used by app_under_point / list_running_apps / hide_app
            // / find_window_displays — so request_access → click chain
            // round-trips correctly. Pre-fix, list_installed_apps used
            // the registry sub-key name, which never matched what the
            // running-window queries returned, breaking the allowlist
            // safety gate end to end.
            out.push(InstalledApp {
                app_identifier: path.clone(),
                display_name,
                path,
            });
        }
        unsafe {
            let _ = RegCloseKey(hkey);
        }
    }

    fn read_string_value(hkey: HKEY, value_name: &str) -> Option<String> {
        let name_w = to_wide(value_name);
        let mut value_type = REG_VALUE_TYPE::default();
        let mut data_size: u32 = 0;
        // First call with null buffer to get required size.
        unsafe {
            if RegQueryValueExW(
                hkey,
                PCWSTR(name_w.as_ptr()),
                None,
                Some(&mut value_type),
                None,
                Some(&mut data_size),
            )
            .is_err()
            {
                return None;
            }
        }
        if data_size == 0 {
            return Some(String::new());
        }
        let wlen = (data_size as usize).div_ceil(2);
        let mut buf: Vec<u16> = vec![0; wlen];
        unsafe {
            if RegQueryValueExW(
                hkey,
                PCWSTR(name_w.as_ptr()),
                None,
                Some(&mut value_type),
                Some(buf.as_mut_ptr() as *mut u8),
                Some(&mut data_size),
            )
            .is_err()
            {
                return None;
            }
        }
        // Trim trailing nulls — RegQueryValueExW writes the wide-string
        // including its terminator.
        let used = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..used]))
    }

    /// DisplayIcon often looks like `"C:\\Path\\app.exe",0` (icon index)
    /// or `C:\\Path\\app.exe,0`. Strip the icon-index suffix and the
    /// surrounding quotes.
    fn normalize_display_icon(raw: &str) -> String {
        let mut s = raw.trim().to_string();
        if let Some(pos) = s.rfind(',') {
            // Only strip if the suffix looks like an integer (avoids
            // mangling paths that legitimately contain commas).
            if s[pos + 1..]
                .trim()
                .chars()
                .all(|c| c.is_ascii_digit() || c == '-')
            {
                s.truncate(pos);
            }
        }
        let trimmed = s.trim().trim_matches('"').to_string();
        trimmed
    }

    // ────────────── 2. app_under_point ──────────────

    /// `p` is a `VPoint` — virtual-screen physical pixels.
    pub fn app_under_point(p: VPoint) -> Option<AppHitInfo> {
        ensure_dpi_aware();
        let pt = POINT { x: p.x, y: p.y };
        let hwnd = unsafe { WindowFromPoint(pt) };
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid: u32 = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        if pid == 0 {
            return None;
        }
        let path = exe_path_for_pid(pid)?;
        Some(AppHitInfo {
            display_name: basename(&path),
            app_identifier: path,
        })
    }

    /// Module-level state for list_running_enum_proc. EnumWindows
    /// callback can't reference fn-inner structs by name.
    struct ListRunningState {
        seen: BTreeSet<String>,
        results: Vec<AppHitInfo>,
        pid_to_path: BTreeMap<u32, String>,
    }

    /// Enumerate visible top-level windows, dedupe by owner exe path,
    /// return one AppHitInfo per unique running app with a visible
    /// window. Order is z-order from front to back (EnumWindows order).
    pub fn list_running_apps() -> Vec<AppHitInfo> {
        let mut state = ListRunningState {
            seen: BTreeSet::new(),
            results: Vec::new(),
            pid_to_path: BTreeMap::new(),
        };
        unsafe {
            let _ = EnumWindows(
                Some(list_running_enum_proc),
                LPARAM(&mut state as *mut _ as isize),
            );
        }
        state.results
    }

    unsafe extern "system" fn list_running_enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state_ptr = lparam.0 as *mut ListRunningState;
        let state = match state_ptr.as_mut() {
            Some(s) => s,
            None => return false.into(),
        };
        if !IsWindowVisible(hwnd).as_bool() {
            return true.into();
        }
        if is_window_cloaked(hwnd) {
            return true.into(); // on another virtual desktop, skip
        }

        // UWP / Microsoft Store branch: HWND has PKEY_AppUserModel_ID set →
        // ApplicationFrameWindow hosting a Microsoft Store app. The classic
        // pid → exe path would resolve to ApplicationFrameHost.exe for ALL
        // UWP apps (since AFH owns the visible HWND), so without this branch
        // the AI sees N indistinguishable AFH entries instead of Calculator
        // / Photos / Settings / etc. Dedupe by AUMID — multi-window UWP apps
        // (Edge, Photos) collapse into one entry. Friendly name via Shell
        // IShellItem (locale-correct, same string Start menu shows).
        //
        // **Must contain `!`** — UWP launcher AUMIDs are always
        // `<PackageFamilyName>!<ApplicationId>`. Classic Win32 apps (Chrome,
        // Office, Hyper terminal) frequently call SetCurrentProcessExplicit-
        // AppUserModelID to set a voluntary AUMID (e.g. `Chrome`,
        // `HYP-<guid>`) for taskbar grouping; those are NOT launchable via
        // `shell:AppsFolder\` and must fall through to the classic exe-path
        // branch. Empty AUMIDs (rare, defensive) also fall through.
        if let Some(aumid) = get_aumid_for_window(hwnd) {
            if !aumid.is_empty() && aumid.contains('!') {
                let app_identifier = format!("shell:AppsFolder\\{}", aumid);
                if state.seen.insert(app_identifier.clone()) {
                    let display_name =
                        get_shell_display_name(&app_identifier).unwrap_or_else(|| aumid.clone());
                    state.results.push(AppHitInfo {
                        display_name,
                        app_identifier,
                    });
                }
                return true.into();
            }
            // else: voluntary AUMID set by classic Win32 app; fall through
            // to exe-path branch below.
        }

        // Classic Win32 fallthrough — pid → exe path.
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return true.into();
        }
        let path = match state.pid_to_path.get(&pid) {
            Some(p) => p.clone(),
            None => match exe_path_for_pid(pid) {
                Some(p) => {
                    state.pid_to_path.insert(pid, p.clone());
                    p
                }
                None => {
                    state.pid_to_path.insert(pid, String::new());
                    return true.into();
                }
            },
        };
        if path.is_empty() {
            return true.into();
        }
        if state.seen.insert(path.clone()) {
            state.results.push(AppHitInfo {
                display_name: basename(&path),
                app_identifier: path,
            });
        }
        true.into()
    }

    /// How `find_first_visible_window_for_app` matched the AI-supplied
    /// `app_identifier`. Surfaced to the agent via `CaptureWindowOutcome.diagnostic`
    /// so debug logs can tell "exact path matched" from "basename fuzzy
    /// fallback matched against a different path."
    pub enum AppMatchKind {
        Exact,
        Basename,
        /// UWP / Microsoft Store app — matched via PKEY_AppUserModel_ID on
        /// the visible HWND (which is owned by ApplicationFrameHost.exe,
        /// not the UWP app's own process). Triggered when app_identifier is
        /// `shell:AppsFolder\<AUMID>` or contains `!`.
        Aumid,
    }

    /// Result of `find_first_visible_window_for_app`. `matched_path` is
    /// the actual process exe path of the window we found — when MatchKind
    /// is Basename this differs from the AI's input.
    pub struct WindowMatch {
        pub hwnd: HWND,
        pub kind: AppMatchKind,
        pub matched_path: String,
    }

    #[derive(Copy, Clone, PartialEq, Eq)]
    enum WindowPriority {
        Primary,
        Ephemeral,
    }

    /// Module-level state for find_window_enum_proc.
    struct FindState {
        // The AI-supplied input. Used as exact path needle.
        target_path: String,
        // Lowercased basename of target_path with `.exe` ensured. Used as
        // Step-2 fuzzy needle. None disables Step 2.
        basename_needle: Option<String>,
        // Result so far. Exact wins over Basename — once we find an exact
        // match we stop entirely. Basename matches stay tentative until
        // EnumWindows finishes (in case a later window is an exact match).
        exact: Option<(isize, String)>,
        exact_ephemeral: Option<(isize, String)>,
        basename: Option<(isize, String)>,
        basename_ephemeral: Option<(isize, String)>,
        // Visible windows we saw, for the no-match diagnostic. (basename,
        // window_text). Bounded to first ~24 to keep diagnostic short.
        visible_seen: Vec<(String, String)>,
        pid_to_path: BTreeMap<u32, String>,
    }

    /// Lowercased basename of a Win path. Returns None if path is empty
    /// or has no separator-separated component.
    fn basename_lower(path: &str) -> Option<String> {
        let last = path.rsplit(|c| c == '\\' || c == '/').next()?;
        if last.is_empty() {
            return None;
        }
        Some(last.to_lowercase())
    }

    /// Build the basename needle from AI input. Lowercases, ensures `.exe`
    /// suffix (so AI passing "weixin", "Weixin", or "Weixin.exe" all match).
    /// Returns None when the input has no extractable basename.
    fn make_basename_needle(app_identifier: &str) -> Option<String> {
        let bn = basename_lower(app_identifier)?;
        if bn.ends_with(".exe") {
            Some(bn)
        } else {
            Some(format!("{bn}.exe"))
        }
    }

    unsafe fn capture_window_priority(hwnd: HWND) -> WindowPriority {
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if (ex_style & WS_EX_TOOLWINDOW.0) != 0 || (ex_style & WS_EX_NOACTIVATE.0) != 0 {
            return WindowPriority::Ephemeral;
        }

        let mut cls = [0u16; 64];
        let len = GetClassNameW(hwnd, &mut cls) as usize;
        if len > 0 {
            let class_name = String::from_utf16_lossy(&cls[..len.min(cls.len())]).to_lowercase();
            if class_name.contains("tooltips_class32") || class_name.contains("tooltip") {
                return WindowPriority::Ephemeral;
            }
        }

        WindowPriority::Primary
    }

    /// Find the first visible top-level window owned by the app at
    /// `app_identifier`. Dispatch by app_identifier form:
    ///
    ///   - UWP form (`shell:AppsFolder\<AUMID>` or contains `!`):
    ///     PKEY_AppUserModel_ID property match on each visible HWND.
    ///     Required because UWP visible windows belong to
    ///     ApplicationFrameHost.exe, not the UWP app's own process — so
    ///     process-exe-path matching can't find them.
    ///
    ///   - Classic form (full exe path or basename): two-step match —
    ///     1. exact: process exe path equals `app_identifier` string-for-string
    ///     2. basename: lowercased basename of process exe path equals
    ///        lowercased basename of `app_identifier` (with `.exe` auto-appended)
    ///     Exact wins; basename is fallback.
    ///
    /// Returns None when no match. `WindowMatch.matched_path` is the actual
    /// path we matched (process exe for Classic, AUMID for Aumid).
    fn find_first_visible_window_for_app(
        app_identifier: &str,
    ) -> (Option<WindowMatch>, Vec<(String, String)>) {
        // Detect UWP form: AI passed `shell:AppsFolder\<AUMID>` (from
        // listInstalledApps merged output) or a bare AUMID (contains `!`).
        let aumid_target: Option<String> =
            if let Some(s) = app_identifier.strip_prefix("shell:AppsFolder\\") {
                Some(s.to_string())
            } else if app_identifier.contains('!') {
                Some(app_identifier.to_string())
            } else {
                None
            };

        if let Some(aumid) = aumid_target {
            return find_window_by_aumid(&aumid);
        }
        find_window_by_exe_path(app_identifier)
    }

    /// Classic exe-path / basename matcher (the original implementation).
    fn find_window_by_exe_path(
        app_identifier: &str,
    ) -> (Option<WindowMatch>, Vec<(String, String)>) {
        let mut state = FindState {
            target_path: app_identifier.to_string(),
            basename_needle: make_basename_needle(app_identifier),
            exact: None,
            exact_ephemeral: None,
            basename: None,
            basename_ephemeral: None,
            visible_seen: Vec::new(),
            pid_to_path: BTreeMap::new(),
        };
        unsafe {
            let _ = EnumWindows(
                Some(find_window_enum_proc),
                LPARAM(&mut state as *mut _ as isize),
            );
        }
        let result = if let Some((hwnd_isize, path)) = state.exact {
            Some(WindowMatch {
                hwnd: HWND(hwnd_isize as *mut std::ffi::c_void),
                kind: AppMatchKind::Exact,
                matched_path: path,
            })
        } else if let Some((hwnd_isize, path)) = state.exact_ephemeral {
            Some(WindowMatch {
                hwnd: HWND(hwnd_isize as *mut std::ffi::c_void),
                kind: AppMatchKind::Exact,
                matched_path: path,
            })
        } else if let Some((hwnd_isize, path)) = state.basename {
            Some(WindowMatch {
                hwnd: HWND(hwnd_isize as *mut std::ffi::c_void),
                kind: AppMatchKind::Basename,
                matched_path: path,
            })
        } else if let Some((hwnd_isize, path)) = state.basename_ephemeral {
            Some(WindowMatch {
                hwnd: HWND(hwnd_isize as *mut std::ffi::c_void),
                kind: AppMatchKind::Basename,
                matched_path: path,
            })
        } else {
            None
        };
        (result, state.visible_seen)
    }

    /// AUMID matcher for UWP / Microsoft Store apps. Walks visible
    /// top-level windows, reads PKEY_AppUserModel_ID off each, returns
    /// the first whose AUMID matches `target` (case-insensitive). The
    /// HWND returned is the ApplicationFrameWindow — PrintWindow on it
    /// captures the composited UWP content correctly (PW_RENDERFULLCONTENT).
    fn find_window_by_aumid(target: &str) -> (Option<WindowMatch>, Vec<(String, String)>) {
        let mut state = AumidFindState {
            target_lower: target.to_lowercase(),
            matched: None,
            matched_ephemeral: None,
            visible_seen: Vec::new(),
        };
        unsafe {
            let _ = EnumWindows(
                Some(aumid_find_enum_proc),
                LPARAM(&mut state as *mut _ as isize),
            );
        }
        let result = if let Some((hwnd_isize, aumid)) = state.matched {
            Some(WindowMatch {
                hwnd: HWND(hwnd_isize as *mut std::ffi::c_void),
                kind: AppMatchKind::Aumid,
                matched_path: aumid,
            })
        } else if let Some((hwnd_isize, aumid)) = state.matched_ephemeral {
            Some(WindowMatch {
                hwnd: HWND(hwnd_isize as *mut std::ffi::c_void),
                kind: AppMatchKind::Aumid,
                matched_path: aumid,
            })
        } else {
            None
        };
        (result, state.visible_seen)
    }

    struct AumidFindState {
        target_lower: String,
        /// First matched HWND (raw isize for Send across enum-proc lifetime)
        /// + the actual AUMID string we matched.
        matched: Option<(isize, String)>,
        matched_ephemeral: Option<(isize, String)>,
        /// Visible UWP HWNDs we saw, for the no-match diagnostic. Tuple
        /// is (aumid, "<uwp>") to match the existing visible_seen shape.
        visible_seen: Vec<(String, String)>,
    }

    unsafe extern "system" fn aumid_find_enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state_ptr = lparam.0 as *mut AumidFindState;
        let state = match state_ptr.as_mut() {
            Some(s) => s,
            None => return false.into(),
        };
        if state.matched.is_some() {
            return false.into();
        }
        if !IsWindowVisible(hwnd).as_bool() {
            return true.into();
        }
        if IsIconic(hwnd).as_bool() {
            return true.into();
        }
        if is_window_cloaked(hwnd) {
            return true.into(); // on another virtual desktop, skip
        }
        let aumid = match get_aumid_for_window(hwnd) {
            Some(a) if !a.is_empty() && a.contains('!') => a,
            // None / empty / no `!` → classic Win32 window with at most a
            // voluntary AUMID set for taskbar grouping (e.g. Chrome's
            // "Chrome", Hyper's GUID). Not a UWP launcher; skip — the
            // caller's classic exe-path branch handles these.
            _ => return true.into(),
        };
        // Bound the visible_seen list so a long EnumWindows pass with
        // many UWP windows doesn't blow up the diagnostic string.
        if state.visible_seen.len() < 24 {
            state
                .visible_seen
                .push((aumid.clone(), "<uwp>".to_string()));
        }
        if aumid.to_lowercase() == state.target_lower {
            match capture_window_priority(hwnd) {
                WindowPriority::Primary => {
                    state.matched = Some((hwnd.0 as isize, aumid));
                    return false.into();
                }
                WindowPriority::Ephemeral => {
                    if state.matched_ephemeral.is_none() {
                        state.matched_ephemeral = Some((hwnd.0 as isize, aumid));
                    }
                }
            }
        }
        true.into()
    }

    unsafe extern "system" fn find_window_enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state_ptr = lparam.0 as *mut FindState;
        let state = match state_ptr.as_mut() {
            Some(s) => s,
            None => return false.into(),
        };
        // Once we have a primary exact match, stop. Ephemeral exact matches
        // remain tentative so a later primary content window can override.
        if state.exact.is_some() {
            return false.into();
        }
        if !IsWindowVisible(hwnd).as_bool() {
            return true.into();
        }
        // Skip minimized windows — PrintWindow on an iconic window
        // captures the icon, not the actual content. Caller treats this
        // as "no available window" and returns null.
        if IsIconic(hwnd).as_bool() {
            return true.into();
        }
        if is_window_cloaked(hwnd) {
            return true.into(); // on another virtual desktop, skip
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return true.into();
        }
        let path = match state.pid_to_path.get(&pid) {
            Some(p) => p.clone(),
            None => match exe_path_for_pid(pid) {
                Some(p) => {
                    state.pid_to_path.insert(pid, p.clone());
                    p
                }
                None => {
                    state.pid_to_path.insert(pid, String::new());
                    return true.into();
                }
            },
        };
        if path.is_empty() {
            return true.into();
        }

        // Record visible-window diagnostic up to a cap.
        if state.visible_seen.len() < 24 {
            let bn = basename_lower(&path).unwrap_or_else(|| path.clone());
            state.visible_seen.push((bn, String::new()));
        }

        // Step 1: exact match.
        if path == state.target_path {
            match capture_window_priority(hwnd) {
                WindowPriority::Primary => {
                    state.exact = Some((hwnd.0 as isize, path));
                    return false.into();
                }
                WindowPriority::Ephemeral => {
                    if state.exact_ephemeral.is_none() {
                        state.exact_ephemeral = Some((hwnd.0 as isize, path));
                    }
                    return true.into();
                }
            }
        }

        // Step 2: basename match (only first wins; subsequent ignored to
        // preserve EnumWindows z-order semantics — topmost-first).
        if state.basename.is_none() {
            if let Some(needle) = &state.basename_needle {
                if let Some(bn) = basename_lower(&path) {
                    if &bn == needle {
                        match capture_window_priority(hwnd) {
                            WindowPriority::Primary => {
                                state.basename = Some((hwnd.0 as isize, path));
                            }
                            WindowPriority::Ephemeral => {
                                if state.basename_ephemeral.is_none() {
                                    state.basename_ephemeral = Some((hwnd.0 as isize, path));
                                }
                            }
                        }
                    }
                }
            }
        }
        true.into()
    }

    /// Capture the frontmost visible window for `app_identifier`. PrintWindow
    /// path with PW_RENDERFULLCONTENT for DWM compatibility. Returns a
    /// CaptureWindowOutcome with image=None and a diagnostic on any
    /// failure step.
    pub fn capture_window(
        app_identifier: &str,
        grid_mode: u8,
        marks: Option<Vec<MarkOverlay>>,
    ) -> CaptureWindowOutcome {
        ensure_dpi_aware();
        let (matched, visible_seen) = find_first_visible_window_for_app(app_identifier);
        let m = match matched {
            Some(m) => m,
            None => {
                let visible_summary = if visible_seen.is_empty() {
                    "<none>".to_string()
                } else {
                    visible_seen
                        .iter()
                        .map(|(bn, _)| bn.clone())
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                let is_uwp_form = app_identifier.starts_with("shell:AppsFolder\\")
                    || app_identifier.contains('!');
                let diagnostic = if is_uwp_form {
                    format!(
                        "no visible UWP window with AUMID matching app \
                         '{app_identifier}'. The app may not be running, or its \
                         AUMID differs from what was passed. Currently-visible \
                         UWP AUMIDs: [{visible_summary}]. Try opening the app \
                         first via open_application, or use the friendly name \
                         (open_application resolves it via Get-StartApps)."
                    )
                } else {
                    let basename_needle = make_basename_needle(app_identifier)
                        .unwrap_or_else(|| "<no basename>".to_string());
                    format!(
                        "no visible top-level window for app '{app_identifier}' \
                         (exact failed; basename needle '{basename_needle}' \
                         also no match). Currently-visible exe basenames: \
                         [{visible_summary}]. Use list_running_apps to \
                         confirm the app identifier you expect to be active."
                    )
                };
                return CaptureWindowOutcome {
                    image: None,
                    diagnostic,
                };
            }
        };
        let hwnd = m.hwnd;
        let match_note = match m.kind {
            AppMatchKind::Exact => format!("exact-match path='{}'", m.matched_path),
            AppMatchKind::Basename => format!(
                "basename-match: input='{app_identifier}' → matched path='{}' \
                 (lowercased basename {})",
                m.matched_path,
                make_basename_needle(app_identifier).unwrap_or_else(|| "<n/a>".to_string()),
            ),
            AppMatchKind::Aumid => format!(
                "aumid-match: input='{app_identifier}' → matched AUMID='{}' \
                 (UWP / Microsoft Store, HWND owned by ApplicationFrameHost.exe)",
                m.matched_path,
            ),
        };

        // Bring target to foreground if it's visible-but-bg. PrintWindow
        // captures the offscreen buffer regardless of z-order so the JPEG
        // is fine either way, but the user expects screenshot_window to
        // surface the window — they're going to interact next, and a
        // click while the target is occluded would land on whatever's
        // covering it. Per user-defined contract:
        //   - target visible + already foreground → don't touch
        //   - target visible + background         → bring to foreground
        //   - target not visible                  → already returned None
        //                                            above (find_*'s
        //                                            IsWindowVisible filter)
        //
        // Plain SetForegroundWindow gets blocked by Win32's foreground-
        // stealing rules unless our process is itself the foreground
        // process or has the foreground lock. The canonical workaround is
        // AttachThreadInput: temporarily share an input queue with the
        // target's UI thread, which makes the system treat us as part of
        // the same "input session" so SetForegroundWindow proceeds.
        // Plus BringWindowToTop for z-order even when SetForegroundWindow
        // ultimately fails — z-order alone is enough for the screenshot
        // case, and the click-after path uses absolute coords anyway.
        let fg_note = unsafe {
            let current_fg = GetForegroundWindow();
            if current_fg.0 == hwnd.0 {
                "already-foreground".to_string()
            } else {
                let our_tid = GetCurrentThreadId();
                let mut target_pid: u32 = 0;
                let target_tid = GetWindowThreadProcessId(hwnd, Some(&mut target_pid));
                let attached = if target_tid != 0 && target_tid != our_tid {
                    AttachThreadInput(our_tid, target_tid, true).as_bool()
                } else {
                    false
                };

                let _ = BringWindowToTop(hwnd);
                let fg_ok = SetForegroundWindow(hwnd).as_bool();

                if attached {
                    let _ = AttachThreadInput(our_tid, target_tid, false);
                }

                // Give DWM a frame to compose the new state. Without this
                // PrintWindow can capture the pre-foreground frame.
                std::thread::sleep(std::time::Duration::from_millis(50));

                if fg_ok {
                    if attached {
                        "brought-to-foreground (attached-thread-input)".to_string()
                    } else {
                        "brought-to-foreground".to_string()
                    }
                } else {
                    // SetForegroundWindow refused — most likely WS_EX_NOACTIVATE
                    // window or some shell-level protected app. BringWindowToTop
                    // already ran above so z-order is corrected even without
                    // proper foreground transfer. PrintWindow proceeds.
                    "set-foreground-failed (z-order-bumped)".to_string()
                }
            }
        };

        // Get window rect (full window including chrome — matches mac
        // CGWindowListCreateImage behavior, which captures the whole
        // window including title/resize borders).
        let mut rect = RECT::default();
        let rect_ok = unsafe { GetWindowRect(hwnd, &mut rect) };
        if let Err(err) = rect_ok {
            return CaptureWindowOutcome {
                image: None,
                diagnostic: format!(
                    "GetWindowRect failed for hwnd={:?} app '{app_identifier}': {}",
                    hwnd.0, err
                ),
            };
        }
        let width = (rect.right - rect.left).max(0);
        let height = (rect.bottom - rect.top).max(0);
        if width == 0 || height == 0 {
            return CaptureWindowOutcome {
                image: None,
                diagnostic: format!(
                    "zero-sized window rect for app '{app_identifier}': \
                     {width}x{height}"
                ),
            };
        }

        // Compute scaled image dimensions (≤ 1920 long edge) to match
        // the full-screen screenshot path for consistent VL token budgets.
        let long_edge_cap: i32 = 1920;
        let long_edge = width.max(height);
        let (target_w, target_h) = if long_edge <= long_edge_cap {
            (width, height)
        } else {
            let ratio = long_edge_cap as f64 / long_edge as f64;
            (
                (width as f64 * ratio).round() as i32,
                (height as f64 * ratio).round() as i32,
            )
        };

        // Set up DC + bitmap. RAII via early-return + manual cleanup
        // since the windows crate doesn't auto-drop GDI objects. We use
        // a guard pattern by tracking what's been created and DeleteDC /
        // DeleteObject in the right order on each exit.
        let result = unsafe {
            capture_window_inner(
                hwnd, rect.left, rect.top, width, height, target_w, target_h, 92, grid_mode, marks,
            )
        };
        match result {
            Ok(image) => CaptureWindowOutcome {
                image: Some(image),
                diagnostic: format!("ok ({match_note}; {fg_note})"),
            },
            Err(diag) => CaptureWindowOutcome {
                image: None,
                diagnostic: format!("app '{app_identifier}': {diag} ({match_note}; {fg_note})"),
            },
        }
    }

    /// Composite the system cursor into the given DC, treating the DC as
    /// having its top-left corner at virtual-screen pixel
    /// (origin_x, origin_y). No-op if the cursor is hidden (full-screen
    /// game / Windows lock screen / explicitly hidden by the foreground
    /// app) or if `GetCursorInfo` / `GetIconInfo` fail.
    ///
    /// Why we do this: PrintWindow / BitBlt(desktop DC) capture the
    /// composited window pixels but **NOT the cursor** (the cursor is
    /// painted by a separate hardware-overlay path on Win10/11). For
    /// VL-driven AI to perform closed-loop visual targeting ("move
    /// mouse, look, adjust, click"), it must see its own cursor in
    /// screenshots. Without this composite, every screenshot looks
    /// the same regardless of cursor position — the AI can't observe
    /// its own input state.
    ///
    /// `DrawIconEx` clips automatically against the DC's pixel bounds,
    /// so we don't need to range-check the cursor before drawing — if
    /// it's partly off-screen, the in-bounds part is drawn.
    /// `xHotspot`/`yHotspot` from `GetIconInfo` align the cursor's
    /// "hot point" (e.g. arrow tip) with the recorded screen coord
    /// rather than the cursor bitmap's top-left.
    ///
    /// Note: `GetIconInfo` allocates `hbmMask` and (for color cursors)
    /// Lime-green marker ring drawn directly on an RGB888 buffer.
    /// Drawn AFTER Lanczos resize so the ring is pixel-sharp at the
    /// final image resolution instead of being blurred by downscaling.
    ///
    /// Ring radius is a fixed 10 px regardless of image width, so the
    /// cursor indicator stays the same visual size at every zoom level
    /// and in full-screen captures.

    fn draw_ring_on_rgb(buf: &mut [u8], w: u32, h: u32, cx: i32, cy: i32) {
        // Fixed-size ring so the cursor indicator stays visually consistent
        // at every zoom level (same pixel footprint in the output image).
        let ring_radius = 10i32;
        let pen_width = 3i32;
        let half = pen_width as f32 / 2.0;
        let r_inner = ring_radius as f32 - half;
        let r_outer = ring_radius as f32 + half;
        let r_inner_sq = r_inner * r_inner;
        let r_outer_sq = r_outer * r_outer;
        let bound = ring_radius + pen_width;
        for dy in -bound..=bound {
            for dx in -bound..=bound {
                let dist_sq = (dx * dx + dy * dy) as f32;
                if dist_sq >= r_inner_sq && dist_sq <= r_outer_sq {
                    let px = cx + dx;
                    let py = cy + dy;
                    if px >= 0 && px < w as i32 && py >= 0 && py < h as i32 {
                        let idx = ((py as usize) * (w as usize) + (px as usize)) * 3;
                        buf[idx] = 0; // R
                        buf[idx + 1] = 255; // G
                        buf[idx + 2] = 0; // B
                    }
                }
            }
        }
    }

    // ── Coordinate grid / ruler overlay ────────────────────────────────
    // 5×7 bitmap font for digits 0-9. Each digit is 7 rows of 5 bits
    // packed into the low 5 bits of a u8 (MSB = leftmost pixel).
    const FONT_W: i32 = 5;
    const FONT_H: i32 = 7;
    #[rustfmt::skip]
    const DIGITS: [[u8; 7]; 10] = [
        [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110], // 0
        [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110], // 1
        [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111], // 2
        [0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110], // 3
        [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010], // 4
        [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110], // 5
        [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110], // 6
        [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000], // 7
        [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110], // 8
        [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100], // 9
    ];

    fn set_px(buf: &mut [u8], w: u32, h: u32, x: i32, y: i32, r: u8, g: u8, b: u8) {
        if x >= 0 && x < w as i32 && y >= 0 && y < h as i32 {
            let idx = ((y as usize) * (w as usize) + (x as usize)) * 3;
            buf[idx] = r;
            buf[idx + 1] = g;
            buf[idx + 2] = b;
        }
    }

    fn blend_px(buf: &mut [u8], w: u32, h: u32, x: i32, y: i32, r: u8, g: u8, b: u8, alpha: f32) {
        if x >= 0 && x < w as i32 && y >= 0 && y < h as i32 {
            let idx = ((y as usize) * (w as usize) + (x as usize)) * 3;
            let inv = 1.0 - alpha;
            buf[idx] = (buf[idx] as f32 * inv + r as f32 * alpha) as u8;
            buf[idx + 1] = (buf[idx + 1] as f32 * inv + g as f32 * alpha) as u8;
            buf[idx + 2] = (buf[idx + 2] as f32 * inv + b as f32 * alpha) as u8;
        }
    }

    fn darken_px(buf: &mut [u8], w: u32, _h: u32, x: i32, y: i32) {
        let idx = ((y as usize) * (w as usize) + (x as usize)) * 3;
        buf[idx] = buf[idx] / 2;
        buf[idx + 1] = buf[idx + 1] / 2;
        buf[idx + 2] = buf[idx + 2] / 2;
    }

    fn draw_digit(buf: &mut [u8], w: u32, h: u32, digit: u8, ox: i32, oy: i32) {
        let glyph = &DIGITS[digit as usize % 10];
        for row in 0..FONT_H {
            let bits = glyph[row as usize];
            for col in 0..FONT_W {
                if bits & (1 << (FONT_W - 1 - col)) != 0 {
                    set_px(buf, w, h, ox + col, oy + row, 255, 0, 0);
                }
            }
        }
    }

    fn draw_number(buf: &mut [u8], w: u32, h: u32, num: u32, ox: i32, oy: i32) {
        let s = num.to_string();
        let mut x = ox;
        for ch in s.bytes() {
            if ch >= b'0' && ch <= b'9' {
                draw_digit(buf, w, h, ch - b'0', x, oy);
                x += FONT_W + 1;
            }
        }
    }

    fn number_pixel_width(num: u32) -> i32 {
        let digits = if num == 0 {
            1
        } else {
            (num as f64).log10() as i32 + 1
        };
        digits * (FONT_W + 1) - 1
    }

    const NICE_VALUES: [f64; 5] = [1.0, 2.0, 2.5, 5.0, 10.0];

    fn nice_round(raw: f64) -> f64 {
        if raw <= 0.0 {
            return 1.0;
        }
        let exp = 10.0_f64.powf(raw.log10().floor());
        let frac = raw / exp;
        let mut best = NICE_VALUES[0];
        let mut best_dist = f64::INFINITY;
        for &n in &NICE_VALUES {
            let dist = (frac / n).ln().abs();
            if dist < best_dist {
                best_dist = dist;
                best = n;
            }
        }
        best * exp
    }

    fn is_multiple(val: f64, interval: f64) -> bool {
        let rem = val - (val / interval).floor() * interval;
        rem < 0.01 || (interval - rem) < 0.01
    }

    /// Draw coordinate rulers (mode 1 = edge only, mode 2 = edge + full grid).
    /// coord_origin/range map image pixels to virtual coordinates for labels.
    ///
    /// Two-pass corner-resolution algorithm: pass 1 collects all label positions
    /// and draws tick marks; pass 2 resolves corner conflicts (when two adjacent
    /// rulers both want to place a number near the same corner, only the one
    /// with the smaller pixel-distance to the corner point survives).
    fn draw_grid_on_rgb(
        buf: &mut [u8],
        w: u32,
        h: u32,
        mode: u8,
        coord_origin_x: i32,
        coord_origin_y: i32,
        coord_range_w: u32,
        coord_range_h: u32,
    ) {
        let w_i = w as i32;
        let h_i = h as i32;
        let tb = 14_i32;
        let sb = 30_i32;
        let label_tick = 5_i32;
        let plain_tick = 10_i32;

        let label_ivl_x = nice_round(50.0 * coord_range_w as f64 / w as f64);
        let tick_ivl_x = label_ivl_x / 2.0;
        let label_ivl_y = nice_round(50.0 * coord_range_h as f64 / h as f64);
        let tick_ivl_y = label_ivl_y / 2.0;

        let ox = coord_origin_x as f64;
        let oy = coord_origin_y as f64;
        let rw = coord_range_w as f64;
        let rh = coord_range_h as f64;
        let end_x = ox + rw;
        let end_y = oy + rh;

        let vx_to_px = |v: f64| -> i32 { ((v - ox) / rw * w as f64).round() as i32 };
        let vy_to_px = |v: f64| -> i32 { ((v - oy) / rh * h as f64).round() as i32 };

        // Pass 1: collect all label positions, draw all tick marks.
        // Each label stores its precise text bbox so corner resolution can
        // detect true pixel-precise overlap between adjacent-ruler labels.
        // The 5×7 font glyph is 7 px tall; FONT_W=5, FONT_H=7.
        #[derive(Clone, Copy)]
        struct LabelInfo {
            /// 0 = top, 1 = left, 2 = bottom, 3 = right
            kind: u8,
            /// Text bounding box [x0, x1) × [y0, y1).
            text_x0: i32,
            text_y0: i32,
            text_x1: i32,
            text_y1: i32,
            value: u32,
            nw: i32,
        }
        let mut labels: Vec<LabelInfo> = Vec::new();

        // ── Top ruler ─────────────────────────────────────────────────
        let mut vx = (ox / tick_ivl_x).ceil() * tick_ivl_x;
        while vx <= end_x {
            let cx = vx_to_px(vx);
            let lv = vx.round() as u32;
            let is_label = is_multiple(vx, label_ivl_x);
            let tl = if is_label { label_tick } else { plain_tick };
            for y in 0..tl {
                blend_px(buf, w, h, cx, y, 255, 0, 0, 0.5);
            }
            if is_label {
                let nw = number_pixel_width(lv);
                let tx0 = (cx - nw / 2).max(0);
                let ty0 = tb - FONT_H;
                labels.push(LabelInfo {
                    kind: 0,
                    text_x0: tx0,
                    text_y0: ty0,
                    text_x1: tx0 + nw,
                    text_y1: tb,
                    value: lv,
                    nw,
                });
            }
            vx += tick_ivl_x;
        }

        // ── Left ruler ────────────────────────────────────────────────
        let mut vy = (oy / tick_ivl_y).ceil() * tick_ivl_y;
        while vy <= end_y {
            let cy = vy_to_px(vy);
            let lv = vy.round() as u32;
            let is_label = is_multiple(vy, label_ivl_y) && vy > oy + 0.01;
            let tl = if is_label { label_tick } else { plain_tick };
            for x in 0..tl {
                blend_px(buf, w, h, x, cy, 255, 0, 0, 0.5);
            }
            if is_label {
                let nw = number_pixel_width(lv);
                let tx0 = label_tick + 2;
                let ty0 = cy - FONT_H / 2;
                labels.push(LabelInfo {
                    kind: 1,
                    text_x0: tx0,
                    text_y0: ty0,
                    text_x1: tx0 + nw,
                    text_y1: ty0 + FONT_H,
                    value: lv,
                    nw,
                });
            }
            vy += tick_ivl_y;
        }

        // ── Bottom ruler ──────────────────────────────────────────────
        let mut vx = (ox / tick_ivl_x).ceil() * tick_ivl_x;
        while vx <= end_x {
            let cx = vx_to_px(vx);
            let lv = vx.round() as u32;
            let is_label = is_multiple(vx, label_ivl_x);
            let tl = if is_label { label_tick } else { plain_tick };
            for y in (h_i - tl)..h_i {
                blend_px(buf, w, h, cx, y, 255, 0, 0, 0.5);
            }
            if is_label {
                let nw = number_pixel_width(lv);
                let tx0 = (cx - nw / 2).max(0);
                let ty0 = h_i - tb;
                labels.push(LabelInfo {
                    kind: 2,
                    text_x0: tx0,
                    text_y0: ty0,
                    text_x1: tx0 + nw,
                    text_y1: ty0 + FONT_H,
                    value: lv,
                    nw,
                });
            }
            vx += tick_ivl_x;
        }

        // ── Right ruler ───────────────────────────────────────────────
        let mut vy = (oy / tick_ivl_y).ceil() * tick_ivl_y;
        while vy <= end_y {
            let cy = vy_to_px(vy);
            let lv = vy.round() as u32;
            let is_label = is_multiple(vy, label_ivl_y) && vy > oy + 0.01;
            let tl = if is_label { label_tick } else { plain_tick };
            for x in (w_i - tl)..w_i {
                blend_px(buf, w, h, x, cy, 255, 0, 0, 0.5);
            }
            if is_label {
                let nw = number_pixel_width(lv);
                let tx0 = w_i - label_tick - 2 - nw;
                let ty0 = cy - FONT_H / 2;
                labels.push(LabelInfo {
                    kind: 3,
                    text_x0: tx0,
                    text_y0: ty0,
                    text_x1: tx0 + nw,
                    text_y1: ty0 + FONT_H,
                    value: lv,
                    nw,
                });
            }
            vy += tick_ivl_y;
        }

        // ── Corner resolution ─────────────────────────────────────────
        // When labels from adjacent rulers overlap, horizontal rulers
        // (top=0, bottom=2) always win over vertical rulers (left=1, right=3).
        // Fixed priority — no distance metric needed, so the outcome is
        // deterministic regardless of zoom resolution or label value width.
        // AABB overlap: [a0,a1) ∩ [b0,b1) ≠ ∅  ⇔  a0 < b1 ∧ a1 > b0.

        let mut skip: Vec<bool> = vec![false; labels.len()];

        // Adjacent ruler pairs per corner.  In each pair the first kind is
        // horizontal (winner), the second is vertical (loser on overlap).
        const CORNER_PAIRS: [(u8, u8); 4] = [
            (0, 1), // TL: top (H) + left  (V)
            (0, 3), // TR: top (H) + right (V)
            (2, 1), // BL: bottom (H) + left  (V)
            (2, 3), // BR: bottom (H) + right (V)
        ];

        for &(_ka, _kb) in CORNER_PAIRS.iter() {
            let indices_h: Vec<usize> = labels
                .iter()
                .enumerate()
                .filter(|(_, l)| l.kind == _ka)
                .map(|(i, _)| i)
                .collect();
            let indices_v: Vec<usize> = labels
                .iter()
                .enumerate()
                .filter(|(_, l)| l.kind == _kb)
                .map(|(i, _)| i)
                .collect();

            for &hi in &indices_h {
                for &vi in &indices_v {
                    if skip[vi] {
                        continue;
                    }
                    let h = &labels[hi];
                    let v = &labels[vi];
                    // AABB overlap check
                    if h.text_x0 < v.text_x1
                        && h.text_x1 > v.text_x0
                        && h.text_y0 < v.text_y1
                        && h.text_y1 > v.text_y0
                    {
                        // Horizontal always wins, skip the vertical label.
                        skip[vi] = true;
                    }
                }
            }
        }

        // Pass 2: draw label backgrounds and text (skipping corner-losers).
        for (li, lbl) in labels.iter().enumerate() {
            if skip[li] {
                continue;
            }
            match lbl.kind {
                0 => {
                    // top
                    let pad = lbl.nw / 2 + 2;
                    let cx = lbl.text_x0 + lbl.nw / 2;
                    for y in (tb - FONT_H - 1).max(0)..tb.min(h_i) {
                        for x in (cx - pad).max(0)..(cx + pad + 1).min(w_i) {
                            darken_px(buf, w, h, x, y);
                        }
                    }
                    draw_number(buf, w, h, lbl.value, lbl.text_x0, lbl.text_y0);
                }
                1 => {
                    // left
                    let pad = FONT_H / 2 + 2;
                    let cy = lbl.text_y0 + FONT_H / 2;
                    for y in (cy - pad).max(0)..(cy + pad + 1).min(h_i) {
                        for x in (label_tick + 1)..(label_tick + 3 + lbl.nw).min(w_i) {
                            darken_px(buf, w, h, x, y);
                        }
                    }
                    draw_number(buf, w, h, lbl.value, lbl.text_x0, lbl.text_y0);
                }
                2 => {
                    // bottom
                    let pad = lbl.nw / 2 + 2;
                    let cx = lbl.text_x0 + lbl.nw / 2;
                    for y in (h_i - tb).max(0)..(h_i - tb + FONT_H + 1).min(h_i) {
                        for x in (cx - pad).max(0)..(cx + pad + 1).min(w_i) {
                            darken_px(buf, w, h, x, y);
                        }
                    }
                    draw_number(buf, w, h, lbl.value, lbl.text_x0, lbl.text_y0);
                }
                3 => {
                    // right
                    let pad = FONT_H / 2 + 2;
                    let cy = lbl.text_y0 + FONT_H / 2;
                    for y in (cy - pad).max(0)..(cy + pad + 1).min(h_i) {
                        for x in (w_i - label_tick - 3 - lbl.nw).max(0)..(w_i - label_tick - 1) {
                            darken_px(buf, w, h, x, y);
                        }
                    }
                    draw_number(buf, w, h, lbl.value, lbl.text_x0, lbl.text_y0);
                }
                _ => {}
            }
        }

        // Full mode: semi-transparent grid lines at label intervals
        if mode >= 2 {
            let mut vx = ((ox / label_ivl_x).ceil() + 1.0) * label_ivl_x;
            while vx < end_x {
                let gx = vx_to_px(vx);
                if gx > 0 && gx < w_i {
                    for y in tb..(h_i - tb) {
                        blend_px(buf, w, h, gx, y, 255, 0, 0, 0.25);
                    }
                }
                vx += label_ivl_x;
            }
            let mut vy = ((oy / label_ivl_y).ceil() + 1.0) * label_ivl_y;
            while vy < end_y {
                let gy = vy_to_px(vy);
                if gy > 0 && gy < h_i {
                    for x in sb..(w_i - sb) {
                        blend_px(buf, w, h, x, gy, 255, 0, 0, 0.25);
                    }
                }
                vy += label_ivl_y;
            }
        }
    }

    // ── SoM (Set-of-Mark) overlay ──────────────────────────────────────
    // Color-parameterized variants of draw_digit / draw_number — same
    // 5×7 bitmap font as the rulers, but in any RGB. Used to render the
    // mark numbers with white fill + black 1-px outline so digits stay
    // legible on top of the translucent red circle and on whatever UI
    // pixels lie behind it.

    fn draw_digit_color(
        buf: &mut [u8],
        w: u32,
        h: u32,
        digit: u8,
        ox: i32,
        oy: i32,
        r: u8,
        g: u8,
        b: u8,
    ) {
        let glyph = &DIGITS[digit as usize % 10];
        for row in 0..FONT_H {
            let bits = glyph[row as usize];
            for col in 0..FONT_W {
                if bits & (1 << (FONT_W - 1 - col)) != 0 {
                    set_px(buf, w, h, ox + col, oy + row, r, g, b);
                }
            }
        }
    }

    fn draw_number_color(
        buf: &mut [u8],
        w: u32,
        h: u32,
        num: u32,
        ox: i32,
        oy: i32,
        r: u8,
        g: u8,
        b: u8,
    ) {
        let s = num.to_string();
        let mut x = ox;
        for ch in s.bytes() {
            if ch >= b'0' && ch <= b'9' {
                draw_digit_color(buf, w, h, ch - b'0', x, oy, r, g, b);
                x += FONT_W + 1;
            }
        }
    }

    /// Draw SoM marker circles + numbers onto the captured/resized image.
    /// Marks come in virtual coords (same space as ruler labels). The
    /// (coord_origin_*, coord_range_*) define how to project virtual →
    /// image pixels — exactly the inverse of how `draw_grid_on_rgb`
    /// projects ruler labels.
    ///
    /// Visual: filled translucent red circle sized to **just contain the
    /// digit** (acts as the digit's background, not a big halo around it).
    /// Radius = ceil(half the digit-glyph diagonal) + 2px padding. White
    /// digit centered, with 1-px black outline so it stays readable on
    /// red-ish UI backgrounds.
    fn draw_marks_on_rgb(
        buf: &mut [u8],
        w: u32,
        h: u32,
        marks: &[MarkOverlay],
        coord_origin_x: i32,
        coord_origin_y: i32,
        coord_range_w: u32,
        coord_range_h: u32,
    ) {
        if coord_range_w == 0 || coord_range_h == 0 {
            return;
        }
        for mark in marks {
            // Virtual coord → image px (inverse of the grid projection).
            let px_x = ((mark.x - coord_origin_x) as i64 * w as i64 / coord_range_w as i64) as i32;
            let px_y = ((mark.y - coord_origin_y) as i64 * h as i64 / coord_range_h as i64) as i32;
            // Tight radius — just a digit-background pill. Use the longer
            // glyph axis as the bound so multi-digit numbers (≥10) don't
            // spill outside the disc.
            let num_w = number_pixel_width(mark.id);
            let num_h = FONT_H;
            let half_diag = (((num_w * num_w + num_h * num_h) as f32).sqrt() / 2.0).ceil() as i32;
            let radius = half_diag + 2; // 2-px padding around the glyph
            let radius_sq = radius * radius;
            // Filled translucent red disc.
            for dy in -radius..=radius {
                for dx in -radius..=radius {
                    if dx * dx + dy * dy <= radius_sq {
                        blend_px(buf, w, h, px_x + dx, px_y + dy, 255, 0, 0, 0.5);
                    }
                }
            }
            // White digit centered on the disc, with a 1-px black outline
            // for contrast against bright UI backgrounds.
            let num_ox = px_x - num_w / 2;
            let num_oy = px_y - num_h / 2;
            for &(odx, ody) in &[(-1_i32, 0_i32), (1, 0), (0, -1), (0, 1)] {
                draw_number_color(buf, w, h, mark.id, num_ox + odx, num_oy + ody, 0, 0, 0);
            }
            draw_number_color(buf, w, h, mark.id, num_ox, num_oy, 255, 255, 255);
        }
    }

    /// Returns the bitmap-local cursor tip `(x, y)` if the cursor was
    /// visible and drawn, or `None` if cursor was hidden / suppressed.
    unsafe fn compose_cursor_into_dc(dc: HDC, bitmap_origin: VPoint) -> Option<(i32, i32)> {
        let mut info: CURSORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<CURSORINFO>() as u32;
        if GetCursorInfo(&mut info).is_err() {
            return None;
        }
        if info.flags.0 & CURSOR_SHOWING.0 == 0 {
            return None;
        }
        if info.hCursor.0.is_null() {
            return None;
        }
        let mut icon_info: ICONINFO = std::mem::zeroed();
        if GetIconInfo(info.hCursor, &mut icon_info).is_err() {
            return None;
        }
        let tip_x = info.ptScreenPos.x - bitmap_origin.x;
        let tip_y = info.ptScreenPos.y - bitmap_origin.y;
        let draw_x = tip_x - icon_info.xHotspot as i32;
        let draw_y = tip_y - icon_info.yHotspot as i32;
        let _ = DrawIconEx(dc, draw_x, draw_y, info.hCursor, 0, 0, 0, None, DI_NORMAL);
        if !icon_info.hbmMask.0.is_null() {
            let _ = DeleteObject(icon_info.hbmMask);
        }
        if !icon_info.hbmColor.0.is_null() {
            let _ = DeleteObject(icon_info.hbmColor);
        }
        Some((tip_x, tip_y))
    }

    /// Inner capture path; returns Result so we can `?` through the
    /// fallible GDI calls. All cleanup via guards. unsafe because every
    /// GDI call below is unsafe in the windows crate.
    ///
    /// Same BitBlt+GetDIBits pipeline as `capture_display_scaled_inner` but
    /// source is a per-window DC (PrintWindow) instead of the desktop DC.
    /// Supports Lanczos resize and grid overlay for position reference.
    unsafe fn capture_window_inner(
        hwnd: HWND,
        window_left: i32,
        window_top: i32,
        src_w: i32,
        src_h: i32,
        target_w: i32,
        target_h: i32,
        jpeg_quality: u8,
        grid_mode: u8,
        marks: Option<Vec<MarkOverlay>>,
    ) -> Result<CaptureWindowImage, String> {
        // Screen DC for compat-bitmap creation.
        let screen_dc = GetDC(HWND::default());
        if screen_dc.0.is_null() {
            return Err(format!(
                "GetDC(HWND::default()) returned null: {}",
                last_win_error()
            ));
        }
        struct ScreenDcGuard(HDC);
        impl Drop for ScreenDcGuard {
            fn drop(&mut self) {
                unsafe { ReleaseDC(HWND::default(), self.0) };
            }
        }
        let _screen_dc_guard = ScreenDcGuard(screen_dc);

        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.0.is_null() {
            return Err(format!(
                "CreateCompatibleDC returned null: {}",
                last_win_error()
            ));
        }
        struct MemDcGuard(HDC);
        impl Drop for MemDcGuard {
            fn drop(&mut self) {
                unsafe {
                    let _ = DeleteDC(self.0);
                };
            }
        }
        let _mem_dc_guard = MemDcGuard(mem_dc);

        let bitmap = CreateCompatibleBitmap(screen_dc, src_w, src_h);
        if bitmap.0.is_null() {
            return Err(format!(
                "CreateCompatibleBitmap returned null: {}",
                last_win_error()
            ));
        }
        struct BitmapGuard(windows::Win32::Graphics::Gdi::HBITMAP);
        impl Drop for BitmapGuard {
            fn drop(&mut self) {
                unsafe {
                    let _ = DeleteObject(self.0);
                };
            }
        }
        let _bitmap_guard = BitmapGuard(bitmap);

        let prev = SelectObject(mem_dc, bitmap);
        if prev.0.is_null() {
            return Err(format!("SelectObject returned null: {}", last_win_error()));
        }

        // PrintWindow with PW_RENDERFULLCONTENT for DWM windows.
        let print_ok = PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT).as_bool();
        if !print_ok {
            let win_dc = GetDC(hwnd);
            if win_dc.0.is_null() {
                return Err(format!(
                    "PrintWindow returned 0 and GetDC(hwnd) failed: {}",
                    last_win_error()
                ));
            }
            let blt_result = BitBlt(mem_dc, 0, 0, src_w, src_h, win_dc, 0, 0, SRCCOPY);
            ReleaseDC(hwnd, win_dc);
            if let Err(err) = blt_result {
                return Err(format!(
                    "PrintWindow returned 0 and BitBlt fallback failed: {}",
                    err
                ));
            }
        }

        // Composite cursor on top of captured window pixels.
        let cursor_tip = compose_cursor_into_dc(
            mem_dc,
            VPoint {
                x: window_left,
                y: window_top,
            },
        );

        // Extract pixels via GetDIBits.
        let row_size = (src_w as usize) * 4;
        let buf_size = row_size * (src_h as usize);
        let mut buf = vec![0u8; buf_size];
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = src_w;
        bmi.bmiHeader.biHeight = -src_h;
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;

        let lines = GetDIBits(
            mem_dc,
            bitmap,
            0,
            src_h as u32,
            Some(buf.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        if lines == 0 {
            return Err("GetDIBits returned 0 lines".to_string());
        }

        let mut rgb = Vec::with_capacity((src_w as usize) * (src_h as usize) * 3);
        for px in buf.chunks_exact(4) {
            rgb.push(px[2]);
            rgb.push(px[1]);
            rgb.push(px[0]);
        }

        // Lanczos resize if target dims differ from source.
        let (mut final_rgb, final_w, final_h) = if target_w == src_w && target_h == src_h {
            (rgb, src_w as u32, src_h as u32)
        } else {
            let src_img: image::ImageBuffer<image::Rgb<u8>, Vec<u8>> =
                image::ImageBuffer::from_raw(src_w as u32, src_h as u32, rgb)
                    .ok_or("Failed to create ImageBuffer for resize")?;
            let resized = image::imageops::resize(
                &src_img,
                target_w as u32,
                target_h as u32,
                image::imageops::FilterType::Lanczos3,
            );
            (resized.into_raw(), target_w as u32, target_h as u32)
        };

        // Grid overlay (rulers) on final image.
        if grid_mode > 0 {
            draw_grid_on_rgb(
                &mut final_rgb,
                final_w,
                final_h,
                grid_mode,
                window_left,
                window_top,
                src_w as u32,
                src_h as u32,
            );
        }

        // SoM (Set-of-Mark) overlay — drawn AFTER the grid so marks land
        // on top. Marks arrive in physical window-local px (TS converts
        // UIA physical coords → image coords → back to physical via
        // ratioX/Y multiplication before passing them). Use (0, 0) as
        // the coordinate origin since marks are window-relative.
        if let Some(ref m) = marks {
            draw_marks_on_rgb(
                &mut final_rgb,
                final_w,
                final_h,
                m,
                0,
                0,
                src_w as u32,
                src_h as u32,
            );
        }

        // Cursor ring drawn LAST, scaled to final image dimensions.
        if let Some((tx, ty)) = cursor_tip {
            let tip_x_img = (tx as i64 * final_w as i64 / src_w as i64) as i32;
            let tip_y_img = (ty as i64 * final_h as i64 / src_h as i64) as i32;
            draw_ring_on_rgb(&mut final_rgb, final_w, final_h, tip_x_img, tip_y_img);
        }

        let mut jpeg = Vec::new();
        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, jpeg_quality);
        encoder
            .encode(&final_rgb, final_w, final_h, image::ExtendedColorType::Rgb8)
            .map_err(|e| format!("jpeg encode failed: {e}"))?;

        let base64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
        Ok(CaptureWindowImage {
            base64,
            width: final_w as i64,
            height: final_h as i64,
            origin_x: window_left,
            origin_y: window_top,
            display_width: src_w as i64,
            display_height: src_h as i64,
        })
    }

    // ────────────── capture_display_scaled ──────────────

    /// Same BitBlt+GetDIBits+Lanczos+JPEG pipeline as capture_window_inner
    /// but: (a) source rect is the desktop DC at (src_x, src_y) instead
    /// of (0,0), (b) inserts a Lanczos resize step before encode so the
    /// output JPEG matches what the API server would have resized to
    /// anyway. None on any failure → agent falls back to base.screenshot.
    /// `src_*` is a `VRect` — physical virtual-screen pixels.
    pub fn capture_display_scaled(
        src: VRect,
        target_w: u32,
        target_h: u32,
        jpeg_quality: u8,
        grid_mode: u8,
        grid_origin_x: Option<i32>,
        grid_origin_y: Option<i32>,
        grid_range_w: Option<u32>,
        grid_range_h: Option<u32>,
        marks: Option<Vec<MarkOverlay>>,
    ) -> Option<DisplayCaptureResult> {
        ensure_dpi_aware();
        if src.size.w == 0 || src.size.h == 0 || target_w == 0 || target_h == 0 {
            return None;
        }
        let result = unsafe {
            capture_display_scaled_inner(
                src,
                target_w,
                target_h,
                jpeg_quality,
                grid_mode,
                grid_origin_x,
                grid_origin_y,
                grid_range_w,
                grid_range_h,
                marks,
            )
        };
        match result {
            Ok(r) => Some(r),
            Err(_e) => {
                // Failure path stays silent (agent already logs the
                // fallback); the inner Err string is for future
                // diagnostic plumbing if we add an outcome wrapper
                // like CaptureWindowOutcome later.
                None
            }
        }
    }

    unsafe fn capture_display_scaled_inner(
        src: VRect,
        target_w: u32,
        target_h: u32,
        jpeg_quality: u8,
        grid_mode: u8,
        grid_origin_x: Option<i32>,
        grid_origin_y: Option<i32>,
        grid_range_w: Option<u32>,
        grid_range_h: Option<u32>,
        marks: Option<Vec<MarkOverlay>>,
    ) -> Result<DisplayCaptureResult, String> {
        let src_x = src.origin.x;
        let src_y = src.origin.y;
        let src_w = src.size.w as i32;
        let src_h = src.size.h as i32;
        // Same RAII guard pattern as capture_window_inner — windows-rs 0.58
        // doesn't accept Option<HWND/HDC>; null via HWND::default() means
        // "the entire (virtual) screen" per GetDC docs, which is what we
        // want for desktop-DC capture across multi-monitor virtual-screen
        // space.
        let screen_dc = GetDC(HWND::default());
        if screen_dc.0.is_null() {
            return Err("GetDC(HWND::default()) returned null".to_string());
        }
        struct ScreenDcGuard(HDC);
        impl Drop for ScreenDcGuard {
            fn drop(&mut self) {
                unsafe { ReleaseDC(HWND::default(), self.0) };
            }
        }
        let _screen_dc_guard = ScreenDcGuard(screen_dc);

        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.0.is_null() {
            return Err("CreateCompatibleDC returned null".to_string());
        }
        struct MemDcGuard(HDC);
        impl Drop for MemDcGuard {
            fn drop(&mut self) {
                unsafe {
                    let _ = DeleteDC(self.0);
                };
            }
        }
        let _mem_dc_guard = MemDcGuard(mem_dc);

        let bitmap = CreateCompatibleBitmap(screen_dc, src_w, src_h);
        if bitmap.0.is_null() {
            return Err("CreateCompatibleBitmap returned null".to_string());
        }
        struct BitmapGuard(windows::Win32::Graphics::Gdi::HBITMAP);
        impl Drop for BitmapGuard {
            fn drop(&mut self) {
                unsafe {
                    let _ = DeleteObject(self.0);
                };
            }
        }
        let _bitmap_guard = BitmapGuard(bitmap);

        let prev = SelectObject(mem_dc, bitmap);
        if prev.0.is_null() {
            return Err("SelectObject returned null".to_string());
        }

        // Source coords (src_x, src_y) — that's what makes this differ
        // from capture_window_inner. For the primary monitor it's (0,0);
        // for a secondary monitor positioned to the left of primary it
        // can be negative. Virtual-screen space.
        let blt_ok = BitBlt(mem_dc, 0, 0, src_w, src_h, screen_dc, src_x, src_y, SRCCOPY).is_ok();
        if !blt_ok {
            return Err("BitBlt failed".to_string());
        }

        // Composite the cursor on top of the captured display pixels.
        // BitBlt(desktop DC) doesn't include the cursor — it lives on a
        // separate hardware-overlay path. Under Per-Monitor V2 DPI
        // awareness `GetCursorInfo` returns physical virtual-screen px
        // directly, so the bitmap-local cursor position is
        // (cursor_screen − bitmap_origin). No DPI scaling math needed.
        let cursor_tip = compose_cursor_into_dc(mem_dc, VPoint { x: src_x, y: src_y });

        let row_size = (src_w as usize) * 4;
        let buf_size = row_size * (src_h as usize);
        let mut buf = vec![0u8; buf_size];
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = src_w;
        bmi.bmiHeader.biHeight = -src_h;
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;

        let lines = GetDIBits(
            mem_dc,
            bitmap,
            0,
            src_h as u32,
            Some(buf.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        if lines == 0 {
            return Err("GetDIBits returned 0 lines".to_string());
        }

        let mut rgb = Vec::with_capacity((src_w as usize) * (src_h as usize) * 3);
        for px in buf.chunks_exact(4) {
            rgb.push(px[2]);
            rgb.push(px[1]);
            rgb.push(px[0]);
        }

        let (mut final_rgb, final_w, final_h) =
            if target_w as i32 == src_w && target_h as i32 == src_h {
                (rgb, src_w as u32, src_h as u32)
            } else {
                let src_img: image::ImageBuffer<image::Rgb<u8>, Vec<u8>> =
                    image::ImageBuffer::from_raw(src_w as u32, src_h as u32, rgb)
                        .ok_or_else(|| "ImageBuffer::from_raw size mismatch".to_string())?;
                let resized = image::imageops::resize(
                    &src_img,
                    target_w,
                    target_h,
                    image::imageops::FilterType::Lanczos3,
                );
                (resized.into_raw(), target_w, target_h)
            };

        if grid_mode > 0 {
            let gox = grid_origin_x.unwrap_or(0);
            let goy = grid_origin_y.unwrap_or(0);
            let grw = grid_range_w.unwrap_or(final_w);
            let grh = grid_range_h.unwrap_or(final_h);
            draw_grid_on_rgb(
                &mut final_rgb,
                final_w,
                final_h,
                grid_mode,
                gox,
                goy,
                grw,
                grh,
            );
        }

        // SoM (Set-of-Mark) overlay — drawn AFTER the grid so marks land
        // on top of any ruler crossings rather than under them. The mark
        // (x, y) virtual coords use the same coord_origin/range as the
        // grid; when the grid params are absent we default to image-px
        // space so callers can pass image-px directly if they prefer.
        if let Some(marks_vec) = marks.as_ref() {
            if !marks_vec.is_empty() {
                let gox = grid_origin_x.unwrap_or(0);
                let goy = grid_origin_y.unwrap_or(0);
                let grw = grid_range_w.unwrap_or(final_w);
                let grh = grid_range_h.unwrap_or(final_h);
                draw_marks_on_rgb(
                    &mut final_rgb,
                    final_w,
                    final_h,
                    marks_vec,
                    gox,
                    goy,
                    grw,
                    grh,
                );
            }
        }

        // Cursor ring — drawn LAST so it sits on top of grid, rulers, and SoM marks.
        if let Some((tx, ty)) = cursor_tip {
            let tip_x_img = (tx as i64 * final_w as i64 / src_w as i64) as i32;
            let tip_y_img = (ty as i64 * final_h as i64 / src_h as i64) as i32;
            draw_ring_on_rgb(&mut final_rgb, final_w, final_h, tip_x_img, tip_y_img);
        }

        let mut jpeg = Vec::new();
        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, jpeg_quality);
        encoder
            .encode(&final_rgb, final_w, final_h, image::ExtendedColorType::Rgb8)
            .map_err(|e| format!("jpeg encode failed: {e}"))?;

        let base64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
        Ok(DisplayCaptureResult {
            base64,
            width: final_w as i64,
            height: final_h as i64,
        })
    }

    // ────────────── mouse input (Win32 SendInput / SetCursorPos) ──────────────

    /// Move the cursor to virtual-screen physical pixel `VPoint(x, y)`.
    ///
    /// Uses `SendInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE |
    /// MOUSEEVENTF_VIRTUALDESK)` instead of `SetCursorPos` because Win10/11
    /// has a known issue where `SetCursorPos` updates the cursor coord (so
    /// `GetCursorPos` returns the new value) but does NOT always trigger a
    /// redraw of the visible cursor. The `click` path historically masked
    /// this — its subsequent `SendInput(LEFTDOWN/UP)` would force the
    /// redraw — but `mouse_move` (no follow-up SendInput) leaves the cursor
    /// visually frozen even though the OS believes it moved.
    ///
    /// `SendInput` with `MOUSEEVENTF_MOVE` goes through the same input
    /// pipeline as a physical mouse, which guarantees the visible cursor
    /// repaints. `MOUSEEVENTF_ABSOLUTE` interprets `(dx, dy)` as the
    /// destination (not delta); `MOUSEEVENTF_VIRTUALDESK` makes the
    /// normalized 0..65535 range span the multi-monitor virtual screen
    /// instead of the primary monitor only.
    pub fn move_cursor(p: VPoint) -> Result<VPoint, String> {
        ensure_dpi_aware();
        let (nx, ny) = vpoint_to_normalized_absolute(p)
            .ok_or_else(|| "VIRTUALSCREEN dims invalid (≤1)".to_string())?;
        send_mouse(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            nx,
            ny,
            0,
        )?;
        get_cursor_pos()
    }

    /// Translate a virtual-screen `VPoint` (physical pixels) to the
    /// normalized 0..65535 range that `SendInput(MOUSEEVENTF_ABSOLUTE)`
    /// expects.
    ///
    /// Per MSDN: with `MOUSEEVENTF_VIRTUALDESK`, `0..65535` maps onto the
    /// virtual desktop's full extent (multi-monitor bounding box).
    /// `(0, 0)` is the top-left corner of the virtual desktop;
    /// `(65535, 65535)` is the bottom-right pixel. The divisor is
    /// `(W - 1)` so that the maximum input lands exactly on the
    /// bottom-right pixel rather than one past it.
    ///
    /// Returns `None` when `GetSystemMetrics` reports degenerate virtual
    /// screen dims (≤1) — defensive; would mean the desktop session is
    /// in an unusual state (lock screen during transition, RDP edge case).
    ///
    /// Under Per-Monitor V2 DPI awareness (`ensure_dpi_aware`), the
    /// `SM_*VIRTUALSCREEN` metrics are already in physical pixels, so this
    /// is a single-step transform — no logical/physical scaling involved.
    fn vpoint_to_normalized_absolute(p: VPoint) -> Option<(i32, i32)> {
        let vx = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
        let vy = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
        let vw = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
        let vh = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
        if vw <= 1 || vh <= 1 {
            return None;
        }
        // i64 intermediate to avoid overflow on 4K+ displays where
        // (x - vx) * 65535 can exceed i32 range.
        let nx = (((p.x - vx) as i64 * 65535) / (vw - 1) as i64) as i32;
        let ny = (((p.y - vy) as i64 * 65535) / (vh - 1) as i64) as i32;
        Some((nx, ny))
    }

    pub fn get_cursor_pos() -> Result<VPoint, String> {
        ensure_dpi_aware();
        let mut pt = POINT { x: 0, y: 0 };
        let ok = unsafe { GetCursorPos(&mut pt) }.is_ok();
        if !ok {
            return Err(format!("GetCursorPos failed: {}", last_win_error()));
        }
        Ok(VPoint { x: pt.x, y: pt.y })
    }

    pub fn click_mouse(button: u32, count: u32) -> Result<(), String> {
        ensure_dpi_aware();
        let (down, up) = match button {
            0 => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            1 => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            2 => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            _ => return Err(format!("invalid button: {button}")),
        };
        let n = count.max(1).min(3);
        for _ in 0..n {
            for flags in [down, up] {
                send_mouse(flags, 0, 0, 0)?;
            }
        }
        Ok(())
    }

    pub fn mouse_button_event(button: u32, down: bool) -> Result<(), String> {
        ensure_dpi_aware();
        let flags = match (button, down) {
            (0, true) => MOUSEEVENTF_LEFTDOWN,
            (0, false) => MOUSEEVENTF_LEFTUP,
            (1, true) => MOUSEEVENTF_RIGHTDOWN,
            (1, false) => MOUSEEVENTF_RIGHTUP,
            (2, true) => MOUSEEVENTF_MIDDLEDOWN,
            (2, false) => MOUSEEVENTF_MIDDLEUP,
            _ => return Err(format!("invalid button: {button}")),
        };
        send_mouse(flags, 0, 0, 0)
    }

    pub fn mouse_scroll(dx: i32, dy: i32) -> Result<(), String> {
        ensure_dpi_aware();
        // Vertical wheel first, then horizontal — matches typical Win32
        // input order if both axes are scrolled at once.
        if dy != 0 {
            send_mouse(MOUSEEVENTF_WHEEL, 0, 0, dy)?;
        }
        if dx != 0 {
            send_mouse(MOUSEEVENTF_HWHEEL, 0, 0, dx)?;
        }
        Ok(())
    }

    fn send_mouse(
        flags: MOUSE_EVENT_FLAGS,
        dx: i32,
        dy: i32,
        wheel_delta: i32,
    ) -> Result<(), String> {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: wheel_delta as u32,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let inputs = [input];
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent == 0 {
            return Err(format!(
                "SendInput(MOUSE) returned 0 (event blocked by UIPI / secure desktop / lock screen): {}",
                last_win_error()
            ));
        }
        Ok(())
    }

    pub fn key_event(vk: u32, down: bool, extended: bool) -> Result<(), String> {
        let mut flags = KEYBD_EVENT_FLAGS(0);
        if !down {
            flags |= KEYEVENTF_KEYUP;
        }
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk as u16),
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let inputs = [input];
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent == 0 {
            return Err(format!(
                "SendInput(KEY vk={vk}) returned 0 (event blocked by UIPI / secure desktop / lock screen): {}",
                last_win_error()
            ));
        }
        Ok(())
    }

    pub fn type_text_unicode(text: &str) -> Result<(), String> {
        // Build INPUT events — one down + one up per UTF-16 code unit.
        // Surrogate pairs ride through unchanged (each code unit is its
        // own KEYEVENTF_UNICODE event; receivers reassemble).
        let mut inputs: Vec<INPUT> = Vec::with_capacity(text.encode_utf16().count() * 2);
        for unit in text.encode_utf16() {
            for up in [false, true] {
                let mut flags = KEYEVENTF_UNICODE;
                if up {
                    flags |= KEYEVENTF_KEYUP;
                }
                inputs.push(INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(0),
                            wScan: unit,
                            dwFlags: flags,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                });
            }
        }
        if inputs.is_empty() {
            return Ok(());
        }
        // SendInput batches the whole array in one syscall — minimizes
        // race with concurrent input. Up to ~512 events at once is
        // typical fine; for very long strings you might want to chunk.
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            return Err(format!(
                "SendInput(UNICODE text) sent {sent}/{} events: {}",
                inputs.len(),
                last_win_error()
            ));
        }
        Ok(())
    }

    pub fn get_foreground_window() -> Option<AppHitInfo> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid: u32 = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        if pid == 0 {
            return None;
        }
        let path = exe_path_for_pid(pid)?;
        Some(AppHitInfo {
            display_name: basename(&path),
            app_identifier: path,
        })
    }

    // ────────────── defocus_self_to_previous_foreground ──────────────
    //
    // EnumWindows iterates top-level windows in Z-order from front to back
    // (documented behavior, Win 8+). The first non-host visible window
    // above the size threshold is the "previous foreground" we want.
    //
    // "Host" here means our PID OR any ancestor PID — axiomate is usually
    // hosted in a terminal (Windows Terminal, conhost, VS Code integrated,
    // mintty, ...) and the foreground window belongs to that host's PID,
    // not axiomate's. So we must skip the entire host chain to avoid
    // re-selecting ourselves and to correctly identify "we are foreground"
    // when the host is foreground.

    /// Smallest dimension (px) for a window to be considered a real
    /// keyboard-input target. Filters: toolbars, IME indicators, tray
    /// helpers, hidden zero-size root windows.
    const MIN_TARGET_DIMENSION: i32 = 100;

    /// Process parent chain walk is typically < 8 deep on modern Windows.
    /// 16 is a safety margin for nested job objects / containers.
    const MAX_PROCESS_CHAIN_DEPTH: usize = 16;

    /// UIA tree depth for ancestor walk. Even deeply nested desktop UIs
    /// (File Explorer, Visual Studio, complex WPF) rarely exceed 32 levels.
    /// 64 is a generous safety net against circular broken trees.
    const MAX_UIA_TREE_DEPTH: usize = 64;

    /// Walk the ToolHelp32 snapshot once to build {current_pid + all
    /// ancestor pids}. Same approach as `get_host_ancestor_paths()` but
    /// returns PIDs instead of resolved exe paths — defocus only needs
    /// to compare PIDs against window owners, not show paths to anyone.
    fn host_pid_set() -> BTreeSet<u32> {
        let mut set = BTreeSet::new();
        let our_pid = unsafe { GetCurrentProcessId() };
        set.insert(our_pid);

        let snapshot = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
            Ok(s) => s,
            Err(_) => return set, // best-effort: at least our own PID
        };
        let mut ppid_of: BTreeMap<u32, u32> = BTreeMap::new();
        unsafe {
            let mut entry = PROCESSENTRY32W::default();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    ppid_of.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                    entry = PROCESSENTRY32W::default();
                    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }

        // Walk up at most 16 hops, mirroring get_host_ancestor_paths.
        let mut pid = our_pid;
        for _ in 0..MAX_PROCESS_CHAIN_DEPTH {
            let ppid = match ppid_of.get(&pid) {
                Some(p) if *p != 0 && *p != pid => *p,
                _ => break,
            };
            set.insert(ppid);
            pid = ppid;
        }
        set
    }

    struct DefocusFinderState {
        host_pids: BTreeSet<u32>,
        /// Result HWND.0 — null pointer means "not found yet". We use the
        /// null-check rather than Option<HWND> because HWND isn't Send and
        /// we can't store it through extern "system" callbacks cleanly.
        target: HWND,
    }

    unsafe fn is_real_target_window(hwnd: HWND, host_pids: &BTreeSet<u32>) -> bool {
        if hwnd.0.is_null() || !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return false;
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 || host_pids.contains(&pid) {
            return false;
        }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        w >= MIN_TARGET_DIMENSION && h >= MIN_TARGET_DIMENSION
    }

    unsafe fn bring_hwnd_to_foreground(hwnd: HWND) -> bool {
        if hwnd.0.is_null() {
            return false;
        }
        let current_fg = GetForegroundWindow();
        if current_fg.0 == hwnd.0 {
            return true;
        }

        let our_tid = GetCurrentThreadId();
        let target_tid = GetWindowThreadProcessId(hwnd, None);
        let attached = if target_tid != 0 && target_tid != our_tid {
            AttachThreadInput(our_tid, target_tid, true).as_bool()
        } else {
            false
        };

        let _ = BringWindowToTop(hwnd);
        let fg_ok = SetForegroundWindow(hwnd).as_bool();

        if attached {
            let _ = AttachThreadInput(our_tid, target_tid, false);
        }

        std::thread::sleep(std::time::Duration::from_millis(50));
        fg_ok || GetForegroundWindow().0 == hwnd.0
    }

    unsafe fn hwnd_under_point_for_zoom(pt: POINT, host_pids: &BTreeSet<u32>) -> HWND {
        let hit = WindowFromPoint(pt);
        if hit.0.is_null() {
            return HWND(std::ptr::null_mut());
        }

        // First try the direct hit window itself.
        if is_real_target_window(hit, host_pids) {
            return hit;
        }

        // Then walk the Z-order top-level windows and pick the first real
        // target whose rect contains the point. This maps child/owner hits
        // back to the visible top-level app window.
        let state = DefocusFinderState {
            host_pids: host_pids.clone(),
            target: HWND(std::ptr::null_mut()),
        };
        extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let tuple = unsafe { &mut *(lparam.0 as *mut (POINT, DefocusFinderState)) };
            let pt = tuple.0;
            let state = &mut tuple.1;
            if !unsafe { is_real_target_window(hwnd, &state.host_pids) } {
                return BOOL(1);
            }
            let mut rect = RECT::default();
            if unsafe { GetWindowRect(hwnd, &mut rect).is_err() } {
                return BOOL(1);
            }
            if pt.x >= rect.left && pt.x < rect.right && pt.y >= rect.top && pt.y < rect.bottom {
                state.target = hwnd;
                return BOOL(0);
            }
            BOOL(1)
        }

        let mut payload = (pt, state);
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut payload as *mut _ as isize));
        payload.1.target
    }

    extern "system" fn defocus_finder_enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: lparam is the &mut DefocusFinderState we passed into
        // EnumWindows. Lifetime is the EnumWindows call duration.
        let state = unsafe { &mut *(lparam.0 as *mut DefocusFinderState) };

        if !unsafe { IsWindowVisible(hwnd).as_bool() } {
            return BOOL(1); // continue
        }

        let mut pid: u32 = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        // Skip our entire host chain (axiomate's own windows + every
        // ancestor's: terminal host, shell, etc) and unowned windows.
        if pid == 0 || state.host_pids.contains(&pid) {
            return BOOL(1);
        }

        // Skip tiny windows: tray icon owners, IME UI, system overlays.
        let mut rect = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut rect).is_err() } {
            return BOOL(1);
        }
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w < MIN_TARGET_DIMENSION || h < MIN_TARGET_DIMENSION {
            return BOOL(1);
        }

        // Hit. Stop enumeration.
        state.target = hwnd;
        BOOL(0)
    }

    /// Check whether the desktop is covered by any visible, non-minimized
    /// window that isn't the desktop itself, the taskbar, or in the host
    /// chain. Returns true when desktop icons should be skipped.

    /// Z-order walk to find the first visible non-host window (no focus
    /// switch). Returns the HWND or null if none found.
    fn find_non_host_hwnd(host_pids: &BTreeSet<u32>) -> HWND {
        let mut state = DefocusFinderState {
            host_pids: host_pids.clone(),
            target: HWND(std::ptr::null_mut()),
        };
        unsafe {
            let _ = EnumWindows(
                Some(defocus_finder_enum_proc),
                LPARAM(&mut state as *mut _ as isize),
            );
        }
        state.target
    }

    pub fn defocus_self_to_previous_foreground() -> bool {
        ensure_dpi_aware();
        let current_fg = unsafe { GetForegroundWindow() };
        if current_fg.0.is_null() {
            return false;
        }

        let host_pids = host_pid_set();

        // Is the current foreground anywhere in our host chain? If not (AI
        // already clicked a target window), don't switch — the keys flow
        // to the right place.
        let mut fg_pid: u32 = 0;
        unsafe {
            GetWindowThreadProcessId(current_fg, Some(&mut fg_pid));
        }
        if fg_pid == 0 || !host_pids.contains(&fg_pid) {
            return false;
        }

        // Walk Z-order, find first visible non-host window over the size
        // threshold. EnumWindows order is documented top-to-bottom.
        let target = find_non_host_hwnd(&host_pids);
        if target.0.is_null() {
            return false; // no suitable target — bail; behavior degrades to current
        }

        unsafe { bring_hwnd_to_foreground(target) }
    }

    pub fn focus_non_host_window_at_point(p: VPoint) -> bool {
        ensure_dpi_aware();
        let host_pids = host_pid_set();
        let target = unsafe { hwnd_under_point_for_zoom(POINT { x: p.x, y: p.y }, &host_pids) };
        if target.0.is_null() {
            return false;
        }
        unsafe { bring_hwnd_to_foreground(target) }
    }

    // ────────────── off-screen / restore host windows ──────────────
    //
    // Sequence: SetWindowPos(off-screen) → DwmFlush → Sleep(30ms) →
    // screenshot (caller) → SetWindowPos(restore).
    // Moving off-screen is faster than SW_HIDE because it avoids DWM's
    // fade-out animation entirely.

    /// (hwnd as isize, saved_left, saved_top, saved_width, saved_height)
    type SavedPlacement = (isize, i32, i32, i32, i32);
    static HIDDEN_HWNDS: Mutex<Vec<SavedPlacement>> = Mutex::new(Vec::new());

    unsafe fn move_off_screen(hwnd: HWND) -> Option<SavedPlacement> {
        let mut r = RECT::default();
        if GetWindowRect(hwnd, &mut r).is_err() {
            return None;
        }
        let w = r.right - r.left;
        let h = r.bottom - r.top;
        let saved = (hwnd.0 as isize, r.left, r.top, w, h);
        let off_x =
            GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN) + 100;
        let off_y =
            GetSystemMetrics(SM_YVIRTUALSCREEN) + GetSystemMetrics(SM_CYVIRTUALSCREEN) + 100;
        SetWindowPos(
            hwnd,
            HWND_TOP,
            off_x,
            off_y,
            w,
            h,
            SWP_NOACTIVATE | SWP_NOZORDER,
        )
        .ok()?;
        Some(saved)
    }

    unsafe fn move_back(hwnd: HWND, x: i32, y: i32, w: i32, h: i32) {
        let _ = SetWindowPos(hwnd, HWND_TOP, x, y, w, h, SWP_NOACTIVATE | SWP_NOZORDER);
    }

    pub fn hide_self_windows() -> u32 {
        ensure_dpi_aware();
        let host_pids = host_pid_set();
        if let Ok(mut list) = HIDDEN_HWNDS.lock() {
            list.clear();
        }
        let hwnds: Vec<HWND> = unsafe {
            struct CollectState {
                host_pids: BTreeSet<u32>,
                hwnds: Vec<HWND>,
            }
            extern "system" fn collect_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let state = unsafe { &mut *(lparam.0 as *mut CollectState) };
                if !unsafe { IsWindowVisible(hwnd).as_bool() }
                    || unsafe { IsIconic(hwnd).as_bool() }
                {
                    return BOOL(1);
                }
                let mut pid: u32 = 0;
                unsafe {
                    GetWindowThreadProcessId(hwnd, Some(&mut pid));
                }
                if pid == 0 || !state.host_pids.contains(&pid) {
                    return BOOL(1);
                }
                let mut rect = RECT::default();
                if unsafe { GetWindowRect(hwnd, &mut rect).is_err() } {
                    return BOOL(1);
                }
                let w = rect.right - rect.left;
                let h = rect.bottom - rect.top;
                if w < MIN_TARGET_DIMENSION || h < MIN_TARGET_DIMENSION {
                    return BOOL(1);
                }
                if let Some(ref p) = exe_path_for_pid(pid) {
                    if is_protected_system_process(p) {
                        return BOOL(1);
                    }
                }
                state.hwnds.push(hwnd);
                BOOL(1)
            }
            let mut cs = CollectState {
                host_pids: host_pids.clone(),
                hwnds: Vec::new(),
            };
            let _ = EnumWindows(Some(collect_proc), LPARAM(&mut cs as *mut _ as isize));
            cs.hwnds
        };
        if hwnds.is_empty() {
            return 0;
        }
        let mut count: u32 = 0;
        for hwnd in &hwnds {
            unsafe {
                if let Some(saved) = move_off_screen(*hwnd) {
                    if let Ok(mut list) = HIDDEN_HWNDS.lock() {
                        list.push(saved);
                    }
                    count += 1;
                }
            }
        }
        unsafe {
            let _ = DwmFlush();
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
        count
    }

    pub fn show_self_windows() {
        let placements: Vec<SavedPlacement> = {
            let mut list = match HIDDEN_HWNDS.lock() {
                Ok(l) => l,
                Err(_) => return,
            };
            let v = list.clone();
            list.clear();
            v
        };
        for (h, x, y, w, h2) in placements {
            if h != 0 {
                unsafe {
                    move_back(HWND(h as *mut _), x, y, w, h2);
                }
            }
        }
    }

    /// Mutable accumulator passed via LPARAM through visibility_enum_proc.
    /// Module-level so the extern "system" callback can reference it by
    /// name (same pattern as Stage 1's WindowEnumState).
    struct VisState {
        /// Full exe path of the target app — windows owned by other
        /// processes are skipped.
        target_path: String,
        /// true: SW_SHOWNOACTIVATE; false: SW_HIDE.
        show: bool,
        /// true once at least one ShowWindow call was issued.
        changed: bool,
        /// pid → exe path cache. "" sentinel = lookup failed once.
        pid_to_path: BTreeMap<u32, String>,
    }

    /// System processes that must NEVER be hidden, even if the caller
    /// passes them in. Hiding `explorer.exe` takes the taskbar + desktop
    /// offline (user reports "screen goes black, must restart explorer");
    /// hiding `dwm.exe` / `sihost.exe` / Win11 shell hosts likewise
    /// destabilizes the UI. unhide is also gated symmetrically — we
    /// never hid them, so we shouldn't synthesize SW_SHOWNOACTIVATE on
    /// them either.
    ///
    /// Match by exe basename (case-insensitive) — same field across all
    /// versions of Windows. Path varies by install location / SystemApps
    /// nesting / WoW64 / etc.
    const SYSTEM_HIDE_DENY_LIST: &[&str] = &[
        "explorer.exe",                // Taskbar, desktop, File Explorer
        "dwm.exe",                     // Desktop Window Manager (compositor)
        "sihost.exe",                  // Shell Infrastructure Host
        "ctfmon.exe",                  // Text services framework
        "csrss.exe",                   // Client Server Runtime (kernel-adjacent)
        "winlogon.exe",                // Logon manager
        "logonui.exe",                 // Lock screen / login UI
        "lockapp.exe",                 // Win11 lock screen
        "searchhost.exe",              // Win11 search overlay
        "startmenuexperiencehost.exe", // Win11 Start menu
        "shellexperiencehost.exe",     // Win10/11 shell experience
        "textinputhost.exe",           // Win11 IME / handwriting
        "applicationframehost.exe",    // UWP frame host
        "systemsettings.exe",          // Windows Settings (UWP)
        "fontdrvhost.exe",             // Font driver host
        "wininit.exe",                 // Boot init
        "smss.exe",                    // Session Manager
        "services.exe",                // SCM (won't have windows but defensive)
    ];

    fn is_protected_system_process(path: &str) -> bool {
        let lower = path.to_lowercase();
        let basename = lower.rsplit(['\\', '/']).next().unwrap_or(&lower);
        SYSTEM_HIDE_DENY_LIST.iter().any(|p| *p == basename)
    }

    /// Set visibility of every top-level window owned by `app_identifier` to
    /// either hidden (false) or shown (true). Walks EnumWindows once; for
    /// each window resolves owner pid → exe path (cached per call) and
    /// matches against app_identifier. Returns true iff at least one window's
    /// visibility was changed.
    ///
    /// **Hard-blocks system processes via `is_protected_system_process`** —
    /// any input matching a deny-listed exe basename returns false
    /// immediately without touching the window list. This is the safety
    /// net that prevents prepareForAction allowlist gaps from accidentally
    /// hiding explorer.exe / dwm.exe / Win11 shell hosts.
    ///
    /// We filter by current visibility matching the change direction: hide
    /// only acts on visible windows; show only on hidden ones. This keeps
    /// the operation idempotent and avoids re-showing windows the app had
    /// explicitly hidden for its own reasons.
    pub fn set_app_visibility(app_identifier: &str, show: bool) -> bool {
        if is_protected_system_process(app_identifier) {
            return false;
        }
        let mut state = VisState {
            target_path: app_identifier.to_string(),
            show,
            changed: false,
            pid_to_path: BTreeMap::new(),
        };
        unsafe {
            let _ = EnumWindows(
                Some(visibility_enum_proc),
                LPARAM(&mut state as *mut _ as isize),
            );
        }
        state.changed
    }

    unsafe extern "system" fn visibility_enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state_ptr = lparam.0 as *mut VisState;
        let state = match state_ptr.as_mut() {
            Some(s) => s,
            None => return false.into(),
        };
        let currently_visible = IsWindowVisible(hwnd).as_bool();
        // hide mode skips already-hidden; show mode skips already-visible.
        if state.show == currently_visible {
            return true.into();
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return true.into();
        }
        let path = match state.pid_to_path.get(&pid) {
            Some(p) => p.clone(),
            None => match exe_path_for_pid(pid) {
                Some(p) => {
                    state.pid_to_path.insert(pid, p.clone());
                    p
                }
                None => {
                    state.pid_to_path.insert(pid, String::new());
                    return true.into();
                }
            },
        };
        if path.is_empty() || path != state.target_path {
            return true.into();
        }
        let cmd: SHOW_WINDOW_CMD = if state.show {
            SW_SHOWNOACTIVATE
        } else {
            SW_HIDE
        };
        let _ = ShowWindow(hwnd, cmd);
        state.changed = true;
        true.into()
    }

    /// Resolve `pid` → full exe path via PROCESS_QUERY_LIMITED_INFORMATION
    /// (no admin needed; works against any user-level process). Returns
    /// None on access denied (target is elevated and we're not).
    fn exe_path_for_pid(pid: u32) -> Option<String> {
        unsafe {
            let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf: [u16; 1024] = [0; 1024];
            let mut size: u32 = buf.len() as u32;
            let res = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                PWSTR(buf.as_mut_ptr()),
                &mut size,
            );
            let _ = CloseHandle(handle);
            if res.is_err() {
                return None;
            }
            Some(String::from_utf16_lossy(&buf[..size as usize]))
        }
    }

    fn basename(path: &str) -> String {
        Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| path.to_string())
    }

    // ────────────── 3. find_window_monitor_rects ──────────────

    /// Module-level state for the EnumWindows callback.
    struct WindowEnumState {
        app_identifier_set: BTreeSet<String>,
        /// app_identifier → set of (x, y, w, h) monitor rects intersecting any
        /// window of that app. Stored as a tuple (not VRect) so the BTreeSet
        /// can use derived Ord for dedup — multi-window apps that all sit
        /// on the same monitor produce one entry. Reconstituted as VRect
        /// at result-emission time.
        results: BTreeMap<String, BTreeSet<(i32, i32, u32, u32)>>,
        pid_to_path: BTreeMap<u32, String>,
        /// All active monitors with their full VRects, computed once per
        /// call (`list_monitor_rects`). Used to test which monitors
        /// each window intersects.
        monitors: Vec<VRect>,
    }

    pub fn find_window_monitor_rects(app_identifiers: &[String]) -> Vec<WindowMonitorInfo> {
        ensure_dpi_aware();
        if app_identifiers.is_empty() {
            return Vec::new();
        }
        let monitors = list_monitor_rects();
        if monitors.is_empty() {
            return app_identifiers
                .iter()
                .map(|bid| WindowMonitorInfo {
                    app_identifier: bid.clone(),
                    monitor_rects: vec![],
                })
                .collect();
        }
        let mut state = WindowEnumState {
            app_identifier_set: app_identifiers.iter().cloned().collect(),
            results: BTreeMap::new(),
            pid_to_path: BTreeMap::new(),
            monitors,
        };
        unsafe {
            let _ = EnumWindows(
                Some(enum_windows_proc),
                LPARAM(&mut state as *mut _ as isize),
            );
        }
        app_identifiers
            .iter()
            .map(|bid| WindowMonitorInfo {
                app_identifier: bid.clone(),
                monitor_rects: state
                    .results
                    .get(bid)
                    .map(|s| {
                        s.iter()
                            .map(|(x, y, w, h)| VRect::new(*x, *y, *w, *h))
                            .collect()
                    })
                    .unwrap_or_default(),
            })
            .collect()
    }

    unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return true.into();
        }
        let state_ptr = lparam.0 as *mut WindowEnumState;
        let state = match state_ptr.as_mut() {
            Some(s) => s,
            None => return false.into(),
        };
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return true.into();
        }
        let path = if let Some(p) = state.pid_to_path.get(&pid) {
            p.clone()
        } else {
            match exe_path_for_pid(pid) {
                Some(p) => {
                    state.pid_to_path.insert(pid, p.clone());
                    p
                }
                None => {
                    state.pid_to_path.insert(pid, String::new());
                    return true.into();
                }
            }
        };
        if path.is_empty() || !state.app_identifier_set.contains(&path) {
            return true.into();
        }
        // Window rect from Win32 (physical px on per-monitor-DPI-aware
        // process — same coord space as our monitor VRects from
        // GetMonitorInfoW). Repacked to VRect at the syscall instant.
        let mut win_rect = RECT::default();
        if GetWindowRect(hwnd, &mut win_rect).is_err() {
            return true.into();
        }
        let win_vrect = VRect::from(win_rect);
        // Test against every monitor — multi-monitor windows produce
        // multiple entries (matches mac NAPI's CGRect intersection
        // semantics; a window straddling two monitors lights up both).
        for m in &state.monitors {
            if win_vrect.intersects(m) {
                state
                    .results
                    .entry(path.clone())
                    .or_default()
                    .insert((m.origin.x, m.origin.y, m.size.w, m.size.h));
            }
        }
        true.into()
    }

    /// Enumerate active monitors with their full rects via
    /// EnumDisplayMonitors + GetMonitorInfoW. Coords match
    /// `node-screenshots` Monitor.x()/y()/width()/height() on Windows
    /// (both query the same Win32 path with the same DPI awareness as
    /// the host process).
    fn list_monitor_rects() -> Vec<VRect> {
        use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFO};
        let mut hmonitors: Vec<HMONITOR> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(enum_monitors_proc),
                LPARAM(&mut hmonitors as *mut _ as isize),
            );
        }
        hmonitors
            .into_iter()
            .filter_map(|hmon| {
                let mut info = MONITORINFO::default();
                info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                let ok = unsafe { GetMonitorInfoW(hmon, &mut info) }.as_bool();
                if !ok {
                    return None;
                }
                Some(VRect::from(info.rcMonitor))
            })
            .collect()
    }

    unsafe extern "system" fn enum_monitors_proc(
        hmon: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        if let Some(monitors) = (lparam.0 as *mut Vec<HMONITOR>).as_mut() {
            monitors.push(hmon);
        }
        true.into()
    }

    // ────────────── 4. is_running_elevated ──────────────

    /// Walk the parent process chain via ToolHelp32 snapshot. Returns
    /// every ancestor's exe path up to a hop limit. Caller (winExecutor)
    /// adds all of them to the prepareForAction allowlist — the actual
    /// visible terminal window owner is somewhere in this chain
    /// (axiomate ← node ← bash ← mintty ← ... etc), and we don't want
    /// to guess which exe basename it has. The system-process deny-list
    /// inside `set_app_visibility` filters out ancestors that ARE
    /// system processes (services.exe, svchost.exe, ...) so adding them
    /// to the allowlist is harmless.
    pub fn get_host_ancestor_paths() -> Vec<String> {
        let snapshot = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        // pid→ppid map from snapshot.
        let mut ppid_of: BTreeMap<u32, u32> = BTreeMap::new();
        unsafe {
            let mut entry = PROCESSENTRY32W::default();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    ppid_of.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                    entry = PROCESSENTRY32W::default();
                    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        // Walk up at most 16 hops — 99.99% of process trees are <8 deep.
        // Guards against ppid cycles (shouldn't happen on modern Windows
        // but defensive against corrupted process state).
        let mut paths: Vec<String> = Vec::new();
        let mut pid = unsafe { GetCurrentProcessId() };
        for _ in 0..MAX_PROCESS_CHAIN_DEPTH {
            let ppid = match ppid_of.get(&pid) {
                Some(p) if *p != 0 && *p != pid => *p,
                _ => break,
            };
            if let Some(path) = exe_path_for_pid(ppid) {
                paths.push(path);
            }
            pid = ppid;
        }
        paths
    }

    pub fn is_running_elevated() -> bool {
        unsafe {
            let process = GetCurrentProcess();
            let mut token = HANDLE::default();
            if OpenProcessToken(process, TOKEN_QUERY, &mut token).is_err() {
                return false;
            }
            let mut elevation = TOKEN_ELEVATION::default();
            let mut size: u32 = std::mem::size_of::<TOKEN_ELEVATION>() as u32;
            let res = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut elevation as *mut _ as *mut _),
                size,
                &mut size,
            );
            let _ = CloseHandle(token);
            if res.is_err() {
                return false;
            }
            elevation.TokenIsElevated != 0
        }
    }

    // ────────────── helpers ──────────────

    fn to_wide(s: &str) -> Vec<u16> {
        let mut v: Vec<u16> = s.encode_utf16().collect();
        v.push(0);
        v
    }

    // ────────────── unit tests ──────────────
    //
    // Run with `cargo test` from the crate root. These tests exercise the
    // helpers in this module directly (no NAPI / no JS) so coverage stays
    // deterministic and quick. GUI-state-sensitive paths (real UWP capture,
    // multi-virtual-desktop cloaking) are deliberately left to manual
    // smoke; what we cover here is the helpers a regression would silently
    // break (last-error formatting, IShellItem name resolution, AUMID
    // lookup negative path, registry walk, EnumWindows enumeration).
    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::Foundation::{SetLastError, WIN32_ERROR};

        /// ERROR_ACCESS_DENIED — known-good code for the last-error helper.
        const ERROR_ACCESS_DENIED: WIN32_ERROR = WIN32_ERROR(5);

        #[test]
        fn last_win_error_translates_known_code() {
            unsafe { SetLastError(ERROR_ACCESS_DENIED) };
            let msg = last_win_error();
            assert!(!msg.is_empty(), "last_win_error returned empty string");
            // Locale-tolerant: en-US "Access is denied", zh-CN "拒绝访问",
            // and the HRESULT hex form is always present.
            assert!(
                msg.contains("0x") || msg.to_lowercase().contains("access") || msg.contains("拒绝"),
                "last_win_error missing expected token: {}",
                msg
            );
        }

        #[test]
        fn last_win_error_no_error_returns_sentinel() {
            unsafe { SetLastError(WIN32_ERROR(0)) };
            let msg = last_win_error();
            assert_eq!(msg, "no last error set");
        }

        #[test]
        fn is_window_cloaked_returns_false_for_foreground_window() {
            // The foreground window (e.g. test runner / shell) is never
            // cloaked. Skip if there's no foreground (locked desktop / no
            // session) — `cargo test` typically has a session.
            let hwnd = unsafe { GetForegroundWindow() };
            if hwnd.0.is_null() {
                return;
            }
            assert!(!is_window_cloaked(hwnd));
        }

        #[test]
        fn list_running_apps_returns_nonempty_with_valid_entries() {
            let apps = list_running_apps();
            assert!(
                !apps.is_empty(),
                "list_running_apps empty — desktop session required"
            );
            for app in &apps {
                assert!(
                    !app.app_identifier.is_empty(),
                    "empty app_identifier in entry display_name={:?}",
                    app.display_name
                );
            }
        }

        #[test]
        fn list_installed_apps_returns_nonempty_with_valid_display_name() {
            let apps = list_installed_apps();
            assert!(!apps.is_empty(), "list_installed_apps empty");
            assert!(
                apps.iter().any(|a| !a.display_name.is_empty()),
                "no installed app had non-empty display_name"
            );
        }

        #[test]
        fn get_shell_display_name_resolves_calculator_aumid() {
            // Calculator's AUMID is stable across Win 10/11 installs.
            let aumid = "shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
            let name = get_shell_display_name(aumid);
            match name {
                Some(n) => {
                    assert!(!n.is_empty());
                    // Locale-tolerant friendly-name check. Negative
                    // assertion: resolved name must NOT contain the
                    // PublisherHash chunk (which would mean we got the
                    // AUMID back rather than a friendly name).
                    assert!(
                        !n.contains("8wekyb3d8bbwe"),
                        "expected friendly name, got AUMID-like: {}",
                        n
                    );
                }
                None => {
                    eprintln!("Calculator AUMID did not resolve; treating as env-skip");
                }
            }
        }

        #[test]
        fn get_shell_display_name_invalid_aumid_returns_none() {
            let name =
                get_shell_display_name("shell:AppsFolder\\Definitely.NotAReal_NoSuchHash!Nope");
            assert!(
                name.is_none(),
                "invalid AUMID should resolve to None, got {:?}",
                name
            );
        }

        #[test]
        fn find_window_by_aumid_no_match_for_fake_aumid() {
            let (m, _visible) =
                find_window_by_aumid("DefinitelyFake.NotARealApp_xxxxxxxxxxxxx!Nope");
            assert!(m.is_none(), "fake AUMID should not match any window");
        }

        #[test]
        fn vpoint_to_normalized_absolute_endpoints() {
            // The virtual-screen origin and far corner must map to the
            // 0..65535 range endpoints. We can't hardcode the test box's
            // virtual screen dims (varies per machine), so we read them
            // and assert the boundary mapping.
            let vx = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
            let vy = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
            let vw = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
            let vh = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
            if vw <= 1 || vh <= 1 {
                // Headless / locked-screen edge case — helper would
                // return None, so the function-level test below covers it.
                return;
            }
            // Top-left of virtual screen → (0, 0).
            let tl = vpoint_to_normalized_absolute(VPoint { x: vx, y: vy }).expect("tl ok");
            assert_eq!(tl, (0, 0));
            // Bottom-right pixel (vx + vw - 1, vy + vh - 1) → (65535, 65535).
            let br = vpoint_to_normalized_absolute(VPoint {
                x: vx + vw - 1,
                y: vy + vh - 1,
            })
            .expect("br ok");
            assert_eq!(br, (65535, 65535));
            // Monotonicity + bounds check on a sample inside the rect: a
            // pixel at offset (vw/4, vh/4) should normalize to roughly
            // 25% of 65535 (= 16383). We allow generous tolerance because
            // integer division precision varies with monitor dims.
            let q = vpoint_to_normalized_absolute(VPoint {
                x: vx + vw / 4,
                y: vy + vh / 4,
            })
            .expect("quarter ok");
            assert!(
                q.0 > 0 && q.0 < 65535 && q.1 > 0 && q.1 < 65535,
                "quarter point should be strictly inside 0..65535: {:?}",
                q
            );
            // Quarter point should land roughly in 25% region (12000..21000).
            assert!(q.0 > 12000 && q.0 < 21000, "quarter x: {}", q.0);
            assert!(q.1 > 12000 && q.1 < 21000, "quarter y: {}", q.1);
        }
    }
}
