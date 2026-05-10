//! macOS native bindings for axiomate's computer-use suite.
//!
//! Exposes three feature groups via napi-rs:
//!
//! 1. NSRunningApplication.hide / unhide / activate — used by
//!    `cu.apps.prepareDisplay` to clear non-allowlisted windows before a
//!    screenshot or click action, then `cu.apps.unhide` to restore them.
//! 2. CGEventTap on the keyDown stream filtered to Escape — global Esc
//!    hotkey for "abort the running computer-use turn". `notifyExpectedEscape`
//!    sets a short-lived decay gate so the agent's own synthesized Esc
//!    presses (via `key("escape")`) don't abort the turn.
//! 3. CGWindowListCreateImage per-window screenshot — capture the frontmost
//!    window of a specific bundle id. Backs the `screenshot_window` MCP
//!    tool. Resolves bundle id → pid → CGWindowID → JPEG.
//!
//! Non-macOS builds compile to a stub that returns false / null for every
//! function so the JS side's existing fallbacks engage automatically.

use napi_derive::napi;

// ───────────────────────────────────────────────────────────────────────────
// NSRunningApplication.hide / unhide / activate
// ───────────────────────────────────────────────────────────────────────────

#[napi]
pub async fn hide_app(app_identifier: String) -> napi::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos::running_app::hide(&app_identifier))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_identifier;
        Ok(false)
    }
}

#[napi]
pub async fn unhide_app(app_identifier: String) -> napi::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos::running_app::unhide(&app_identifier))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_identifier;
        Ok(false)
    }
}

#[napi]
pub async fn activate_app(app_identifier: String) -> napi::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos::running_app::activate(&app_identifier))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_identifier;
        Ok(false)
    }
}

// ───────────────────────────────────────────────────────────────────────────
// CGEventTap — global Esc hotkey
// ───────────────────────────────────────────────────────────────────────────

#[napi(ts_args_type = "callback: () => void")]
pub fn register_escape_hotkey(callback: napi::threadsafe_function::ThreadsafeFunction<()>) -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::escape_tap::register(callback)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = callback;
        false
    }
}

#[napi]
pub fn unregister_escape_hotkey() {
    #[cfg(target_os = "macos")]
    macos::escape_tap::unregister();
}

#[napi]
pub fn notify_expected_escape() {
    #[cfg(target_os = "macos")]
    macos::escape_tap::notify_expected_escape();
}

// ───────────────────────────────────────────────────────────────────────────
// Allowlist-filtered screenshot stub
// ───────────────────────────────────────────────────────────────────────────

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
    let _ = opts;
    Ok(None)
}

// ───────────────────────────────────────────────────────────────────────────
// Window-display mapping & hit-testing (CGWindowListCopyWindowInfo)
// ───────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct WindowDisplayInfo {
    pub app_identifier: String,
    pub display_ids: Vec<u32>,
}

#[napi(object)]
pub struct AppHitInfo {
    pub app_identifier: String,
    pub display_name: String,
}

#[napi(object)]
pub struct VPoint {
    pub x: i32,
    pub y: i32,
}

#[napi(object)]
pub struct VSize {
    pub w: u32,
    pub h: u32,
}

#[napi(object)]
pub struct VRect {
    pub origin: VPoint,
    pub size: VSize,
}

#[napi(object)]
pub struct UiElement {
    pub bbox: VRect,
    pub name: String,
    pub role: String,
    pub automation_id: Option<String>,
    pub uia_source: Option<String>,
}

/// For each requested app identifier (CFBundleIdentifier on macOS), return the set of CGDisplayIDs whose
/// `CGDisplayBounds` rect intersects any of that app's on-screen window
/// rects. Empty `display_ids` means the app has no visible windows on any
/// display (minimized, off-screen, or not running).
///
/// Used by `request_access` to populate `windowLocations` so the LLM can
/// reason about multi-monitor setups (e.g. "Slack is on display 2, click
/// requires switch_display first").
#[napi]
pub fn find_window_displays(app_identifiers: Vec<String>) -> napi::Result<Vec<WindowDisplayInfo>> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos::cg_window_query::find_window_displays(&app_identifiers))
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Stub: return empty display lists for each requested bundle.
        Ok(app_identifiers
            .into_iter()
            .map(|app_identifier| WindowDisplayInfo {
                app_identifier,
                display_ids: vec![],
            })
            .collect())
    }
}

/// Hit-test the topmost on-screen window at logical screen coordinates
/// (x, y). Returns `Some(AppHitInfo)` for the owning app, or `None` when
/// no window covers that point (cursor on bare desktop) or hit-test
/// itself failed.
///
/// Used by the click safety gate: when the topmost app under the click
/// point isn't in the user's allowlist, the click is rejected to avoid
/// AI fat-fingering an overlay (notification, password autofill,
/// 1Password panel) that sits above the intended target.
#[napi]
pub fn app_under_point(x: i32, y: i32) -> napi::Result<Option<AppHitInfo>> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos::cg_window_query::app_under_point(x, y))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (x, y);
        Ok(None)
    }
}

#[napi]
pub async fn enumerate_ui_elements_in_rect(
    rect: VRect,
    window_only: Option<bool>,
) -> napi::Result<Vec<UiElement>> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos::ax_query::enumerate_ui_elements_in_rect(
            rect,
            window_only.unwrap_or(false),
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (rect, window_only);
        Ok(Vec::new())
    }
}

#[napi]
pub async fn enumerate_ui_elements_for_app_in_rect(
    app_identifier: String,
    rect: VRect,
) -> napi::Result<Vec<UiElement>> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos::ax_query::enumerate_ui_elements_for_app_in_rect(
            &app_identifier,
            rect,
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app_identifier, rect);
        Ok(Vec::new())
    }
}

#[napi]
pub async fn element_from_point(x: i32, y: i32) -> napi::Result<Option<UiElement>> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos::ax_query::element_from_point(x, y))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (x, y);
        Ok(None)
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Per-window screenshot via CGWindowListCreateImage
// ───────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct CaptureWindowImage {
    pub base64: String,
    pub width: i64,
    pub height: i64,
    pub origin_x: i64,
    pub origin_y: i64,
    pub display_width: i64,
    pub display_height: i64,
}

/// Result of `capture_window`. Always returned (no top-level Option) so the
/// caller can read `diagnostic` even when `image` is null. The diagnostic
/// flows through agent/src/utils/computerUse/executor.ts → logForDebugging
/// → ~/.axiomate/debug/latest, giving humans visibility into which step
/// failed (find_pid / find_window / CGWindowListCreateImage / TCC).
#[napi(object)]
pub struct CaptureWindowOutcome {
    /// JPEG image when capture succeeded; null when any step failed.
    pub image: Option<CaptureWindowImage>,
    /// Human-readable description of the path taken. "ok" on success;
    /// otherwise names the failed step and includes pid / candidate
    /// windowIDs / layers / TCC hints as applicable.
    pub diagnostic: String,
}

#[napi]
pub async fn capture_window(
    app_identifier: String,
) -> napi::Result<CaptureWindowOutcome> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos::cg_window_capture::capture_window(app_identifier).await)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_identifier;
        Ok(CaptureWindowOutcome {
            image: None,
            diagnostic: "native binding not built for this platform".to_string(),
        })
    }
}

// ───────────────────────────────────────────────────────────────────────────
// macOS-specific implementations
// ───────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    fn ax_som_debug_enabled() -> bool {
        std::env::args().any(|arg| arg == "--debug" || arg == "-d")
            || matches!(
                std::env::var("DEBUG"),
                Ok(v) if matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
            )
    }

    fn append_ax_som_debug_log(line: &str) {
        if !ax_som_debug_enabled() {
            return;
        }
        let home = std::env::var("AXIOMATE_CONFIG_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                std::env::var("HOME")
                    .map(|h| std::path::PathBuf::from(h).join(".axiomate"))
                    .unwrap_or_else(|_| std::path::PathBuf::from(".axiomate"))
            });
        let dir = home.join("debug");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("mac-ax-som.log");
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| {
                use std::io::Write;
                writeln!(f, "{line}")
            });
    }

    pub mod running_app {
        use objc2::msg_send;
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2_app_kit::{NSRunningApplication, NSWorkspace};
        use objc2_foundation::NSString;

        /// Iterate `NSWorkspace.sharedWorkspace.runningApplications`, invoke
        /// `action` on every running instance whose bundle id matches.
        /// Returns true if at least one app received the action.
        ///
        /// Wrapped in unsafe because every method on NSRunningApplication /
        /// NSWorkspace is unsafe under objc2 (interaction with Obj-C runtime
        /// can raise, can return nil where Rust expects non-null, etc.).
        unsafe fn for_each_matching(
            app_identifier: &str,
            action: impl Fn(&NSRunningApplication),
        ) -> bool {
            let workspace = NSWorkspace::sharedWorkspace();
            let running = workspace.runningApplications();
            let count = running.count();
            let mut hit = false;
            // Index NSArray by integer — objc2-foundation 0.2's NSArray<T>
            // implements `Index<usize, Output = T>`. Avoid `.iter()` (not on
            // Retained<NSArray<T>> in 0.2) and Obj-C string compare (use
            // Rust str equality after bridging through to_string()).
            for i in 0..count {
                let app: &NSRunningApplication = &running[i];
                let bid: Option<Retained<NSString>> = app.bundleIdentifier();
                if let Some(bid) = bid {
                    if bid.to_string() == app_identifier {
                        action(app);
                        hit = true;
                    }
                }
            }
            hit
        }

        // hide / unhide / activate go through `msg_send!` directly. The
        // alternative — calling Rust binding methods like `app.hide()` —
        // depends on which selectors objc2-app-kit 0.2 exposes on
        // NSRunningApplication. activate() (no args, macOS 14+) isn't
        // bound there yet, and we want consistent codepath, so route all
        // three through Obj-C runtime selectors. Selectors have been
        // stable on NSRunningApplication since 10.6 (hide / unhide) and
        // 10.6 (activateWithOptions:).

        pub fn hide(app_identifier: &str) -> bool {
            unsafe { for_each_matching(app_identifier, |app| {
                let _: () = msg_send![app, hide];
            }) }
        }

        pub fn unhide(app_identifier: &str) -> bool {
            unsafe { for_each_matching(app_identifier, |app| {
                let _: () = msg_send![app, unhide];
            }) }
        }

        pub fn activate(app_identifier: &str) -> bool {
            unsafe { for_each_matching(app_identifier, |app| {
                // Pass 0 as default options (NSApplicationActivateAllWindows = 1
                // is the only nontrivial flag pre-14; default 0 is fine for
                // prepareDisplay's "bring forward" use).
                let _: () = msg_send![app, activateWithOptions: 0usize];
            }) }
        }

        /// Returns the OS pid (i32 / pid_t) for the first running app whose
        /// bundle id matches, or None if no instance is running. Used by
        /// `cg_window_capture` to map bundle id → pid for window enumeration.
        pub unsafe fn find_pid_for_app(app_identifier: &str) -> Option<i32> {
            let workspace = NSWorkspace::sharedWorkspace();
            let running = workspace.runningApplications();
            let count = running.count();
            for i in 0..count {
                let app: &NSRunningApplication = &running[i];
                let bid: Option<Retained<NSString>> = app.bundleIdentifier();
                if let Some(bid) = bid {
                    if bid.to_string() == app_identifier {
                        // NSRunningApplication.processIdentifier returns pid_t (i32).
                        let pid: i32 = msg_send![app, processIdentifier];
                        return Some(pid);
                    }
                }
            }
            None
        }

        /// Reverse of `find_pid_for_app`: given a pid, return the
        /// (appIdentifier, displayName) of that running app, or None if no
        /// running app has that pid (terminated between the window
        /// enumeration and this lookup, sandbox helper without bundle id,
        /// etc.).
        ///
        /// Iterates `NSWorkspace.runningApplications` to mirror the existing
        /// `find_pid_for_app` pattern (no new objc2 surface area). N is
        /// typically <100 and the call is on the click-safety hot path —
        /// fast enough.
        pub unsafe fn find_app_for_pid(pid: i32) -> Option<(String, String)> {
            let workspace = NSWorkspace::sharedWorkspace();
            let running = workspace.runningApplications();
            let count = running.count();
            for i in 0..count {
                let app: &NSRunningApplication = &running[i];
                let app_pid: i32 = msg_send![app, processIdentifier];
                if app_pid != pid {
                    continue;
                }
                let bid: Option<Retained<NSString>> = app.bundleIdentifier();
                let Some(bid) = bid else {
                    return None;
                };
                let bid_str = bid.to_string();
                // localizedName: NSString? — fall back to bundle id text on nil.
                let name: Option<Retained<NSString>> = app.localizedName();
                let name_str = name
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| bid_str.clone());
                return Some((bid_str, name_str));
            }
            None
        }

        /// Best-effort frontmost app pid. Used as the AX traversal root for
        /// first-pass structured element enumeration.
        pub unsafe fn frontmost_app_pid() -> Option<i32> {
            let workspace = NSWorkspace::sharedWorkspace();
            let app: *mut AnyObject = msg_send![&workspace, frontmostApplication];
            if app.is_null() {
                return None;
            }
            let pid: i32 = msg_send![app, processIdentifier];
            if pid == 0 { None } else { Some(pid) }
        }
    }

    pub mod escape_tap {
        //! Global Escape hotkey via CGEventTap.
        //!
        //! ## Lifecycle
        //!
        //! First `register` call creates a session-level event tap filtered to
        //! keyDown events on the calling thread (the Accessibility prompt
        //! comes from main thread on first call), then spawns a dedicated
        //! `cu-esc-tap` thread that attaches the tap's CFRunLoopSource to
        //! its OWN runloop (`CFRunLoopGetCurrent`) and runs `CFRunLoopRun`.
        //! That spawned thread is the only thread that pumps the tap — node
        //! CLI doesn't drive CFRunLoop main, so attaching to main would
        //! silently drop every keypress.
        //!
        //! Subsequent `register` calls just replace the JS callback and
        //! re-enable the tap if it was disabled. `unregister` disables the
        //! tap (CGEventTapEnable false) and clears the callback ref —
        //! the spawned thread keeps running its CFRunLoop and is reaped
        //! at process exit. Re-register flips the tap back on.
        //!
        //! Decay gate: the tap callback consumes Esc by default and invokes
        //! the JS callback. When `notify_expected_escape` was called within
        //! the last 100ms, the tap silently passes Esc through (the agent
        //! is synthesizing an Escape via `key("escape")` and shouldn't
        //! abort itself).

        use core_foundation::base::CFRelease;
        use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
        use std::sync::atomic::{AtomicI64, AtomicPtr, Ordering};
        use std::sync::Mutex;
        use std::time::{SystemTime, UNIX_EPOCH};

        const KVK_ESCAPE: i64 = 53;
        const EXPECTED_ESCAPE_DECAY_NS: i64 = 100_000_000; // 100ms

        // Pointer types the C API surfaces; we treat them opaquely.
        #[repr(C)]
        struct __CGEvent(std::ffi::c_void);
        type CGEventRef = *mut __CGEvent;

        type CFMachPortRef = *mut std::ffi::c_void;
        type CFRunLoopRef = *mut std::ffi::c_void;
        type CFAllocatorRef = *const std::ffi::c_void;
        type CGEventTapProxy = *mut std::ffi::c_void;

        const KCG_SESSION_EVENT_TAP: u32 = 0;
        const KCG_HEAD_INSERT_EVENT_TAP: u32 = 0;
        const KCG_EVENT_TAP_OPTION_DEFAULT: u32 = 0;
        const KCG_EVENT_KEY_DOWN: u32 = 10;

        // Mask for kCGEventKeyDown events.
        const fn cg_event_mask_bit(event_type: u32) -> u64 {
            1u64 << event_type
        }

        type CGEventTapCallBack = unsafe extern "C" fn(
            proxy: CGEventTapProxy,
            event_type: u32,
            event: CGEventRef,
            user_info: *mut std::ffi::c_void,
        ) -> CGEventRef;

        type CFRunLoopSourceRef = *mut std::ffi::c_void;
        type CFStringRef = *const std::ffi::c_void;

        extern "C" {
            fn CGEventTapCreate(
                tap: u32,
                place: u32,
                options: u32,
                events_of_interest: u64,
                callback: CGEventTapCallBack,
                user_info: *mut std::ffi::c_void,
            ) -> CFMachPortRef;
            fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
            fn CFMachPortCreateRunLoopSource(
                allocator: CFAllocatorRef,
                port: CFMachPortRef,
                order: i64,
            ) -> CFRunLoopSourceRef;
            fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
            fn CFRunLoopGetCurrent() -> CFRunLoopRef;
            fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
            fn CFRunLoopRun();
            // kCFRunLoopCommonModes is a CFStringRef constant exported by
            // CoreFoundation. Declared here so we can pass it to AddSource
            // without pulling the core-foundation crate's runloop binding.
            static kCFRunLoopCommonModes: CFStringRef;
        }

        // kCGKeyboardEventKeycode = 9
        const KEYCODE_FIELD: u32 = 9;

        static EXPECTED_UNTIL_NS: AtomicI64 = AtomicI64::new(0);
        // TAP_PORT is the only main-thread-visible pointer. The CFRunLoopSource
        // is owned by the spawned runloop thread; we don't track it here.
        static TAP_PORT: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());

        static CB: Mutex<Option<ThreadsafeFunction<()>>> = Mutex::new(None);

        unsafe extern "C" fn tap_callback(
            _proxy: CGEventTapProxy,
            event_type: u32,
            event: CGEventRef,
            _user_info: *mut std::ffi::c_void,
        ) -> CGEventRef {
            if event_type != KCG_EVENT_KEY_DOWN {
                return event;
            }
            let keycode = CGEventGetIntegerValueField(event, KEYCODE_FIELD);
            if keycode != KVK_ESCAPE {
                return event;
            }
            // Decay gate: synthesized escape is silently passed through.
            let now_ns = now_ns();
            let expected_until = EXPECTED_UNTIL_NS.load(Ordering::Relaxed);
            if now_ns < expected_until {
                return event;
            }
            // Real user escape — invoke JS callback (non-blocking) and consume.
            if let Ok(cb_guard) = CB.lock() {
                if let Some(ref tsfn) = *cb_guard {
                    tsfn.call(Ok(()), ThreadsafeFunctionCallMode::NonBlocking);
                }
            }
            std::ptr::null_mut() // consume the event (don't deliver to system)
        }

        fn now_ns() -> i64 {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos() as i64)
                .unwrap_or(0)
        }

        pub fn register(callback: ThreadsafeFunction<()>) -> bool {
            // Update the JS callback ref. The tap_callback C function reads
            // through this Mutex on every Esc keydown.
            if let Ok(mut guard) = CB.lock() {
                *guard = Some(callback);
            } else {
                return false;
            }

            // Re-registration: tap thread already running, just re-enable
            // the tap (it may have been disabled by an earlier `unregister`).
            let existing_port = TAP_PORT.load(Ordering::Relaxed);
            if !existing_port.is_null() {
                unsafe { CGEventTapEnable(existing_port as CFMachPortRef, true) };
                return true;
            }

            // First registration: create the tap synchronously on the
            // calling thread (Accessibility prompt must come from main
            // thread the first time), then move ownership to a dedicated
            // runloop thread. Pointers are passed as `usize` because raw
            // pointers aren't `Send`; the spawned thread re-casts to the
            // CF types. Both refs are CF-retained; the thread owns them
            // for the runloop's lifetime.
            let (port_addr, source_addr) = unsafe {
                let mask = cg_event_mask_bit(KCG_EVENT_KEY_DOWN);
                let port = CGEventTapCreate(
                    KCG_SESSION_EVENT_TAP,
                    KCG_HEAD_INSERT_EVENT_TAP,
                    KCG_EVENT_TAP_OPTION_DEFAULT,
                    mask,
                    tap_callback,
                    std::ptr::null_mut(),
                );
                if port.is_null() {
                    // CGEventTapCreate returns null when Accessibility perms
                    // aren't granted. Caller's fallback is the OS notification
                    // telling the user to use Ctrl+C instead.
                    return false;
                }
                let source = CFMachPortCreateRunLoopSource(std::ptr::null(), port, 0);
                if source.is_null() {
                    CFRelease(port as _);
                    return false;
                }
                (port as usize, source as usize)
            };

            // Stash the port pointer so re-register / unregister can find it.
            // The source ref lives only on the spawned thread (added to its
            // own runloop) — we don't track it from the main thread.
            TAP_PORT.store(port_addr as *mut std::ffi::c_void, Ordering::Relaxed);

            // Spawn the runloop thread. Adds the source to its OWN runloop
            // (CFRunLoopGetCurrent), enables the tap, then blocks in
            // CFRunLoopRun forever. Process exit reaps the thread.
            // kCFRunLoopCommonModes is `*const c_void` (extern static) and
            // captured by reference, but extern statics are at fixed
            // addresses — we read its pointer value before the move and
            // pass it as usize too.
            let mode_addr = unsafe { kCFRunLoopCommonModes as usize };
            std::thread::Builder::new()
                .name("cu-esc-tap".to_string())
                .spawn(move || {
                    let port = port_addr as CFMachPortRef;
                    let source = source_addr as CFRunLoopSourceRef;
                    let mode = mode_addr as CFStringRef;
                    unsafe {
                        let runloop = CFRunLoopGetCurrent();
                        CFRunLoopAddSource(runloop, source, mode);
                        CGEventTapEnable(port, true);
                        CFRunLoopRun();
                        // CFRunLoopRun returns only if the runloop is
                        // explicitly stopped. We never call CFRunLoopStop;
                        // process exit reaps this thread. Defensive cleanup
                        // in case the API changes:
                        CFRelease(source as _);
                        CFRelease(port as _);
                    }
                })
                .expect("spawn cu-esc-tap thread");

            true
        }

        pub fn unregister() {
            // Disable the tap (events stop being captured) and clear the
            // callback. Don't tear down the tap port or the spawned thread —
            // re-register flips the tap back on. Process exit reaps the
            // thread.
            let port = TAP_PORT.load(Ordering::Relaxed);
            if !port.is_null() {
                unsafe { CGEventTapEnable(port as CFMachPortRef, false) };
            }
            if let Ok(mut guard) = CB.lock() {
                *guard = None;
            }
        }

        pub fn notify_expected_escape() {
            let until = now_ns() + EXPECTED_ESCAPE_DECAY_NS;
            EXPECTED_UNTIL_NS.store(until, Ordering::Relaxed);
        }
    }

    pub mod cg_window_query {
        //! Window enumeration helpers: window→display mapping and point
        //! hit-testing. Both walk `CGWindowListCopyWindowInfo` for visible
        //! windows; the difference is what they extract — display IDs
        //! intersecting the window rect (`find_window_displays`) vs the
        //! topmost window covering a point (`app_under_point`).
        //!
        //! Same TCC gate as cg_window_capture (Screen Recording). All calls
        //! are synchronous (no @MainActor); safe to invoke from napi-rs's
        //! tokio worker threads without dispatch hand-offs.
        //!
        //! Coordinate system note: `kCGWindowBounds` and `CGDisplayBounds`
        //! both use top-left-origin logical points on macOS 10.15+. The
        //! (x, y) hit-test arg from JS is also logical pt (matches the
        //! agent's executor coord space), so no scaling/flipping is needed.

        use super::running_app;
        use crate::{AppHitInfo, WindowDisplayInfo};
        use std::collections::{BTreeMap, BTreeSet};
        use std::os::raw::{c_double, c_void};

        type CFArrayRef = *const c_void;
        type CFDictionaryRef = *const c_void;
        type CFStringRef = *const c_void;
        type CFNumberRef = *const c_void;
        type CGDirectDisplayID = u32;

        const KCG_WINDOW_LIST_ON_SCREEN_ONLY: u32 = 1 << 0;
        const KCG_WINDOW_LIST_EXCLUDE_DESKTOP: u32 = 1 << 4;
        const KCG_NULL_WINDOW_ID: u32 = 0;

        // CFNumber type identifiers
        const KCF_NUMBER_SINT32_TYPE: i32 = 3;
        // Max active displays we'll enumerate. macOS supports many more in
        // theory, but 16 is a reasonable practical cap (no realistic user
        // setup exceeds this).
        const MAX_DISPLAYS: u32 = 16;

        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        pub(super) struct CGPoint {
            pub(super) x: c_double,
            pub(super) y: c_double,
        }
        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        pub(super) struct CGSize {
            pub(super) width: c_double,
            pub(super) height: c_double,
        }
        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        pub(super) struct CGRect {
            pub(super) origin: CGPoint,
            pub(super) size: CGSize,
        }

        impl CGRect {
            fn intersects(&self, other: &CGRect) -> bool {
                let a_x1 = self.origin.x;
                let a_y1 = self.origin.y;
                let a_x2 = self.origin.x + self.size.width;
                let a_y2 = self.origin.y + self.size.height;
                let b_x1 = other.origin.x;
                let b_y1 = other.origin.y;
                let b_x2 = other.origin.x + other.size.width;
                let b_y2 = other.origin.y + other.size.height;
                a_x1 < b_x2 && a_x2 > b_x1 && a_y1 < b_y2 && a_y2 > b_y1
            }

            fn contains(&self, x: f64, y: f64) -> bool {
                x >= self.origin.x
                    && x < self.origin.x + self.size.width
                    && y >= self.origin.y
                    && y < self.origin.y + self.size.height
            }

            pub(super) fn intersection(&self, other: &CGRect) -> Option<CGRect> {
                let x1 = self.origin.x.max(other.origin.x);
                let y1 = self.origin.y.max(other.origin.y);
                let x2 = (self.origin.x + self.size.width).min(other.origin.x + other.size.width);
                let y2 = (self.origin.y + self.size.height).min(other.origin.y + other.size.height);
                let w = x2 - x1;
                let h = y2 - y1;
                if w <= 0.0 || h <= 0.0 {
                    return None;
                }
                Some(CGRect {
                    origin: CGPoint { x: x1, y: y1 },
                    size: CGSize { width: w, height: h },
                })
            }
        }

        extern "C" {
            fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
            fn CFArrayGetCount(arr: CFArrayRef) -> isize;
            fn CFArrayGetValueAtIndex(arr: CFArrayRef, idx: isize) -> *const c_void;
            fn CFRelease(cf: *const c_void);
            fn CFDictionaryGetValue(d: CFDictionaryRef, key: *const c_void) -> *const c_void;
            fn CFNumberGetValue(num: CFNumberRef, ty: i32, value: *mut c_void) -> bool;
            fn CFDictionaryContainsKey(d: CFDictionaryRef, key: *const c_void) -> bool;

            // CGDirectDisplayID enumeration
            fn CGGetActiveDisplayList(
                max_displays: u32,
                active_displays: *mut CGDirectDisplayID,
                display_count: *mut u32,
            ) -> i32;
            fn CGDisplayBounds(display_id: CGDirectDisplayID) -> CGRect;

            // Window dict keys (CFStringRef constants exported by CG framework).
            static kCGWindowOwnerPID: CFStringRef;
            static kCGWindowLayer: CFStringRef;
            static kCGWindowBounds: CFStringRef;

            // CGRect bounds dict keys (kCGWindowBounds is a CFDictionary
            // with these CFNumber keys, not a CGRect struct directly).
            // CGRectMakeWithDictionaryRepresentation roundtrips it for us.
            fn CGRectMakeWithDictionaryRepresentation(
                dict: CFDictionaryRef,
                rect: *mut CGRect,
            ) -> bool;
        }

        /// Read kCGWindowBounds (CFDictionary) → CGRect via the official
        /// CG roundtrip helper. Returns None when the dict is missing the
        /// key or the conversion fails (rare).
        pub(super) unsafe fn decode_window_bounds(dict: CFDictionaryRef) -> Option<CGRect> {
            let bounds_dict =
                CFDictionaryGetValue(dict, kCGWindowBounds as *const c_void) as CFDictionaryRef;
            if bounds_dict.is_null() {
                return None;
            }
            let mut rect: CGRect = CGRect::default();
            if !CGRectMakeWithDictionaryRepresentation(bounds_dict, &mut rect as *mut _) {
                return None;
            }
            Some(rect)
        }

        unsafe fn read_i32(dict: CFDictionaryRef, key: CFStringRef) -> Option<i32> {
            let num = CFDictionaryGetValue(dict, key as *const c_void) as CFNumberRef;
            if num.is_null() {
                return None;
            }
            let mut v: i32 = 0;
            if CFNumberGetValue(num, KCF_NUMBER_SINT32_TYPE, &mut v as *mut _ as *mut c_void) {
                Some(v)
            } else {
                None
            }
        }

        /// Active display list + their bounds. Returns empty Vec on failure
        /// (which mostly means CG itself is in a bad state; callers degrade
        /// gracefully — find_window_displays returns empty display lists).
        pub(super) unsafe fn list_active_displays() -> Vec<(CGDirectDisplayID, CGRect)> {
            let mut ids = vec![0u32; MAX_DISPLAYS as usize];
            let mut count: u32 = 0;
            let result = CGGetActiveDisplayList(MAX_DISPLAYS, ids.as_mut_ptr(), &mut count);
            if result != 0 || count == 0 {
                return Vec::new();
            }
            ids.truncate(count as usize);
            ids.into_iter()
                .map(|id| (id, CGDisplayBounds(id)))
                .collect()
        }

        pub(super) unsafe fn active_display_union() -> Option<CGRect> {
            let displays = list_active_displays();
            let mut iter = displays.into_iter();
            let (_, first) = iter.next()?;
            let mut min_x = first.origin.x;
            let mut min_y = first.origin.y;
            let mut max_x = first.origin.x + first.size.width;
            let mut max_y = first.origin.y + first.size.height;
            for (_, rect) in iter {
                min_x = min_x.min(rect.origin.x);
                min_y = min_y.min(rect.origin.y);
                max_x = max_x.max(rect.origin.x + rect.size.width);
                max_y = max_y.max(rect.origin.y + rect.size.height);
            }
            Some(CGRect {
                origin: CGPoint { x: min_x, y: min_y },
                size: CGSize {
                    width: (max_x - min_x).max(0.0),
                    height: (max_y - min_y).max(0.0),
                },
            })
        }

        pub fn find_window_displays(app_identifiers: &[String]) -> Vec<WindowDisplayInfo> {
            // Resolve each requested bundle id to its pid up front. Apps not
            // running map to an empty display_ids list (truthful: nothing to
            // see). Pre-build pid→app_identifier index so the window walk is O(N).
            let mut pid_to_app_identifier: BTreeMap<i32, String> = BTreeMap::new();
            for bid in app_identifiers {
                if let Some(pid) = unsafe { running_app::find_pid_for_app(bid) } {
                    pid_to_app_identifier.insert(pid, bid.clone());
                }
            }

            // Result map: app_identifier → set of display ids (BTreeSet for stable
            // iteration order in tests / debug logs).
            let mut result: BTreeMap<String, BTreeSet<u32>> = BTreeMap::new();
            for bid in app_identifiers {
                result.insert(bid.clone(), BTreeSet::new());
            }

            if pid_to_app_identifier.is_empty() {
                return app_identifiers
                    .iter()
                    .map(|bid| WindowDisplayInfo {
                        app_identifier: bid.clone(),
                        display_ids: Vec::new(),
                    })
                    .collect();
            }

            let displays = unsafe { list_active_displays() };
            if displays.is_empty() {
                // Can't determine which display each window is on; return
                // empty lists rather than guess.
                return app_identifiers
                    .iter()
                    .map(|bid| WindowDisplayInfo {
                        app_identifier: bid.clone(),
                        display_ids: Vec::new(),
                    })
                    .collect();
            }

            unsafe {
                let arr = CGWindowListCopyWindowInfo(
                    KCG_WINDOW_LIST_ON_SCREEN_ONLY | KCG_WINDOW_LIST_EXCLUDE_DESKTOP,
                    KCG_NULL_WINDOW_ID,
                );
                if arr.is_null() {
                    // TCC denied or CG broken; same fallback as no-displays.
                    return app_identifiers
                        .iter()
                        .map(|bid| WindowDisplayInfo {
                            app_identifier: bid.clone(),
                            display_ids: Vec::new(),
                        })
                        .collect();
                }
                let count = CFArrayGetCount(arr);
                for i in 0..count {
                    let dict = CFArrayGetValueAtIndex(arr, i) as CFDictionaryRef;
                    if dict.is_null() {
                        continue;
                    }
                    let Some(pid) = read_i32(dict, kCGWindowOwnerPID) else {
                        continue;
                    };
                    let Some(app_identifier) = pid_to_app_identifier.get(&pid) else {
                        continue;
                    };
                    let Some(rect) = decode_window_bounds(dict) else {
                        continue;
                    };
                    let display_set = result
                        .entry(app_identifier.clone())
                        .or_insert_with(BTreeSet::new);
                    for (display_id, display_rect) in &displays {
                        if rect.intersects(display_rect) {
                            display_set.insert(*display_id);
                        }
                    }
                }
                CFRelease(arr);
            }

            // Preserve caller's app_identifier order in the output (helpful for
            // logs / tests).
            app_identifiers
                .iter()
                .map(|bid| WindowDisplayInfo {
                    app_identifier: bid.clone(),
                    display_ids: result
                        .get(bid)
                        .map(|s| s.iter().copied().collect())
                        .unwrap_or_default(),
                })
                .collect()
        }

        pub fn app_under_point(x: i32, y: i32) -> Option<AppHitInfo> {
            let px = x as f64;
            let py = y as f64;

            unsafe {
                // Don't exclude desktop elements — overlays often live with
                // the dock/menu-bar layer flags. We do the layer-based
                // top-down sort ourselves below.
                let arr = CGWindowListCopyWindowInfo(
                    KCG_WINDOW_LIST_ON_SCREEN_ONLY,
                    KCG_NULL_WINDOW_ID,
                );
                if arr.is_null() {
                    return None;
                }

                // Collect all candidates that contain (px, py), tagged with
                // their layer (lower number = nominally below in z-order,
                // but layer alone isn't strict z-order — within a layer,
                // CGWindowList returns front-to-back, so iteration index
                // breaks ties).
                struct Candidate {
                    layer: i32,
                    index: isize,
                    pid: i32,
                }
                let mut candidates: Vec<Candidate> = Vec::new();

                let count = CFArrayGetCount(arr);
                for i in 0..count {
                    let dict = CFArrayGetValueAtIndex(arr, i) as CFDictionaryRef;
                    if dict.is_null() {
                        continue;
                    }
                    if !CFDictionaryContainsKey(dict, kCGWindowOwnerPID as *const c_void) {
                        continue;
                    }
                    let Some(pid) = read_i32(dict, kCGWindowOwnerPID) else {
                        continue;
                    };
                    let layer = read_i32(dict, kCGWindowLayer).unwrap_or(0);
                    let Some(rect) = decode_window_bounds(dict) else {
                        continue;
                    };
                    if rect.contains(px, py) {
                        candidates.push(Candidate {
                            layer,
                            index: i,
                            pid,
                        });
                    }
                }
                CFRelease(arr);

                if candidates.is_empty() {
                    return None;
                }

                // Topmost = highest layer; tie-break by lowest index
                // (CGWindowList returns front-of-layer first within a layer).
                candidates.sort_by(|a, b| {
                    b.layer
                        .cmp(&a.layer)
                        .then_with(|| a.index.cmp(&b.index))
                });

                // Resolve pid → (app_identifier, display_name). Skip candidates
                // whose owning app vanished between enumeration and lookup.
                for cand in candidates {
                    if let Some((app_identifier, display_name)) =
                        running_app::find_app_for_pid(cand.pid)
                    {
                        return Some(AppHitInfo {
                            app_identifier,
                            display_name,
                        });
                    }
                }
                None
            }
        }
    }

    pub mod ax_query {
        use crate::{UiElement, VPoint, VRect, VSize};
        use core_foundation::base::TCFType;
        use core_foundation::string::CFString;
        use std::collections::BTreeSet;
        use std::ffi::CString;
        use std::os::raw::{c_char, c_void};
        use std::ptr;

        type AXUIElementRef = *const c_void;
        type AXValueRef = *const c_void;
        type CFArrayRef = *const c_void;
        type CFStringRef = *const c_void;
        type CFTypeRef = *const c_void;
        type CFIndex = isize;
        type AXError = i32;
        const K_AX_VALUE_CGPOINT_TYPE: u32 = 1;
        const K_AX_VALUE_CGSIZE_TYPE: u32 = 2;
        const K_CF_STRING_ENCODING_UTF8: u32 = 0x08000100;
        const K_AX_ERROR_SUCCESS: AXError = 0;
        const MAX_AX_TREE_DEPTH: usize = 48;

        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        struct CGPoint {
            x: f64,
            y: f64,
        }

        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        struct CGSize {
            width: f64,
            height: f64,
        }

        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        struct CGRectNative {
            origin: CGPoint,
            size: CGSize,
        }

        extern "C" {
            fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
            fn AXUIElementCopyAttributeValue(
                element: AXUIElementRef,
                attribute: CFStringRef,
                value: *mut CFTypeRef,
            ) -> AXError;
            fn AXUIElementCopyElementAtPosition(
                application: AXUIElementRef,
                x: f32,
                y: f32,
                element: *mut AXUIElementRef,
            ) -> AXError;
            fn AXValueGetValue(value: AXValueRef, the_type: u32, out: *mut c_void) -> bool;
            fn CFArrayGetCount(arr: CFArrayRef) -> CFIndex;
            fn CFArrayGetValueAtIndex(arr: CFArrayRef, idx: CFIndex) -> *const c_void;
            fn CFGetTypeID(cf: *const c_void) -> usize;
            fn CFStringGetTypeID() -> usize;
            fn CFArrayGetTypeID() -> usize;
            fn CFRelease(cf: *const c_void);
            fn CFRetain(cf: *const c_void) -> *const c_void;
            fn CFStringGetCString(
                the_string: CFStringRef,
                buffer: *mut c_char,
                buffer_size: CFIndex,
                encoding: u32,
            ) -> bool;
        }

        fn ax_attr(name: &str) -> CFString {
            CFString::new(name)
        }

        fn app_ax_root_for_pid(pid: i32) -> Option<AXUIElementRef> {
            let root = unsafe { AXUIElementCreateApplication(pid) };
            if root.is_null() { None } else { Some(root) }
        }

        fn frontmost_app_ax_root() -> Option<AXUIElementRef> {
            let pid = unsafe { crate::macos::running_app::frontmost_app_pid()? };
            let root = unsafe { AXUIElementCreateApplication(pid) };
            if root.is_null() { None } else { Some(root) }
        }

        fn app_ax_root_for_identifier(app_identifier: &str) -> Option<AXUIElementRef> {
            let pid = unsafe { crate::macos::running_app::find_pid_for_app(app_identifier)? };
            let root = unsafe { AXUIElementCreateApplication(pid) };
            if root.is_null() { None } else { Some(root) }
        }

        fn app_pid_for_rect_center(rect: &VRect) -> Option<i32> {
            let x = rect.origin.x + rect.size.w as i32 / 2;
            let y = rect.origin.y + rect.size.h as i32 / 2;
            let hit = crate::macos::cg_window_query::app_under_point(x, y)?;
            unsafe { crate::macos::running_app::find_pid_for_app(&hit.app_identifier) }
        }

        unsafe fn cfstring_to_string(s: CFStringRef) -> Option<String> {
            if s.is_null() {
                return None;
            }
            let mut buf = vec![0i8; 1024];
            if CFStringGetCString(
                s,
                buf.as_mut_ptr(),
                buf.len() as isize,
                K_CF_STRING_ENCODING_UTF8,
            ) {
                let cstr = CString::from_vec_with_nul(
                    buf.into_iter()
                        .take_while(|c| *c != 0)
                        .map(|c| c as u8)
                        .chain(std::iter::once(0))
                        .collect(),
                )
                .ok()?;
                return Some(cstr.to_string_lossy().into_owned());
            }
            None
        }

        unsafe fn copy_attr(element: AXUIElementRef, attr: CFStringRef) -> Option<CFTypeRef> {
            let mut value: CFTypeRef = ptr::null();
            let err = AXUIElementCopyAttributeValue(element, attr, &mut value as *mut _);
            if err == K_AX_ERROR_SUCCESS && !value.is_null() {
                Some(value)
            } else {
                None
            }
        }

        unsafe fn read_string_attr(element: AXUIElementRef, attr: CFStringRef) -> Option<String> {
            let value = copy_attr(element, attr)?;
            let out = if CFGetTypeID(value) == CFStringGetTypeID() {
                cfstring_to_string(value as CFStringRef)
            } else {
                None
            };
            CFRelease(value);
            out
        }

        unsafe fn debug_element_summary(element: AXUIElementRef) -> String {
            let role_attr = ax_attr("AXRole");
            let title_attr = ax_attr("AXTitle");
            let desc_attr = ax_attr("AXDescription");
            let value_attr = ax_attr("AXValue");
            let role = read_string_attr(element, role_attr.as_concrete_TypeRef() as CFStringRef)
                .unwrap_or_else(|| "?".to_string());
            let name = trim_text(
                read_string_attr(element, title_attr.as_concrete_TypeRef() as CFStringRef)
                    .or_else(|| read_string_attr(element, desc_attr.as_concrete_TypeRef() as CFStringRef))
                    .or_else(|| read_string_attr(element, value_attr.as_concrete_TypeRef() as CFStringRef))
                    .unwrap_or_default(),
            );
            match read_rect(element).map(|r| rect_to_public(&r)) {
                Some(b) => format!(
                    "role={} name={:?} bbox=({},{} {}x{})",
                    role, name, b.origin.x, b.origin.y, b.size.w, b.size.h
                ),
                None => format!("role={} name={:?} bbox=<none>", role, name),
            }
        }

        unsafe fn read_children_for_attr(
            element: AXUIElementRef,
            attr_name: &str,
        ) -> Vec<AXUIElementRef> {
            let attr = ax_attr(attr_name);
            let value = match copy_attr(element, attr.as_concrete_TypeRef() as CFStringRef) {
                Some(v) => v,
                None => return Vec::new(),
            };
            if CFGetTypeID(value) != CFArrayGetTypeID() {
                CFRelease(value);
                return Vec::new();
            }
            let arr = value as CFArrayRef;
            let count = CFArrayGetCount(arr);
            let mut out = Vec::new();
            for i in 0..count {
                let child = CFArrayGetValueAtIndex(arr, i) as AXUIElementRef;
                if !child.is_null() {
                    let retained = CFRetain(child as *const c_void) as AXUIElementRef;
                    out.push(retained);
                }
            }
            CFRelease(value);
            out
        }

        unsafe fn read_children(element: AXUIElementRef) -> Vec<AXUIElementRef> {
            let attrs = [
                "AXChildren",
                "AXVisibleChildren",
                "AXRows",
                "AXContents",
                "AXSelectedChildren",
            ];
            let mut out = Vec::new();
            let mut seen = BTreeSet::<usize>::new();
            for attr_name in attrs {
                let children = read_children_for_attr(element, attr_name);
                if !children.is_empty() {
                    super::append_ax_som_debug_log(&format!(
                        "CHILDREN attr={} count={} from {}",
                        attr_name,
                        children.len(),
                        debug_element_summary(element)
                    ));
                }
                for child in children {
                    let key = child as usize;
                    if seen.insert(key) {
                        out.push(child);
                    } else {
                        CFRelease(child as *const c_void);
                    }
                }
            }
            out
        }

        unsafe fn read_rect(element: AXUIElementRef) -> Option<CGRectNative> {
            let pos_attr = ax_attr("AXPosition");
            let size_attr = ax_attr("AXSize");
            let pos_value = copy_attr(element, pos_attr.as_concrete_TypeRef() as CFStringRef)?;
            let size_value = copy_attr(element, size_attr.as_concrete_TypeRef() as CFStringRef)?;
            let mut pos = CGPoint::default();
            let mut size = CGSize::default();
            let pos_ok = AXValueGetValue(pos_value as AXValueRef, K_AX_VALUE_CGPOINT_TYPE, &mut pos as *mut _ as *mut c_void);
            let size_ok = AXValueGetValue(size_value as AXValueRef, K_AX_VALUE_CGSIZE_TYPE, &mut size as *mut _ as *mut c_void);
            CFRelease(pos_value);
            CFRelease(size_value);
            if !pos_ok || !size_ok {
                return None;
            }
            Some(CGRectNative { origin: pos, size })
        }

        fn ax_role_to_short(role: &str) -> &str {
            match role {
                "AXButton" => "Button",
                "AXPopUpButton" => "Button",
                "AXDisclosureTriangle" => "Button",
                "AXTextField" => "Edit",
                "AXTextArea" => "Edit",
                "AXCheckBox" => "CheckBox",
                "AXRadioButton" => "RadioButton",
                "AXLink" => "Hyperlink",
                "AXMenuItem" => "MenuItem",
                "AXTabButton" => "TabItem",
                "AXStaticText" => "Text",
                "AXImage" => "Image",
                "AXList" => "List",
                "AXRow" => "ListItem",
                "AXScrollBar" => "ScrollBar",
                "AXSlider" => "Slider",
                _ => "Unknown",
            }
        }

        fn role_is_container_only(role: &str) -> bool {
            matches!(
                role,
                "AXGroup"
                    | "AXWindow"
                    | "AXApplication"
                    | "AXScrollArea"
                    | "AXOutline"
                    | "AXBrowser"
                    | "AXSplitGroup"
                    | "AXToolbar"
                    | "AXUnknown"
            )
        }

        fn role_is_actionable_or_semantic(role: &str) -> bool {
            matches!(
                role,
                "AXButton"
                    | "AXPopUpButton"
                    | "AXDisclosureTriangle"
                    | "AXTextField"
                    | "AXTextArea"
                    | "AXCheckBox"
                    | "AXRadioButton"
                    | "AXLink"
                    | "AXMenuItem"
                    | "AXTabButton"
                    | "AXRow"
            )
        }

        fn rect_to_public(rect: &CGRectNative) -> VRect {
            VRect {
                origin: VPoint {
                    x: rect.origin.x.round() as i32,
                    y: rect.origin.y.round() as i32,
                },
                size: VSize {
                    w: rect.size.width.max(0.0).round() as u32,
                    h: rect.size.height.max(0.0).round() as u32,
                },
            }
        }

        fn intersects_filter(rect: &VRect, filter: &VRect) -> bool {
            let ax1 = rect.origin.x;
            let ay1 = rect.origin.y;
            let ax2 = rect.origin.x + rect.size.w as i32;
            let ay2 = rect.origin.y + rect.size.h as i32;
            let bx1 = filter.origin.x;
            let by1 = filter.origin.y;
            let bx2 = filter.origin.x + filter.size.w as i32;
            let by2 = filter.origin.y + filter.size.h as i32;
            ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1
        }

        fn intersection_area(rect: &VRect, filter: &VRect) -> u64 {
            let ax1 = rect.origin.x;
            let ay1 = rect.origin.y;
            let ax2 = rect.origin.x + rect.size.w as i32;
            let ay2 = rect.origin.y + rect.size.h as i32;
            let bx1 = filter.origin.x;
            let by1 = filter.origin.y;
            let bx2 = filter.origin.x + filter.size.w as i32;
            let by2 = filter.origin.y + filter.size.h as i32;
            let w = (ax2.min(bx2) - ax1.max(bx1)).max(0) as u64;
            let h = (ay2.min(by2) - ay1.max(by1)).max(0) as u64;
            w * h
        }

        fn bbox_area(rect: &VRect) -> u64 {
            rect.size.w as u64 * rect.size.h as u64
        }

        fn rect_center(rect: &VRect) -> (i32, i32) {
            (
                rect.origin.x + rect.size.w as i32 / 2,
                rect.origin.y + rect.size.h as i32 / 2,
            )
        }

        fn center_in_filter(rect: &VRect, filter: &VRect) -> bool {
            let (cx, cy) = rect_center(rect);
            cx >= filter.origin.x
                && cy >= filter.origin.y
                && cx < filter.origin.x + filter.size.w as i32
                && cy < filter.origin.y + filter.size.h as i32
        }

        fn trim_text(s: String) -> String {
            s.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
        }

        fn is_name_useful(name: &str, role_raw: &str) -> bool {
            if name.is_empty() {
                return matches!(role_raw, "AXTextField" | "AXTextArea");
            }
            let lower = name.to_ascii_lowercase();
            !(lower == "image"
                || lower == "group"
                || lower == "toolbar"
                || lower == "window"
                || lower == "application")
        }

        unsafe fn element_to_ui(
            element: AXUIElementRef,
            filter: &VRect,
        ) -> Result<UiElement, String> {
            let role_attr = ax_attr("AXRole");
            let title_attr = ax_attr("AXTitle");
            let desc_attr = ax_attr("AXDescription");
            let value_attr = ax_attr("AXValue");
            let role_raw =
                read_string_attr(element, role_attr.as_concrete_TypeRef() as CFStringRef)
                    .ok_or_else(|| "missing AXRole".to_string())?;
            if role_is_container_only(&role_raw) || !role_is_actionable_or_semantic(&role_raw) {
                return Err(format!("filtered role={role_raw}"));
            }
            let rect = read_rect(element).ok_or_else(|| "missing rect".to_string())?;
            let bbox = rect_to_public(&rect);
            if bbox.size.w == 0 || bbox.size.h == 0 || !intersects_filter(&bbox, filter) {
                return Err(format!(
                    "bbox invalid/intersects=false bbox=({},{} {}x{})",
                    bbox.origin.x, bbox.origin.y, bbox.size.w, bbox.size.h
                ));
            }
            let bbox_area = bbox_area(&bbox);
            if bbox_area == 0 {
                return Err("bbox area zero".to_string());
            }
            let intersect_area = intersection_area(&bbox, filter);
            if intersect_area * 2 < bbox_area || !center_in_filter(&bbox, filter) {
                return Err(format!(
                    "bbox containment fail intersect={} area={} center_in_filter={}",
                    intersect_area,
                    bbox_area,
                    center_in_filter(&bbox, filter)
                ));
            }
            if bbox.size.w > filter.size.w.saturating_mul(9) / 10
                && bbox.size.h > filter.size.h.saturating_mul(9) / 10
            {
                return Err("bbox too large for filter".to_string());
            }
            let name = trim_text(
                read_string_attr(element, title_attr.as_concrete_TypeRef() as CFStringRef)
                .or_else(|| read_string_attr(element, desc_attr.as_concrete_TypeRef() as CFStringRef))
                .or_else(|| read_string_attr(element, value_attr.as_concrete_TypeRef() as CFStringRef))
                .unwrap_or_default(),
            );
            if !is_name_useful(&name, &role_raw) {
                return Err(format!("name not useful role={role_raw} name={name:?}"));
            }
            Ok(UiElement {
                bbox,
                name,
                role: ax_role_to_short(&role_raw).to_string(),
                automation_id: None,
                uia_source: Some("foreground".to_string()),
            })
        }

        pub fn enumerate_ui_elements_in_rect(rect: VRect, window_only: bool) -> Vec<UiElement> {
            let root = match if window_only {
                app_pid_for_rect_center(&rect).and_then(app_ax_root_for_pid)
            } else {
                frontmost_app_ax_root()
            } {
                Some(r) => r,
                None => return Vec::new(),
            };
            super::append_ax_som_debug_log(&format!(
                "BEGIN rect=({},{} {}x{})",
                rect.origin.x, rect.origin.y, rect.size.w, rect.size.h
            ));
            unsafe {
                let focused_attr = ax_attr("AXFocusedWindow");
                let start = copy_attr(root, focused_attr.as_concrete_TypeRef() as CFStringRef)
                    .map(|v| v as AXUIElementRef)
                    .unwrap_or(root);
                let mut out = Vec::new();
                let mut seen: BTreeSet<(i32, i32, u32, u32, &'static str)> = BTreeSet::new();
                let mut stack: Vec<(AXUIElementRef, usize)> = vec![(start, 0)];
                while let Some((el, depth)) = stack.pop() {
                    if depth > MAX_AX_TREE_DEPTH {
                        super::append_ax_som_debug_log(&format!(
                            "DROP depth_exceeded depth={} {}",
                            depth,
                            debug_element_summary(el)
                        ));
                        continue;
                    }
                    match element_to_ui(el, &rect) {
                        Ok(ui) => {
                            let role_bucket = match ui.role.as_str() {
                            "Button" => "Button",
                            "Edit" => "Edit",
                            "CheckBox" => "CheckBox",
                            "RadioButton" => "RadioButton",
                            "Hyperlink" => "Hyperlink",
                            "MenuItem" => "MenuItem",
                            "TabItem" => "TabItem",
                            "ScrollBar" => "ScrollBar",
                            "Slider" => "Slider",
                            "ListItem" => "ListItem",
                            "Text" => "Text",
                            "Image" => "Image",
                            _ => "Other",
                        };
                            let key = (
                            ui.bbox.origin.x,
                            ui.bbox.origin.y,
                            ui.bbox.size.w,
                            ui.bbox.size.h,
                            role_bucket,
                        );
                            if seen.insert(key) {
                                super::append_ax_som_debug_log(&format!(
                                    "KEEP depth={} role={} name={:?} bbox=({},{} {}x{})",
                                    depth,
                                    ui.role,
                                    ui.name,
                                    ui.bbox.origin.x,
                                    ui.bbox.origin.y,
                                    ui.bbox.size.w,
                                    ui.bbox.size.h
                                ));
                                out.push(ui);
                            } else {
                                super::append_ax_som_debug_log(&format!(
                                    "DROP duplicate depth={} role={} name={:?} bbox=({},{} {}x{})",
                                    depth,
                                    ui.role,
                                    ui.name,
                                    ui.bbox.origin.x,
                                    ui.bbox.origin.y,
                                    ui.bbox.size.w,
                                    ui.bbox.size.h
                                ));
                            }
                        }
                        Err(reason) => {
                            super::append_ax_som_debug_log(&format!(
                                "DROP depth={} {} {}",
                                depth,
                                reason,
                                debug_element_summary(el)
                            ));
                        }
                    }
                    for child in read_children(el).into_iter().rev() {
                        stack.push((child, depth + 1));
                    }
                    CFRelease(el as *const c_void);
                }
                if start != root {
                    CFRelease(root as *const c_void);
                }
                super::append_ax_som_debug_log(&format!("END kept={}", out.len()));
                out
            }
        }

        pub fn enumerate_ui_elements_for_app_in_rect(
            app_identifier: &str,
            rect: VRect,
        ) -> Vec<UiElement> {
            let root = match app_ax_root_for_identifier(app_identifier) {
                Some(r) => r,
                None => return Vec::new(),
            };
            super::append_ax_som_debug_log(&format!(
                "BEGIN app={} rect=({},{} {}x{})",
                app_identifier, rect.origin.x, rect.origin.y, rect.size.w, rect.size.h
            ));
            unsafe {
                let focused_attr = ax_attr("AXFocusedWindow");
                let start = copy_attr(root, focused_attr.as_concrete_TypeRef() as CFStringRef)
                    .map(|v| v as AXUIElementRef)
                    .unwrap_or(root);
                let mut out = Vec::new();
                let mut seen: BTreeSet<(i32, i32, u32, u32, &'static str)> = BTreeSet::new();
                let mut stack: Vec<(AXUIElementRef, usize)> = vec![(start, 0)];
                while let Some((el, depth)) = stack.pop() {
                    if depth > MAX_AX_TREE_DEPTH {
                        super::append_ax_som_debug_log(&format!(
                            "DROP depth_exceeded depth={} {}",
                            depth,
                            debug_element_summary(el)
                        ));
                        continue;
                    }
                    match element_to_ui(el, &rect) {
                        Ok(ui) => {
                            let role_bucket = match ui.role.as_str() {
                                "Button" => "Button",
                                "Edit" => "Edit",
                                "CheckBox" => "CheckBox",
                                "RadioButton" => "RadioButton",
                                "Hyperlink" => "Hyperlink",
                                "MenuItem" => "MenuItem",
                                "TabItem" => "TabItem",
                                "ScrollBar" => "ScrollBar",
                                "Slider" => "Slider",
                                "ListItem" => "ListItem",
                                "Text" => "Text",
                                "Image" => "Image",
                                _ => "Other",
                            };
                            let key = (
                                ui.bbox.origin.x,
                                ui.bbox.origin.y,
                                ui.bbox.size.w,
                                ui.bbox.size.h,
                                role_bucket,
                            );
                            if seen.insert(key) {
                                super::append_ax_som_debug_log(&format!(
                                    "KEEP depth={} role={} name={:?} bbox=({},{} {}x{})",
                                    depth,
                                    ui.role,
                                    ui.name,
                                    ui.bbox.origin.x,
                                    ui.bbox.origin.y,
                                    ui.bbox.size.w,
                                    ui.bbox.size.h
                                ));
                                out.push(ui);
                            } else {
                                super::append_ax_som_debug_log(&format!(
                                    "DROP duplicate depth={} role={} name={:?} bbox=({},{} {}x{})",
                                    depth,
                                    ui.role,
                                    ui.name,
                                    ui.bbox.origin.x,
                                    ui.bbox.origin.y,
                                    ui.bbox.size.w,
                                    ui.bbox.size.h
                                ));
                            }
                        }
                        Err(reason) => {
                            super::append_ax_som_debug_log(&format!(
                                "DROP depth={} {} {}",
                                depth,
                                reason,
                                debug_element_summary(el)
                            ));
                        }
                    }
                    for child in read_children(el).into_iter().rev() {
                        stack.push((child, depth + 1));
                    }
                    CFRelease(el as *const c_void);
                }
                if start != root {
                    CFRelease(root as *const c_void);
                }
                super::append_ax_som_debug_log(&format!("END kept={}", out.len()));
                out
            }
        }

        pub fn element_from_point(x: i32, y: i32) -> Option<UiElement> {
            let root = frontmost_app_ax_root()?;
            unsafe {
                let mut hit: AXUIElementRef = ptr::null();
                let err = AXUIElementCopyElementAtPosition(root, x as f32, y as f32, &mut hit as *mut _);
                CFRelease(root as *const c_void);
                if err != K_AX_ERROR_SUCCESS || hit.is_null() {
                    return None;
                }
                let point_rect = VRect {
                    origin: VPoint { x, y },
                    size: VSize { w: 1, h: 1 },
                };
                let out = element_to_ui(hit, &point_rect).ok();
                CFRelease(hit as *const c_void);
                out
            }
        }
    }

    pub mod cg_window_capture {
        //! Per-window screenshot via the legacy CGWindowList APIs.
        //!
        //! macOS 14 deprecated CGWindowListCreateImage in favor of
        //! ScreenCaptureKit, but the function still works and is sufficient
        //! for our current needs. We use it for
        //! the `screenshot_window` tool: bundle id → pid → frontmost
        //! on-screen window id → CGImage → JPEG → base64.
        //!
        //! The same TCC permission (Screen Recording) gates this path as
        //! gates full-screen capture, so no extra prompts are needed.

        use super::cg_window_query::{active_display_union, decode_window_bounds, CGRect};
        use super::running_app;
        use crate::{CaptureWindowImage, CaptureWindowOutcome};
        use base64::Engine;
        use std::os::raw::c_void;

        type CFArrayRef = *const c_void;
        type CFDictionaryRef = *const c_void;
        type CFStringRef = *const c_void;
        type CFNumberRef = *const c_void;
        type CFDataRef = *const c_void;
        type CGImageRef = *mut c_void;
        type CGDataProviderRef = *mut c_void;

        type CGWindowID = u32;
        type CGWindowListOption = u32;
        type CGWindowImageOption = u32;

        // Window list options
        const KCG_WINDOW_LIST_ON_SCREEN_ONLY: CGWindowListOption = 1 << 0;
        const KCG_WINDOW_LIST_INCLUDING_WINDOW: CGWindowListOption = 1 << 3;
        const KCG_WINDOW_LIST_EXCLUDE_DESKTOP: CGWindowListOption = 1 << 4;
        const KCG_NULL_WINDOW_ID: CGWindowID = 0;

        // Image options
        const KCG_WINDOW_IMAGE_BOUNDS_IGNORE_FRAMING: CGWindowImageOption = 1 << 0;

        // CFNumber types
        const KCF_NUMBER_SINT32_TYPE: i32 = 3;

        // CGRectNull represents the empty rect; CGWindowListCreateImage
        // treats it as "use the bounds of the targeted window itself".
        const CG_RECT_NULL: CGRect = CGRect {
            origin: super::cg_window_query::CGPoint { x: 0.0, y: 0.0 },
            size: super::cg_window_query::CGSize { width: 0.0, height: 0.0 },
        };

        extern "C" {
            fn CGWindowListCopyWindowInfo(
                option: CGWindowListOption,
                relative_to: CGWindowID,
            ) -> CFArrayRef;
            fn CGWindowListCreateImage(
                screen_bounds: CGRect,
                list_option: CGWindowListOption,
                window_id: CGWindowID,
                image_option: CGWindowImageOption,
            ) -> CGImageRef;

            fn CFArrayGetCount(arr: CFArrayRef) -> isize;
            fn CFArrayGetValueAtIndex(arr: CFArrayRef, idx: isize) -> *const c_void;
            fn CFRelease(cf: *const c_void);

            fn CFDictionaryGetValue(d: CFDictionaryRef, key: *const c_void) -> *const c_void;
            fn CFNumberGetValue(num: CFNumberRef, ty: i32, value: *mut c_void) -> bool;

            fn CGImageGetWidth(image: CGImageRef) -> usize;
            fn CGImageGetHeight(image: CGImageRef) -> usize;
            fn CGImageGetBitsPerComponent(image: CGImageRef) -> usize;
            fn CGImageGetBytesPerRow(image: CGImageRef) -> usize;
            fn CGImageGetDataProvider(image: CGImageRef) -> CGDataProviderRef;
            fn CGImageRelease(image: CGImageRef);
            fn CGDataProviderCopyData(provider: CGDataProviderRef) -> CFDataRef;
            fn CFDataGetBytePtr(data: CFDataRef) -> *const u8;
            fn CFDataGetLength(data: CFDataRef) -> isize;

            // Window dict keys (CFStringRef constants exported by CG framework).
            static kCGWindowNumber: CFStringRef;
            static kCGWindowOwnerPID: CFStringRef;
            static kCGWindowLayer: CFStringRef;
        }

        /// Internal result of the window-id search. Carries the chosen
        /// windowID plus a diagnostic noting whether we hit the standard
        /// layer-0 path or fell back to a non-zero layer (along with all
        /// candidates seen).
        struct WindowSearch {
            window_id: Option<CGWindowID>,
            bounds: Option<CGRect>,
            diagnostic: String,
        }

        pub async fn capture_window(app_identifier: String) -> CaptureWindowOutcome {
            // Step 1: bundle id → pid. Skip if app isn't running.
            let pid = unsafe { running_app::find_pid_for_app(&app_identifier) };
            let Some(pid) = pid else {
                return CaptureWindowOutcome {
                    image: None,
                    diagnostic: format!(
                        "no running app for app '{app_identifier}' — \
                        NSWorkspace.runningApplications has no match. \
                        Confirm the actual app identifier (CFBundleIdentifier on macOS) via \
                        `osascript -e 'id of app \"<App Display Name>\"'`."
                    ),
                };
            };

            // Step 2: enumerate on-screen windows owned by that pid. Prefer
            // layer 0 (standard app window); fall back to any layer if no
            // layer-0 match exists. Tencent (WeChat / QQ), ByteDance (Lark),
            // some Electron apps place the main window at non-zero layers.
            let search = unsafe { find_frontmost_window_id_for_pid(pid) };
            let Some(window_id) = search.window_id else {
                return CaptureWindowOutcome {
                    image: None,
                    diagnostic: format!(
                        "pid={pid} for app '{app_identifier}' owns no on-screen \
                        windows. {} The app may be minimized / off-screen, \
                        or run as a multi-process app whose visible window is \
                        owned by a different pid than NSRunningApplication \
                        reports.",
                        search.diagnostic
                    ),
                };
            };

            // Step 3: capture. Clamp the capture rect to the union of active
            // displays so a partially off-screen window doesn't come back
            // with large black fill for the out-of-bounds portion.
            let capture_rect = search
                .bounds
                .and_then(|bounds| unsafe {
                    active_display_union().and_then(|desktop| bounds.intersection(&desktop))
                })
                .unwrap_or(CG_RECT_NULL);
            let cg_image = unsafe {
                CGWindowListCreateImage(
                    capture_rect,
                    KCG_WINDOW_LIST_INCLUDING_WINDOW,
                    window_id,
                    KCG_WINDOW_IMAGE_BOUNDS_IGNORE_FRAMING,
                )
            };
            if cg_image.is_null() {
                return CaptureWindowOutcome {
                    image: None,
                    diagnostic: format!(
                        "CGWindowListCreateImage returned null for app \
                        '{app_identifier}' pid={pid} windowID={window_id}. \
                        Check Screen Recording TCC permission for the host \
                        app. {}",
                        search.diagnostic
                    ),
                };
            }

            // Step 4: encode + clean up. Defer release through a guard so
            // the early-return path on encode error doesn't leak.
            let encoded = unsafe { cg_image_to_jpeg_base64(cg_image) };
            unsafe { CGImageRelease(cg_image) };
            match encoded {
                Ok(mut image) => {
                    if let Some(bounds) = search
                        .bounds
                        .and_then(|bounds| unsafe {
                            active_display_union().and_then(|desktop| bounds.intersection(&desktop))
                        })
                    {
                        image.origin_x = bounds.origin.x.round() as i64;
                        image.origin_y = bounds.origin.y.round() as i64;
                        image.display_width = bounds.size.width.round() as i64;
                        image.display_height = bounds.size.height.round() as i64;
                    }
                    CaptureWindowOutcome {
                        image: Some(image),
                        diagnostic: if search.diagnostic.is_empty() {
                            "ok".to_string()
                        } else {
                            format!("ok ({})", search.diagnostic)
                        },
                    }
                }
                Err(e) => CaptureWindowOutcome {
                    image: None,
                    diagnostic: format!(
                        "JPEG encode failed for app '{app_identifier}' \
                        windowID={window_id}: {e}. {}",
                        search.diagnostic
                    ),
                },
            }
        }

        /// Walk the on-screen window list owned by `pid`. Two-pass: layer 0
        /// (standard app window) is preferred, but any layer is accepted if
        /// no layer-0 match exists. Returns `WindowSearch` with the chosen
        /// id (or None) and a diagnostic snippet describing which path was
        /// taken (empty string on the standard layer-0 path).
        unsafe fn find_frontmost_window_id_for_pid(pid: i32) -> WindowSearch {
            let arr = CGWindowListCopyWindowInfo(
                KCG_WINDOW_LIST_ON_SCREEN_ONLY | KCG_WINDOW_LIST_EXCLUDE_DESKTOP,
                KCG_NULL_WINDOW_ID,
            );
            if arr.is_null() {
                return WindowSearch {
                    window_id: None,
                    bounds: None,
                    diagnostic:
                        "CGWindowListCopyWindowInfo returned null. Check \
                         Screen Recording TCC permission for the host app."
                            .to_string(),
                };
            }

            let count = CFArrayGetCount(arr);
            let mut layer_zero: Option<(CGWindowID, CGRect)> = None;
            let mut any_layer: Option<(CGWindowID, i32, CGRect)> = None;
            let mut diag: Vec<(i32, i32)> = Vec::new(); // (layer, win_id)

            for i in 0..count {
                let dict = CFArrayGetValueAtIndex(arr, i) as CFDictionaryRef;
                if dict.is_null() {
                    continue;
                }

                // Owner PID
                let pid_num = CFDictionaryGetValue(dict, kCGWindowOwnerPID as *const c_void)
                    as CFNumberRef;
                if pid_num.is_null() {
                    continue;
                }
                let mut win_pid: i32 = 0;
                let ok = CFNumberGetValue(
                    pid_num,
                    KCF_NUMBER_SINT32_TYPE,
                    &mut win_pid as *mut _ as *mut c_void,
                );
                if !ok || win_pid != pid {
                    continue;
                }

                // Window number
                let id_num = CFDictionaryGetValue(dict, kCGWindowNumber as *const c_void)
                    as CFNumberRef;
                if id_num.is_null() {
                    continue;
                }
                let mut win_id: i32 = 0;
                let id_ok = CFNumberGetValue(
                    id_num,
                    KCF_NUMBER_SINT32_TYPE,
                    &mut win_id as *mut _ as *mut c_void,
                );
                if !id_ok {
                    continue;
                }

                // Layer (default to 0 if missing — most CG windows expose it)
                let mut layer: i32 = 0;
                let layer_num = CFDictionaryGetValue(dict, kCGWindowLayer as *const c_void)
                    as CFNumberRef;
                if !layer_num.is_null() {
                    let _ = CFNumberGetValue(
                        layer_num,
                        KCF_NUMBER_SINT32_TYPE,
                        &mut layer as *mut _ as *mut c_void,
                    );
                }

                let Some(bounds) = decode_window_bounds(dict) else {
                    continue;
                };
                diag.push((layer, win_id));
                if layer == 0 && layer_zero.is_none() {
                    layer_zero = Some((win_id as u32, bounds));
                }
                if any_layer.is_none() {
                    any_layer = Some((win_id as u32, layer, bounds));
                }
            }

            CFRelease(arr);

            if let Some((id, bounds)) = layer_zero {
                return WindowSearch {
                    window_id: Some(id),
                    bounds: Some(bounds),
                    // Empty diagnostic = standard path; capture_window() will
                    // emit "ok" alone.
                    diagnostic: String::new(),
                };
            }
            if let Some((id, layer, bounds)) = any_layer {
                return WindowSearch {
                    window_id: Some(id),
                    bounds: Some(bounds),
                    diagnostic: format!(
                        "fell back to layer={layer} window={id}; \
                        candidates (layer,id): {diag:?}"
                    ),
                };
            }

            WindowSearch {
                window_id: None,
                bounds: None,
                diagnostic: format!(
                    "CGWindowList scanned {count} entries total; \
                    no on-screen windows owned by pid={pid}."
                ),
            }
        }

        /// Convert a CGImageRef to a JPEG base64 string. Assumes the standard
        /// 32-bit BGRA pixel format CG returns for window/screen captures
        /// (bits_per_component=8, 4 bytes per pixel).
        ///
        unsafe fn cg_image_to_jpeg_base64(
            cg_image: CGImageRef,
        ) -> napi::Result<CaptureWindowImage> {
            let width = CGImageGetWidth(cg_image);
            let height = CGImageGetHeight(cg_image);
            let bpc = CGImageGetBitsPerComponent(cg_image);
            let bpr = CGImageGetBytesPerRow(cg_image);

            if bpc != 8 {
                return Err(napi::Error::from_reason(format!(
                    "capture_window: unexpected bits_per_component {bpc}"
                )));
            }
            if width == 0 || height == 0 {
                return Err(napi::Error::from_reason(
                    "capture_window: zero-sized window image".to_string(),
                ));
            }
            // bpr/width can be > 4 due to row padding; require >= 4.
            if bpr < width * 4 {
                return Err(napi::Error::from_reason(format!(
                    "capture_window: bytes_per_row {bpr} too small for width {width}"
                )));
            }

            let provider = CGImageGetDataProvider(cg_image);
            if provider.is_null() {
                return Err(napi::Error::from_reason(
                    "capture_window: CGImage has no data provider".to_string(),
                ));
            }
            let data = CGDataProviderCopyData(provider);
            if data.is_null() {
                return Err(napi::Error::from_reason(
                    "capture_window: CGDataProviderCopyData returned null".to_string(),
                ));
            }
            let ptr = CFDataGetBytePtr(data);
            let len = CFDataGetLength(data) as usize;
            if ptr.is_null() || len < bpr * height {
                CFRelease(data);
                return Err(napi::Error::from_reason(
                    "capture_window: CFData payload too small".to_string(),
                ));
            }
            let bytes = std::slice::from_raw_parts(ptr, len);

            // CG returns BGRA premultiplied (default for window captures).
            // Strip alpha to RGB for JPEG (no transparency in JPEG anyway).
            // Walk row-by-row to skip any padding past width*4.
            let mut rgb = Vec::with_capacity(width * height * 3);
            for y in 0..height {
                let row = &bytes[y * bpr..y * bpr + width * 4];
                for px in row.chunks_exact(4) {
                    // BGRA → RGB
                    rgb.push(px[2]); // R
                    rgb.push(px[1]); // G
                    rgb.push(px[0]); // B
                }
            }
            CFRelease(data);

            // Encode JPEG at quality 85 (matches node-screenshots default).
            let mut jpeg = Vec::new();
            let mut encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85);
            encoder
                .encode(
                    &rgb,
                    width as u32,
                    height as u32,
                    image::ExtendedColorType::Rgb8,
                )
                .map_err(|e| napi::Error::from_reason(format!("jpeg encode failed: {e}")))?;

            let base64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);

            Ok(CaptureWindowImage {
                base64,
                width: width as i64,
                height: height as i64,
                origin_x: 0,
                origin_y: 0,
                display_width: width as i64,
                display_height: height as i64,
            })
        }
    }
}
