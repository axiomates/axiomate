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
        use cocoa::base::{id, nil, BOOL, NO};
        use cocoa::foundation::NSString;
        use objc::runtime::Class;
        use objc::{msg_send, sel, sel_impl};

        /// Iterate NSWorkspace.sharedWorkspace.runningApplications, find any
        /// matching `bundle_id`, send the given Obj-C selector. Returns true
        /// if at least one app received the message.
        unsafe fn for_each_matching(bundle_id: &str, selector: objc::runtime::Sel) -> bool {
            let workspace_class = Class::get("NSWorkspace").expect("NSWorkspace class");
            let workspace: id = msg_send![workspace_class, sharedWorkspace];
            let running: id = msg_send![workspace, runningApplications];
            let count: usize = msg_send![running, count];
            let target_bid = NSString::alloc(nil).init_str(bundle_id);
            let mut hit = false;
            for i in 0..count {
                let app: id = msg_send![running, objectAtIndex: i];
                let app_bid: id = msg_send![app, bundleIdentifier];
                if app_bid == nil {
                    continue;
                }
                let is_match: BOOL = msg_send![target_bid, isEqualToString: app_bid];
                if is_match != NO {
                    let _: () = msg_send![app, performSelector: selector];
                    hit = true;
                }
            }
            hit
        }

        pub fn hide(bundle_id: &str) -> bool {
            unsafe { for_each_matching(bundle_id, sel!(hide)) }
        }

        pub fn unhide(bundle_id: &str) -> bool {
            unsafe { for_each_matching(bundle_id, sel!(unhide)) }
        }

        pub fn activate(bundle_id: &str) -> bool {
            // `activateWithOptions:` (NSApplicationActivateAllWindows = 1)
            // is the modern API; here we use the simpler `activate` selector
            // which uses the app's default. Adequate for the prepareDisplay
            // path (resolver re-orders z-order separately).
            unsafe { for_each_matching(bundle_id, sel!(activate)) }
        }
    }

    pub mod escape_tap {
        //! Global Escape hotkey via CGEventTap.
        //!
        //! ## Lifecycle
        //!
        //! `register` creates a session-level event tap filtered to keyDown
        //! events, attaches it to the main CFRunLoop's source, and stashes a
        //! ThreadsafeFunction for the JS callback. The tap callback fires on
        //! every keyDown — we filter for Esc (kVK_Escape = 53), check the
        //! decay gate (`expected_escape_until` in nanoseconds), and either
        //! consume + invoke the callback or pass through.
        //!
        //! `unregister` invalidates the run-loop source and the tap. The
        //! ThreadsafeFunction is dropped via the global `Mutex<Option<…>>`.
        //!
        //! ## Run-loop pump
        //!
        //! The CGEventTap fires on the main CFRunLoop. axiomate's drainRunLoop
        //! (in computer-use-native-axiomate) keeps that runloop ticking via
        //! `_drainMainRunLoop` — when we wire this binding in, the JS side
        //! must keep calling drainRunLoop for events to flow.

        use core_foundation::base::{CFRelease, TCFType};
        use core_foundation::mach_port::CFMachPort;
        use core_foundation::runloop::{
            kCFRunLoopCommonModes, CFRunLoopAddSource, CFRunLoopGetMain, CFRunLoopRemoveSource,
            CFRunLoopSourceRef,
        };
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
            fn CFMachPortInvalidate(port: CFMachPortRef);
            fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
        }

        // kCGKeyboardEventKeycode = 9
        const KEYCODE_FIELD: u32 = 9;

        static EXPECTED_UNTIL_NS: AtomicI64 = AtomicI64::new(0);
        static TAP_PORT: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());
        static SOURCE_REF: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());

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
            // Re-registration is idempotent — drop the old callback, keep the
            // existing tap if one is attached.
            if let Ok(mut guard) = CB.lock() {
                *guard = Some(callback);
            } else {
                return false;
            }
            if !TAP_PORT.load(Ordering::Relaxed).is_null() {
                return true;
            }

            unsafe {
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
                let runloop = CFRunLoopGetMain();
                CFRunLoopAddSource(
                    runloop as CFRunLoopRef as _,
                    source as _,
                    kCFRunLoopCommonModes,
                );
                CGEventTapEnable(port, true);
                TAP_PORT.store(port as *mut std::ffi::c_void, Ordering::Relaxed);
                SOURCE_REF.store(source as *mut std::ffi::c_void, Ordering::Relaxed);
            }
            true
        }

        pub fn unregister() {
            unsafe {
                let port = TAP_PORT.swap(std::ptr::null_mut(), Ordering::Relaxed);
                let source = SOURCE_REF.swap(std::ptr::null_mut(), Ordering::Relaxed);
                if !port.is_null() {
                    CGEventTapEnable(port as CFMachPortRef, false);
                    CFMachPortInvalidate(port as CFMachPortRef);
                }
                if !source.is_null() {
                    let runloop = CFRunLoopGetMain();
                    CFRunLoopRemoveSource(runloop, source as _, kCFRunLoopCommonModes);
                    CFRelease(source as _);
                }
                if !port.is_null() {
                    CFRelease(port as _);
                }
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
