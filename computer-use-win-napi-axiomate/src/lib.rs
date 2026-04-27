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

#[napi(object)]
pub struct WindowDisplayInfo {
    pub bundle_id: String,
    pub display_ids: Vec<u32>,
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

#[napi]
pub fn find_window_displays(
    bundle_ids: Vec<String>,
) -> napi::Result<Vec<WindowDisplayInfo>> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::find_window_displays(&bundle_ids))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(bundle_ids
            .into_iter()
            .map(|bundle_id| WindowDisplayInfo {
                bundle_id,
                display_ids: vec![],
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
    use super::{AppHitInfo, InstalledApp, WindowDisplayInfo};
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::Path;

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, BOOL, ERROR_NO_MORE_ITEMS, HANDLE, HWND, LPARAM, POINT, RECT,
    };
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, MonitorFromWindow, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY,
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
        REG_VALUE_TYPE,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
        PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindowThreadProcessId, IsWindowVisible,
        ShowWindow, WindowFromPoint, SHOW_WINDOW_CMD, SW_HIDE, SW_SHOWNOACTIVATE,
    };

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
        // Dedupe by sub-key name + DisplayName — same app can appear in
        // both 64-bit and 32-bit views (e.g. Office). Keep the first hit.
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for (root, view_flag) in UNINSTALL_ROOTS {
            collect_from_root(*root, *view_flag, &mut out, &mut seen);
        }
        out
    }

    fn collect_from_root(
        root: HKEY,
        view_flag: u32,
        out: &mut Vec<InstalledApp>,
        seen: &mut BTreeSet<String>,
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
            if seen.contains(&sub_name) {
                continue;
            }
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
            let install_location =
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
            // Resolve a path. InstallLocation when present (folder); else
            // strip ",N" icon-index suffix from DisplayIcon and trim quotes.
            let path = if !install_location.is_empty() {
                install_location
            } else if !display_icon.is_empty() {
                normalize_display_icon(&display_icon)
            } else {
                String::new()
            };
            seen.insert(sub_name.clone());
            out.push(InstalledApp {
                bundle_id: sub_name,
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

    /// Set visibility of every top-level window owned by `bundle_id` to
    /// either hidden (false) or shown (true). Walks EnumWindows once; for
    /// each window resolves owner pid → exe path (cached per call) and
    /// matches against bundle_id. Returns true iff at least one window's
    /// visibility was changed.
    ///
    /// We filter by current visibility matching the change direction: hide
    /// only acts on visible windows; show only on hidden ones. This keeps
    /// the operation idempotent and avoids re-showing windows the app had
    /// explicitly hidden for its own reasons.
    pub fn set_app_visibility(bundle_id: &str, show: bool) -> bool {
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

    // ────────────── 3. find_window_displays ──────────────

    /// Mutable accumulator passed via LPARAM through EnumWindows callback.
    /// Defined at module scope (rather than inside `find_window_displays`)
    /// so the extern "system" callback can reference it by name — that's
    /// rust-idiomatic and avoids a repr(C) layout-duplicate trick.
    struct WindowEnumState {
        /// exe paths the caller asked about (lookup set).
        bundle_set: BTreeSet<String>,
        /// exe path → set of monitor indices (output).
        results: BTreeMap<String, BTreeSet<u32>>,
        /// pid → resolved exe path; "" sentinel = lookup failed once,
        /// don't retry. Avoids re-OpenProcess for windows owned by the
        /// same process.
        pid_to_path: BTreeMap<u32, String>,
        /// Monitor enumeration used to map HMONITOR → stable index.
        monitors: Vec<HMONITOR>,
    }

    pub fn find_window_displays(bundle_ids: &[String]) -> Vec<WindowDisplayInfo> {
        // Empty input → empty output (preserves caller order semantics).
        if bundle_ids.is_empty() {
            return Vec::new();
        }
        let monitors = list_monitors();
        if monitors.is_empty() {
            return bundle_ids
                .iter()
                .map(|bid| WindowDisplayInfo {
                    bundle_id: bid.clone(),
                    display_ids: vec![],
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
            .map(|bid| WindowDisplayInfo {
                bundle_id: bid.clone(),
                display_ids: state
                    .results
                    .get(bid)
                    .map(|s| s.iter().copied().collect())
                    .unwrap_or_default(),
            })
            .collect()
    }

    /// EnumWindows callback. The lparam carries `&mut WindowEnumState`.
    unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // Skip hidden windows — we want monitor mapping for what user sees.
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
        // Resolve / cache exe path.
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
        // Determine which monitor this window is on.
        let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let display_id = state
            .monitors
            .iter()
            .position(|m| m.0 == hmon.0)
            .map(|i| i as u32);
        if let Some(id) = display_id {
            state.results.entry(path).or_default().insert(id);
        }
        true.into()
    }

    fn list_monitors() -> Vec<HMONITOR> {
        let mut monitors: Vec<HMONITOR> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(enum_monitors_proc),
                LPARAM(&mut monitors as *mut _ as isize),
            );
        }
        monitors
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
