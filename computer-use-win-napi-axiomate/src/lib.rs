//! Windows native bindings for axiomate's computer-use suite.
//!
//! Stage 1 exposes four sync `#[napi]` functions used by the
//! winExecutor (TS) running on Windows:
//!
//! 1. `list_installed_apps` — registry walk over the standard 3 Uninstall
//!    keys (HKLM 64-bit, HKLM WoW6432 32-bit redirect, HKCU per-user) to
//!    feed `request_access` with installed-app candidates. macOS uses
//!    `mdfind` + `plutil` for this; Windows uses Add-Or-Remove-Programs.
//! 2. `app_under_point(x, y)` — `WindowFromPoint` → owning pid → exe path.
//!    Used by the click safety gate to reject clicks landing on overlay
//!    windows that aren't in the user's allowlist.
//! 3. `find_window_displays(bundle_ids)` — for each requested app's
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

// ───────────────────────────────────────────────────────────────────────────
// Public NAPI types
// ───────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct InstalledApp {
    /// Stable identifier for the install. On Windows this is the registry
    /// sub-key name (often a GUID like `{ABCD-...}` or a product code).
    /// Treated as opaque by callers.
    pub bundle_id: String,
    pub display_name: String,
    /// Best-effort exe / install path. Empty when neither InstallLocation
    /// nor DisplayIcon yielded a usable path.
    pub path: String,
}

#[napi(object)]
pub struct AppHitInfo {
    /// Full exe path of the owning process — used as a stable identifier
    /// on Windows where there's no bundle-id concept analogous to mac.
    pub bundle_id: String,
    /// Basename of the exe (e.g. "chrome.exe") for display.
    pub display_name: String,
}

/// Monitor RECT in raw Win32 physical pixel coords (same space as
/// `node-screenshots` Monitor.x()/y()/width()/height() on Windows).
/// The agent layer matches these against `node-screenshots` to recover
/// the displayId — see winExecutor.findWindowDisplays. This decouples
/// the win NAPI from node-screenshots' internal ID scheme (which
/// derives from device path hash, not HMONITOR).
#[napi(object)]
pub struct WindowMonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[napi(object)]
pub struct WindowMonitorInfo {
    pub bundle_id: String,
    /// All monitor rects whose bounds intersect any of this app's
    /// visible top-level window rects. Multi-monitor windows produce
    /// multiple rects (matches mac NAPI semantics — mac uses
    /// CGRect intersection across all CGDisplays).
    pub monitor_rects: Vec<WindowMonitorRect>,
}

/// JPEG image returned by capture_window. Same {base64, width, height}
/// shape as mac NAPI's CaptureWindowImage so the agent's screenshotWindow
/// adapter doesn't need a platform branch in the result handling.
#[napi(object)]
pub struct CaptureWindowImage {
    pub base64: String,
    pub width: i64,
    pub height: i64,
}

/// Outcome of capture_window. Mirrors mac NAPI exactly. `image` is null
/// when any step failed; `diagnostic` says why so the agent can surface
/// it via logForDebugging.
#[napi(object)]
pub struct CaptureWindowOutcome {
    pub image: Option<CaptureWindowImage>,
    pub diagnostic: String,
}

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
pub fn app_under_point(x: i32, y: i32) -> napi::Result<Option<AppHitInfo>> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::app_under_point(x, y))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y);
        Ok(None)
    }
}

/// For each requested bundle id, return monitor RECTs (Win32 physical
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
    bundle_ids: Vec<String>,
) -> napi::Result<Vec<WindowMonitorInfo>> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::find_window_monitor_rects(&bundle_ids))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(bundle_ids
            .into_iter()
            .map(|bundle_id| WindowMonitorInfo {
                bundle_id,
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

/// Get the bundle id (full exe path) + display name (basename) of the
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
/// `bundle_id` is the full exe path (e.g. `C:\\Program Files\\Slack\\Slack.exe`)
/// — same value as `app_under_point().bundleId` and `find_window_displays`
/// inputs. Returns true if at least one window was hidden.
///
/// Used by winExecutor's `prepareForAction` to clear non-allowlist apps
/// before a screenshot or click action. Mirror of mac
/// `NSRunningApplication.hide`. UIPI: non-elevated axiomate calling
/// ShowWindow on an admin-owned window silently fails (returns false) —
/// no UAC, no error. caller logs a warn but doesn't refuse the action.
#[napi]
pub fn hide_app(bundle_id: String) -> napi::Result<bool> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::set_app_visibility(&bundle_id, false))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = bundle_id;
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
pub fn unhide_app(bundle_id: String) -> napi::Result<bool> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::set_app_visibility(&bundle_id, true))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = bundle_id;
        Ok(false)
    }
}

/// Capture the frontmost visible window of the given app. `bundle_id`
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
pub fn capture_window(bundle_id: String) -> napi::Result<CaptureWindowOutcome> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::capture_window(&bundle_id))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = bundle_id;
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
/// Source coords (`physical_x/y`) and source size (`physical_w/h`) are
/// in Win32 physical-pixel virtual-screen space — same coord system as
/// `node-screenshots` Monitor.x()/y()/width()/height(). Caller multiplies
/// the logical DisplayGeometry by scaleFactor to get these. Source rect
/// can lie at any virtual-screen offset for multi-monitor setups
/// (negative x for monitors left of the primary).
///
/// Returns `None` on failure (BitBlt 0 / GetDIBits 0 lines / encode
/// fails) — agent layer falls back to `base.screenshot` (unfiltered,
/// unresized; click coords will be off but better than no screenshot).
/// `jpeg_quality` is 0–100 (75 to match mac path's 0.75 default).
#[napi]
pub fn capture_display_scaled(
    physical_x: i32,
    physical_y: i32,
    physical_w: u32,
    physical_h: u32,
    target_w: u32,
    target_h: u32,
    jpeg_quality: u32,
) -> napi::Result<Option<DisplayCaptureResult>> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::capture_display_scaled(
            physical_x,
            physical_y,
            physical_w,
            physical_h,
            target_w,
            target_h,
            jpeg_quality.min(100) as u8,
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (
            physical_x, physical_y, physical_w, physical_h, target_w, target_h, jpeg_quality,
        );
        Ok(None)
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
    pub allowed_bundle_ids: Vec<String>,
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

/// Enumerate currently-running apps that have at least one visible
/// top-level window. Returns each unique app once with its full exe
/// path as `bundle_id` (matching what `hide_app` / `find_window_displays`
/// expect), and the exe basename as `display_name`.
///
/// Equivalent of mac's `NSWorkspace.runningApplications` filtered to
/// `activationPolicy == .regular`, but exe-path-based instead of bundle-
/// id-based since Windows has no formal bundle identifier.
///
/// winExecutor uses this to drive `prepareForAction`'s hide loop —
/// PowerShell-based listRunningApps returns ProcessName ("chrome") which
/// doesn't match the exe-path bundleId model the rest of the win NAPI
/// uses. This binding keeps the bundleId space consistent.
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
// Windows-specific implementations
// ───────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{
        AppHitInfo, CaptureWindowImage, CaptureWindowOutcome, DisplayCaptureResult,
        InstalledApp, WindowMonitorInfo, WindowMonitorRect,
    };
    use base64::Engine;
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::Path;

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, BOOL, ERROR_NO_MORE_ITEMS, HANDLE, HWND, LPARAM, POINT, RECT,
    };
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
        EnumDisplayMonitors, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HMONITOR, SRCCOPY,
    };
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY,
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
        REG_VALUE_TYPE,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
        QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
        IsIconic, IsWindowVisible, ShowWindow, WindowFromPoint, SHOW_WINDOW_CMD,
        SW_HIDE, SW_SHOWNOACTIVATE,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};

    /// PW_RENDERFULLCONTENT — render DWM-composited content (Chrome, Electron,
    /// WebView2). Without this, modern Windows apps capture as a black bitmap.
    /// 0x2 per Win32 docs (windows crate's PRINT_WINDOW_FLAGS is open enum).
    const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(0x2);

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
                if RegOpenKeyExW(root, PCWSTR(sub_w.as_ptr()), 0, access, &mut sub_hkey).is_err()
                {
                    continue;
                }
            }
            let display_name = read_string_value(sub_hkey, "DisplayName").unwrap_or_default();
            // InstallLocation read but unused after the bundleId-unification:
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
            // bundle_id (= path, see below) wouldn't round-trip with
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
                "setup.exe",       // sometimes installers self-register their setup as DisplayIcon
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
            if path
                .to_lowercase()
                .contains("\\package cache\\")
            {
                continue;
            }
            // Dedupe by exe path (case-insensitive). Same app can have
            // multiple sub-keys (e.g. `Slack` + `{GUID}_is1` from the
            // installer's record-keeping). Keep the first hit.
            let path_key = path.to_lowercase();
            if !seen_paths.insert(path_key) {
                continue;
            }
            // bundle_id = path. **Critical**: this is the SAME identifier
            // shape used by app_under_point / list_running_apps / hide_app
            // / find_window_displays — so request_access → click chain
            // round-trips correctly. Pre-fix, list_installed_apps used
            // the registry sub-key name, which never matched what the
            // running-window queries returned, breaking the allowlist
            // safety gate end to end.
            out.push(InstalledApp {
                bundle_id: path.clone(),
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
            if s[pos + 1..].trim().chars().all(|c| c.is_ascii_digit() || c == '-') {
                s.truncate(pos);
            }
        }
        let trimmed = s.trim().trim_matches('"').to_string();
        trimmed
    }

    // ────────────── 2. app_under_point ──────────────

    pub fn app_under_point(x: i32, y: i32) -> Option<AppHitInfo> {
        let pt = POINT { x, y };
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
            bundle_id: path,
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
                bundle_id: path,
            });
        }
        true.into()
    }

    /// Module-level state for find_window_enum_proc.
    struct FindState {
        target_path: String,
        found: Option<isize>,
        pid_to_path: BTreeMap<u32, String>,
    }

    /// Find the first visible top-level window owned by the app at
    /// `bundle_id` (full exe path). Returns the HWND or None when no
    /// visible window matches. Walks EnumWindows; stops at first hit.
    fn find_first_visible_window_for_bundle(bundle_id: &str) -> Option<HWND> {
        let mut state = FindState {
            target_path: bundle_id.to_string(),
            found: None,
            pid_to_path: BTreeMap::new(),
        };
        unsafe {
            let _ = EnumWindows(
                Some(find_window_enum_proc),
                LPARAM(&mut state as *mut _ as isize),
            );
        }
        state.found.map(|v| HWND(v as *mut std::ffi::c_void))
    }

    unsafe extern "system" fn find_window_enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state_ptr = lparam.0 as *mut FindState;
        let state = match state_ptr.as_mut() {
            Some(s) => s,
            None => return false.into(),
        };
        if state.found.is_some() {
            return false.into();   // already found, stop enumeration
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
        state.found = Some(hwnd.0 as isize);
        false.into()   // stop enumeration
    }

    /// Capture the frontmost visible window for `bundle_id`. PrintWindow
    /// path with PW_RENDERFULLCONTENT for DWM compatibility. Returns a
    /// CaptureWindowOutcome with image=None and a diagnostic on any
    /// failure step.
    pub fn capture_window(bundle_id: &str) -> CaptureWindowOutcome {
        let hwnd = match find_first_visible_window_for_bundle(bundle_id) {
            Some(h) => h,
            None => {
                return CaptureWindowOutcome {
                    image: None,
                    diagnostic: format!(
                        "no visible top-level window for bundle '{bundle_id}' — \
                         app not running, all windows minimized, or running \
                         under a different exe path. Use list_running_apps to \
                         confirm the bundle id you expect to be active."
                    ),
                };
            }
        };

        // Get window rect (full window including chrome — matches mac
        // CGWindowListCreateImage behavior, which captures the whole
        // window including title/resize borders).
        let mut rect = RECT::default();
        let rect_ok = unsafe { GetWindowRect(hwnd, &mut rect) };
        if rect_ok.is_err() {
            return CaptureWindowOutcome {
                image: None,
                diagnostic: format!(
                    "GetWindowRect failed for hwnd={:?} bundle '{bundle_id}': {:?}",
                    hwnd.0, rect_ok
                ),
            };
        }
        let width = (rect.right - rect.left).max(0);
        let height = (rect.bottom - rect.top).max(0);
        if width == 0 || height == 0 {
            return CaptureWindowOutcome {
                image: None,
                diagnostic: format!(
                    "zero-sized window rect for bundle '{bundle_id}': \
                     {width}x{height}"
                ),
            };
        }

        // Set up DC + bitmap. RAII via early-return + manual cleanup
        // since the windows crate doesn't auto-drop GDI objects. We use
        // a guard pattern by tracking what's been created and DeleteDC /
        // DeleteObject in the right order on each exit.
        let result = unsafe { capture_window_inner(hwnd, width, height) };
        match result {
            Ok(image) => CaptureWindowOutcome {
                image: Some(image),
                diagnostic: "ok".to_string(),
            },
            Err(diag) => CaptureWindowOutcome {
                image: None,
                diagnostic: format!("bundle '{bundle_id}': {diag}"),
            },
        }
    }

    /// Inner capture path; returns Result so we can `?` through the
    /// fallible GDI calls. All cleanup via guards. unsafe because every
    /// GDI call below is unsafe in the windows crate.
    unsafe fn capture_window_inner(
        hwnd: HWND,
        width: i32,
        height: i32,
    ) -> Result<CaptureWindowImage, String> {
        // Screen DC for compat-bitmap creation. windows-rs 0.58 doesn't
        // accept Option<HWND> — pass HWND::default() (null) which the
        // GetDC docs accept as "the entire screen".
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
                unsafe { let _ = DeleteDC(self.0); };
            }
        }
        let _mem_dc_guard = MemDcGuard(mem_dc);

        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
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

        // PrintWindow with PW_RENDERFULLCONTENT for DWM windows. Returns
        // BOOL — false means it didn't draw. Try BitBlt fallback if so.
        let print_ok = PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT).as_bool();
        if !print_ok {
            // BitBlt fallback — works for non-DWM (very rare on Win10+).
            let win_dc = GetDC(hwnd);
            if win_dc.0.is_null() {
                return Err("PrintWindow returned 0 and GetDC(hwnd) failed".to_string());
            }
            let blt_ok = BitBlt(mem_dc, 0, 0, width, height, win_dc, 0, 0, SRCCOPY)
                .is_ok();
            ReleaseDC(hwnd, win_dc);
            if !blt_ok {
                return Err("PrintWindow returned 0 and BitBlt fallback failed".to_string());
            }
        }

        // Read pixels via GetDIBits. We request 32bpp top-down (negative
        // height in BITMAPINFOHEADER) so we don't need to flip rows after.
        let row_size = (width as usize) * 4;
        let buf_size = row_size * (height as usize);
        let mut buf = vec![0u8; buf_size];
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width;
        bmi.bmiHeader.biHeight = -height; // negative = top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;

        let lines = GetDIBits(
            mem_dc,
            bitmap,
            0,
            height as u32,
            Some(buf.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        if lines == 0 {
            return Err("GetDIBits returned 0 lines".to_string());
        }

        // BGRA → RGB. Same conversion as mac NAPI cg_image_to_jpeg_base64.
        let mut rgb = Vec::with_capacity((width as usize) * (height as usize) * 3);
        for px in buf.chunks_exact(4) {
            rgb.push(px[2]); // R
            rgb.push(px[1]); // G
            rgb.push(px[0]); // B
        }

        let mut jpeg = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85);
        encoder
            .encode(
                &rgb,
                width as u32,
                height as u32,
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| format!("jpeg encode failed: {e}"))?;

        let base64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
        Ok(CaptureWindowImage {
            base64,
            width: width as i64,
            height: height as i64,
        })
    }

    // ────────────── capture_display_scaled ──────────────

    /// Same BitBlt+GetDIBits+Lanczos+JPEG pipeline as capture_window_inner
    /// but: (a) source rect is the desktop DC at (physical_x, physical_y)
    /// instead of (0,0), (b) inserts a Lanczos resize step before encode
    /// so the output JPEG matches what the API server would have resized
    /// to anyway. None on any failure → agent falls back to base.screenshot.
    pub fn capture_display_scaled(
        physical_x: i32,
        physical_y: i32,
        physical_w: u32,
        physical_h: u32,
        target_w: u32,
        target_h: u32,
        jpeg_quality: u8,
    ) -> Option<DisplayCaptureResult> {
        if physical_w == 0 || physical_h == 0 || target_w == 0 || target_h == 0 {
            return None;
        }
        let result = unsafe {
            capture_display_scaled_inner(
                physical_x,
                physical_y,
                physical_w as i32,
                physical_h as i32,
                target_w,
                target_h,
                jpeg_quality,
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
        src_x: i32,
        src_y: i32,
        src_w: i32,
        src_h: i32,
        target_w: u32,
        target_h: u32,
        jpeg_quality: u8,
    ) -> Result<DisplayCaptureResult, String> {
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
                unsafe { let _ = DeleteDC(self.0); };
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
                unsafe { let _ = DeleteObject(self.0); };
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
        let blt_ok = BitBlt(
            mem_dc, 0, 0, src_w, src_h, screen_dc, src_x, src_y, SRCCOPY,
        )
        .is_ok();
        if !blt_ok {
            return Err("BitBlt failed".to_string());
        }

        // 32bpp top-down BGRA — same as capture_window_inner.
        let row_size = (src_w as usize) * 4;
        let buf_size = row_size * (src_h as usize);
        let mut buf = vec![0u8; buf_size];
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = src_w;
        bmi.bmiHeader.biHeight = -src_h; // negative = top-down
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

        // BGRA → RGB.
        let mut rgb = Vec::with_capacity((src_w as usize) * (src_h as usize) * 3);
        for px in buf.chunks_exact(4) {
            rgb.push(px[2]);
            rgb.push(px[1]);
            rgb.push(px[0]);
        }

        // Resize step. Skipped when target == source (small monitors
        // already inside the API's token budget). Lanczos3 — slightly
        // sharper than Triangle/CatmullRom for screenshot text/icons.
        let (final_rgb, final_w, final_h) = if target_w as i32 == src_w
            && target_h as i32 == src_h
        {
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

        let mut jpeg = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, jpeg_quality);
        encoder
            .encode(
                &final_rgb,
                final_w,
                final_h,
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| format!("jpeg encode failed: {e}"))?;

        let base64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
        Ok(DisplayCaptureResult {
            base64,
            width: final_w as i64,
            height: final_h as i64,
        })
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
            bundle_id: path,
        })
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
        "explorer.exe",                  // Taskbar, desktop, File Explorer
        "dwm.exe",                       // Desktop Window Manager (compositor)
        "sihost.exe",                    // Shell Infrastructure Host
        "ctfmon.exe",                    // Text services framework
        "csrss.exe",                     // Client Server Runtime (kernel-adjacent)
        "winlogon.exe",                  // Logon manager
        "logonui.exe",                   // Lock screen / login UI
        "lockapp.exe",                   // Win11 lock screen
        "searchhost.exe",                // Win11 search overlay
        "startmenuexperiencehost.exe",   // Win11 Start menu
        "shellexperiencehost.exe",       // Win10/11 shell experience
        "textinputhost.exe",             // Win11 IME / handwriting
        "applicationframehost.exe",      // UWP frame host
        "systemsettings.exe",            // Windows Settings (UWP)
        "fontdrvhost.exe",               // Font driver host
        "wininit.exe",                   // Boot init
        "smss.exe",                      // Session Manager
        "services.exe",                  // SCM (won't have windows but defensive)
    ];

    fn is_protected_system_process(path: &str) -> bool {
        let lower = path.to_lowercase();
        let basename = lower.rsplit(['\\', '/']).next().unwrap_or(&lower);
        SYSTEM_HIDE_DENY_LIST.iter().any(|p| *p == basename)
    }

    /// Set visibility of every top-level window owned by `bundle_id` to
    /// either hidden (false) or shown (true). Walks EnumWindows once; for
    /// each window resolves owner pid → exe path (cached per call) and
    /// matches against bundle_id. Returns true iff at least one window's
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
    pub fn set_app_visibility(bundle_id: &str, show: bool) -> bool {
        if is_protected_system_process(bundle_id) {
            return false;
        }
        let mut state = VisState {
            target_path: bundle_id.to_string(),
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
        let cmd: SHOW_WINDOW_CMD = if state.show { SW_SHOWNOACTIVATE } else { SW_HIDE };
        let _ = ShowWindow(hwnd, cmd);
        state.changed = true;
        true.into()
    }

    /// Resolve `pid` → full exe path via PROCESS_QUERY_LIMITED_INFORMATION
    /// (no admin needed; works against any user-level process). Returns
    /// None on access denied (target is elevated and we're not).
    fn exe_path_for_pid(pid: u32) -> Option<String> {
        unsafe {
            let handle: HANDLE =
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
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
        bundle_set: BTreeSet<String>,
        /// bundle_id → set of (x, y, w, h) monitor rects intersecting any
        /// window of that bundle. Tuple is hashable so a BTreeSet dedupes
        /// — multi-window apps that all sit on the same monitor produce
        /// one entry.
        results: BTreeMap<String, BTreeSet<(i32, i32, i32, i32)>>,
        pid_to_path: BTreeMap<u32, String>,
        /// All active monitors with their full rects, computed once per
        /// call (`list_monitor_rects`). Used to test which monitors
        /// each window intersects.
        monitors: Vec<MonitorRect>,
    }

    #[derive(Clone, Copy)]
    struct MonitorRect {
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    }

    pub fn find_window_monitor_rects(bundle_ids: &[String]) -> Vec<WindowMonitorInfo> {
        if bundle_ids.is_empty() {
            return Vec::new();
        }
        let monitors = list_monitor_rects();
        if monitors.is_empty() {
            return bundle_ids
                .iter()
                .map(|bid| WindowMonitorInfo {
                    bundle_id: bid.clone(),
                    monitor_rects: vec![],
                })
                .collect();
        }
        let mut state = WindowEnumState {
            bundle_set: bundle_ids.iter().cloned().collect(),
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
        bundle_ids
            .iter()
            .map(|bid| WindowMonitorInfo {
                bundle_id: bid.clone(),
                monitor_rects: state
                    .results
                    .get(bid)
                    .map(|s| {
                        s.iter()
                            .map(|(x, y, w, h)| WindowMonitorRect {
                                x: *x,
                                y: *y,
                                width: *w,
                                height: *h,
                            })
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
        if path.is_empty() || !state.bundle_set.contains(&path) {
            return true.into();
        }
        // Window rect (Win32 RECT, physical px on per-monitor-DPI-aware
        // process — same coord space as our monitor rects from
        // GetMonitorInfoW).
        let mut win_rect = RECT::default();
        if GetWindowRect(hwnd, &mut win_rect).is_err() {
            return true.into();
        }
        // Test against every monitor — multi-monitor windows produce
        // multiple entries (matches mac NAPI's CGRect intersection
        // semantics; a window straddling two monitors lights up both).
        for m in &state.monitors {
            if rects_intersect(&win_rect, m) {
                state
                    .results
                    .entry(path.clone())
                    .or_default()
                    .insert((m.x, m.y, m.width, m.height));
            }
        }
        true.into()
    }

    fn rects_intersect(win: &RECT, mon: &MonitorRect) -> bool {
        let mon_right = mon.x + mon.width;
        let mon_bottom = mon.y + mon.height;
        win.left < mon_right
            && win.right > mon.x
            && win.top < mon_bottom
            && win.bottom > mon.y
    }

    /// Enumerate active monitors with their full rects via
    /// EnumDisplayMonitors + GetMonitorInfoW. Coords match
    /// `node-screenshots` Monitor.x()/y()/width()/height() on Windows
    /// (both query the same Win32 path with the same DPI awareness as
    /// the host process).
    fn list_monitor_rects() -> Vec<MonitorRect> {
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
                Some(MonitorRect {
                    x: info.rcMonitor.left,
                    y: info.rcMonitor.top,
                    width: info.rcMonitor.right - info.rcMonitor.left,
                    height: info.rcMonitor.bottom - info.rcMonitor.top,
                })
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
        let snapshot = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        {
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
        for _ in 0..16 {
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
}
