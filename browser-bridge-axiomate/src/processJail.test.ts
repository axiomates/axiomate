import { afterEach, describe, expect, it } from "vitest";
import { __resetJailForTesting, jailProcess } from "./processJail.js";

// Under vitest (Node, no bun:ffi) the jail must be a silent no-op: ensureJob's
// dynamic import of "bun:ffi" throws, we latch `unavailable`, and jailProcess
// returns without touching any process. The REAL kernel-reap behavior can only
// be proven under Bun on Windows (done via a scratch E2E during development):
// an assigned detached daemon dies on parent exit with no signal sent. These
// tests just pin the cross-platform contract: never throws, no-ops off-Bun.
describe("processJail (no-op off-Bun/off-Windows)", () => {
  afterEach(() => __resetJailForTesting());

  it("jailProcess(undefined) returns without error", async () => {
    await expect(jailProcess(undefined)).resolves.toBeUndefined();
  });

  it("jailProcess(pid) is a no-op here and never throws", async () => {
    // process.pid is real and alive, but with no bun:ffi the call must still
    // resolve quietly rather than attempting (and failing) an FFI assign.
    await expect(jailProcess(process.pid)).resolves.toBeUndefined();
  });

  it("repeated calls stay quiet after latching unavailable", async () => {
    await jailProcess(process.pid);
    await jailProcess(1);
    await expect(jailProcess(process.pid)).resolves.toBeUndefined();
  });
});
