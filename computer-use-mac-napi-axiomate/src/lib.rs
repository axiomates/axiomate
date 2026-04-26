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
//! 3. SCContentFilter screenshot — capture a display with non-allowlisted
//!    apps excluded at the compositor level (privacy + agent focus).
//!    macOS 12.3+ ScreenCaptureKit.
//!
//! Non-macOS builds compile to a stub that returns false / null for every
//! function so the JS side's existing fallbacks engage automatically.

use napi_derive::napi;

// ───────────────────────────────────────────────────────────────────────────
// NSRunningApplication.hide / unhide / activate
// ───────────────────────────────────────────────────────────────────────────

#[napi]
pub async fn hide_app(bundle_id: String) -> napi::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos::running_app::hide(&bundle_id))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bundle_id;
        Ok(false)
    }
}

#[napi]
pub async fn unhide_app(bundle_id: String) -> napi::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos::running_app::unhide(&bundle_id))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bundle_id;
        Ok(false)
    }
}

#[napi]
pub async fn activate_app(bundle_id: String) -> napi::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos::running_app::activate(&bundle_id))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bundle_id;
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
// SCContentFilter — allowlist-filtered screenshot
// ───────────────────────────────────────────────────────────────────────────

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
pub async fn capture_excluding(
    opts: CaptureExcludingOpts,
) -> napi::Result<Option<CaptureExcludingResult>> {
    #[cfg(target_os = "macos")]
    {
        macos::sc_capture::capture(opts).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = opts;
        Ok(None)
    }
}

// ───────────────────────────────────────────────────────────────────────────
// macOS-specific implementations
// ───────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    pub mod running_app {
        use objc2::msg_send;
        use objc2::rc::Retained;
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
            bundle_id: &str,
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
                    if bid.to_string() == bundle_id {
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

        pub fn hide(bundle_id: &str) -> bool {
            unsafe { for_each_matching(bundle_id, |app| {
                let _: () = msg_send![app, hide];
            }) }
        }

        pub fn unhide(bundle_id: &str) -> bool {
            unsafe { for_each_matching(bundle_id, |app| {
                let _: () = msg_send![app, unhide];
            }) }
        }

        pub fn activate(bundle_id: &str) -> bool {
            unsafe { for_each_matching(bundle_id, |app| {
                // Pass 0 as default options (NSApplicationActivateAllWindows = 1
                // is the only nontrivial flag pre-14; default 0 is fine for
                // prepareDisplay's "bring forward" use).
                let _: () = msg_send![app, activateWithOptions: 0usize];
            }) }
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

    pub mod sc_capture {
        //! ScreenCaptureKit allowlist-filtered screenshot.
        //!
        //! Conceptually:
        //!   1. SCShareableContent.getShareableContent() → display + apps
        //!   2. SCContentFilter init w/ display, excluding non-allowlisted apps
        //!   3. SCStream + SCStreamConfiguration (single frame, JPEG)
        //!   4. CMSampleBuffer → CGImage → JPEG → base64
        //!
        //! All of this is Swift-first API exposed via Obj-C runtime selectors.
        //! Calling it from Rust is mechanically possible (msg_send! against
        //! Class::get("SCShareableContent") etc.) but requires stitching
        //! ~200 lines of selectors together with care for the async
        //! getShareableContent completion handler bridge.
        //!
        //! Current state: TODO. Returns Ok(None) so the agent falls back to
        //! `node-screenshots`-based full-screen capture (existing behavior),
        //! advertising `screenshotFiltering: 'none'` in capabilities.
        //!
        //! When this is filled in, also flip CLI_CU_CAPABILITIES.screenshotFiltering
        //! from 'none' to 'native' in agent/src/utils/computerUse/common.ts so the
        //! tools.ts description tells the LLM "non-allowlisted apps excluded
        //! at compositor level".

        use super::super::{CaptureExcludingOpts, CaptureExcludingResult};

        pub async fn capture(
            _opts: CaptureExcludingOpts,
        ) -> napi::Result<Option<CaptureExcludingResult>> {
            // TODO: implement via SCShareableContent + SCContentFilter +
            // SCStream pipeline. Returning None lets the JS layer fall back
            // to the existing node-screenshots full-screen capture.
            Ok(None)
        }
    }
}
