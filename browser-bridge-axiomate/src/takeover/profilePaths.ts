/**
 * Default user-profile directories per (browser × OS).
 *
 * "User profile" here means the dir Chrome/Edge/etc. uses BY DEFAULT when
 * the user launches the browser from their Dock/Start Menu. That's the dir
 * carrying their logins, history, extensions, and bookmarks — the whole
 * point of the takeover path vs. the isolated profile.
 *
 * Firefox is intentionally absent: it uses `--profile <path>` (not
 * `--user-data-dir`) AND its default profile is selected at runtime from
 * `profiles.ini`. Different code path; deferred to a later phase.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserKind } from "../types.js";

export interface ProfilePath {
  /** Absolute path to the user-data-dir / Chrome's "User Data" root. */
  userDataDir: string;
}

export function defaultProfilePath(
  kind: BrowserKind,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): ProfilePath | null {
  if (platform === "darwin") {
    return darwinProfilePath(kind);
  }
  if (platform === "win32") {
    return winProfilePath(kind, env);
  }
  return null;
}

function darwinProfilePath(kind: BrowserKind): ProfilePath | null {
  const home = homedir();
  const appSupport = join(home, "Library", "Application Support");
  switch (kind) {
    case "chrome":
      return { userDataDir: join(appSupport, "Google", "Chrome") };
    case "edge":
      return { userDataDir: join(appSupport, "Microsoft Edge") };
    case "brave":
      return { userDataDir: join(appSupport, "BraveSoftware", "Brave-Browser") };
    case "vivaldi":
      return { userDataDir: join(appSupport, "Vivaldi") };
    case "opera":
      return { userDataDir: join(appSupport, "com.operasoftware.Opera") };
    case "arc":
      return { userDataDir: join(appSupport, "Arc", "User Data") };
    case "thorium":
      return { userDataDir: join(appSupport, "Thorium") };
    case "chromium":
      return { userDataDir: join(appSupport, "Chromium") };
    default:
      return null;
  }
}

function winProfilePath(
  kind: BrowserKind,
  env: NodeJS.ProcessEnv,
): ProfilePath | null {
  const local = env.LOCALAPPDATA;
  if (!local) return null;
  switch (kind) {
    case "chrome":
      return { userDataDir: join(local, "Google", "Chrome", "User Data") };
    case "edge":
      return { userDataDir: join(local, "Microsoft", "Edge", "User Data") };
    case "brave":
      return {
        userDataDir: join(
          local,
          "BraveSoftware",
          "Brave-Browser",
          "User Data",
        ),
      };
    case "vivaldi":
      return { userDataDir: join(local, "Vivaldi", "User Data") };
    case "opera":
      return { userDataDir: join(env.APPDATA ?? local, "Opera Software", "Opera Stable") };
    case "thorium":
      return { userDataDir: join(local, "Thorium", "User Data") };
    case "chromium":
      return { userDataDir: join(local, "Chromium", "User Data") };
    default:
      return null;
  }
}
