/**
 * Windows process-jail: bind the agent-browser daemon + our launched Chrome to
 * THIS axiomate process's lifetime at the OS-kernel level, so they can NEVER
 * outlive us — even on `point-the-window-X`, crash, or Task-Manager kill, where
 * no exit signal reaches our graceful-shutdown chain.
 *
 * Why this is needed (and why signal handling alone isn't enough):
 *  - agent-browser has NO no-daemon / owner-pid / foreground mode (verified
 *    against its flag set): every call forks a DETACHED `AGENT_BROWSER_DAEMON=1`
 *    process that deliberately survives the foreground CLI. It WILL outlive us.
 *  - Chrome is launched `detached` too (launcher.ts), so the OS won't reap it
 *    when we exit either.
 *  - On Windows, clicking the terminal's X sends CTRL_CLOSE_EVENT — which Node
 *    does NOT surface as a catchable signal (our SIGHUP handler is POSIX-only),
 *    and the OS gives only a few hundred ms before a hard kill: far too little
 *    to spawn `agent-browser close` + kill Chrome asynchronously.
 *
 * The mechanism: a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. When the
 * last handle to the job closes (i.e. when THIS process exits, by ANY means),
 * the kernel terminates every process assigned to the job. We hold that one
 * handle open for our whole life and never close it. This is the standard
 * Windows answer to "parent dies → children die" and needs no signal capture.
 * Proven locally: an assigned detached child dies within ~1s of the parent
 * exiting, with no signal ever sent.
 *
 * Scope safety (requirements #3/#4): we assign ONLY pids WE own — the Chrome we
 * launched and the daemon for OUR per-pid `--session`. Other axiomate instances
 * have their own jobs and their own pids; nothing here can touch them.
 *
 * No-op off-Windows and wherever bun:ffi is unavailable (e.g. vitest under
 * Node) — the import is lazy + try/caught so callers stay platform-agnostic and
 * tests don't need to know this module exists.
 */

// Held for the process's whole life — closing it would trigger the kill, so we
// never do. `null` = not yet created; once set it stays set.
let jobHandle: unknown = null;
// kernel32 symbol table, resolved once alongside the job.
let k32: {
  OpenProcess: (a: number, b: number, c: number) => unknown;
  AssignProcessToJobObject: (j: unknown, p: unknown) => number;
  CloseHandle: (h: unknown) => number;
} | null = null;
// Set once we know the jail can't work here (non-Windows / no bun:ffi), so we
// stop retrying the dlopen on every attach.
let unavailable = false;

const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

/**
 * Lazily create the kill-on-close job + resolve kernel32 symbols. Returns false
 * (and latches `unavailable`) anywhere the mechanism can't run, so callers can
 * treat jailing as best-effort. Never throws.
 */
async function ensureJob(): Promise<boolean> {
  if (process.platform !== "win32" || unavailable) return false;
  if (jobHandle !== null) return true;
  try {
    const { dlopen, FFIType, ptr } = await import("bun:ffi");
    const lib = dlopen("kernel32.dll", {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      OpenProcess: {
        args: [FFIType.u32, FFIType.i32, FFIType.u32],
        returns: FFIType.ptr,
      },
      AssignProcessToJobObject: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    });
    const job = lib.symbols.CreateJobObjectW(null, null);
    if (!job) {
      unavailable = true;
      return false;
    }
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64; LimitFlags is a
    // DWORD at offset 16 inside the leading BASIC_LIMIT_INFORMATION. Zero the
    // whole struct and set only LimitFlags = KILL_ON_JOB_CLOSE.
    const info = new Uint8Array(144);
    new DataView(info.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
    const ok = lib.symbols.SetInformationJobObject(
      job,
      JobObjectExtendedLimitInformation,
      ptr(info),
      info.byteLength,
    );
    if (!ok) {
      unavailable = true;
      return false;
    }
    jobHandle = job;
    k32 = {
      OpenProcess: lib.symbols.OpenProcess as never,
      AssignProcessToJobObject: lib.symbols.AssignProcessToJobObject as never,
      CloseHandle: lib.symbols.CloseHandle as never,
    };
    return true;
  } catch {
    // bun:ffi missing (Node/vitest) or any FFI error — jail just isn't
    // available here; the graceful-shutdown chain remains the cleanup path.
    unavailable = true;
    return false;
  }
}

/**
 * Bind `pid` to our kill-on-close job so the kernel reaps it when axiomate
 * exits. Best-effort and never throws: a dead/unopenable pid is silently
 * skipped (it's already gone — nothing to reap). On Win8+ a process already in
 * its own job (Chrome sandboxes its children this way) is accepted via nested
 * jobs, so assigning the root Chrome pid is enough — its children die with it.
 */
export async function jailProcess(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (!(await ensureJob()) || k32 === null) return;
  let hProc: unknown = null;
  try {
    hProc = k32.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid);
    if (!hProc) return; // pid already gone, or not ours to open
    k32.AssignProcessToJobObject(jobHandle, hProc);
  } catch {
    // best-effort
  } finally {
    if (hProc) {
      try {
        k32.CloseHandle(hProc);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Test-only: reset the latched state between cases. */
export function __resetJailForTesting(): void {
  jobHandle = null;
  k32 = null;
  unavailable = false;
}
