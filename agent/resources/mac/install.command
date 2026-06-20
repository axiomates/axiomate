#!/bin/bash
# Axiomate macOS install helper
#
# The release is not notarized by Apple (no Developer certificate), so copies on
# other Macs get blocked by Gatekeeper and the binaries may fail to run due to
# quarantine or an invalid signature. This script handles as much as possible in
# one pass:
#   1. Detect and (with your consent) install the Xcode Command Line Tools
#      (requires an administrator password; large, slow download)
#   2. Remove the quarantine flag
#   3. Make the executables runnable
#   4. Ad-hoc re-sign every binary to avoid "killed: 9"
#   5. Add this folder to your PATH
#   6. Open System Settings to guide you through the permissions Computer Use needs
#
# Note: Accessibility / Screen Recording / Microphone privacy permissions (TCC)
# cannot be granted by a script — this is a macOS security restriction (not even
# sudo can do it). You must enable them manually in System Settings.
#
# Usage: double-click this file in Finder (or run ./install.command in a terminal).

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

BINS=(axiomate agent-browser rg rtk)

echo ""
echo "Axiomate install helper"
echo "Directory: $DIR"
echo ""

# -- 1. Xcode Command Line Tools (provides codesign, git, etc.) ----------------
echo "[1/6] Checking Xcode Command Line Tools ..."
ensure_clt() {
  if xcode-select -p >/dev/null 2>&1 && command -v codesign >/dev/null 2>&1; then
    echo "      Already installed"
    return 0
  fi
  echo "      Not found. Tools such as codesign depend on it."
  printf "      Install now? Large download, may take 10-30 minutes. [Y/n] "
  read -r ans
  case "${ans:-Y}" in
    ([Nn]*) echo "      Skipped (if you later hit \"killed: 9\", run: xcode-select --install)"; return 1 ;;
  esac
  # Headless install: softwareupdate trigger file + resolve the latest CLT label
  local trigger="/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress"
  touch "$trigger"
  local label
  label=$(softwareupdate -l 2>/dev/null | awk -F'Label: ' '/Command Line Tools/{print $2}' | tail -n1 | tr -d '\n')
  if [ -n "$label" ]; then
    echo "      Installing: $label"
    echo "      You may be prompted for your administrator password (for softwareupdate)."
    sudo softwareupdate -i "$label" --verbose
  else
    echo "      Falling back to the graphical installer. Click \"Install\", then re-run this script."
    xcode-select --install 2>/dev/null || true
    rm -f "$trigger"
    return 1
  fi
  rm -f "$trigger"
  command -v codesign >/dev/null 2>&1
}
CLT_OK=0
ensure_clt && CLT_OK=1

# -- 2. quarantine -------------------------------------------------------------
echo "[2/6] Removing the download quarantine flag ..."
xattr -dr com.apple.quarantine "$DIR" 2>/dev/null || true
echo "      Done"

# -- 3. executable permissions -------------------------------------------------
echo "[3/6] Adding executable permissions ..."
for b in "${BINS[@]}"; do
  [ -f "$DIR/$b" ] && chmod +x "$DIR/$b"
done
echo "      Done"

# git is provided by the Xcode Command Line Tools; no Homebrew required.
if command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; then
  echo "      Git available: $(git --version 2>/dev/null)"
else
  echo "      Note: Git not detected. Installing the Xcode Command Line Tools provides Git;"
  echo "            if you skipped that step, run: xcode-select --install"
fi

# -- 4. ad-hoc re-sign ---------------------------------------------------------
echo "[4/6] Re-signing (ad-hoc) to pass local verification ..."
if [ "$CLT_OK" = "1" ] && command -v codesign >/dev/null 2>&1; then
  while IFS= read -r f; do
    codesign --force --sign - "$f" >/dev/null 2>&1 || true
  done < <(find "$DIR" -maxdepth 1 \( -name '*.node' -o -name '*.dylib' \) -type f; \
           for b in "${BINS[@]}"; do [ -f "$DIR/$b" ] && echo "$DIR/$b"; done)
  echo "      Done"
else
  echo "      Skipped: codesign unavailable (quarantine is already removed, so it usually"
  echo "            still runs; if you hit \"killed: 9\", install the CLT and re-run this script)"
fi

# -- 5. PATH -------------------------------------------------------------------
echo "[5/6] Configuring PATH ..."
add_path() {
  local rc="$1"
  if [ -f "$rc" ] && grep -Fq "$DIR" "$rc" 2>/dev/null; then
    echo "      Already in $rc, skipping"
  else
    printf '\n# Added by Axiomate installer\nexport PATH="%s:$PATH"\n' "$DIR" >> "$rc"
    echo "      Written to $rc (effective in a new terminal)"
  fi
}

# zsh (macOS default): both login and interactive shells read .zshrc.
add_path "$HOME/.zshrc"

# bash: write PATH once to .bashrc, then make sure .bash_profile sources it.
# On macOS, Terminal starts login shells, which read .bash_profile (not .bashrc),
# so without this link the PATH in .bashrc would never load.
add_path "$HOME/.bashrc"
BASH_PROFILE="$HOME/.bash_profile"
if [ -f "$BASH_PROFILE" ] && grep -Fq '.bashrc' "$BASH_PROFILE" 2>/dev/null; then
  echo "      $BASH_PROFILE already sources .bashrc, skipping"
else
  printf '\n# Added by Axiomate installer: load .bashrc for login shells\n[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n' >> "$BASH_PROFILE"
  echo "      Linked $BASH_PROFILE -> .bashrc"
fi

# -- 6. System permissions guidance (TCC, cannot be granted by a script) -------
echo "[6/6] System permissions ..."
echo ""
echo "------------------------------------------------------------"
echo "Computer Use (desktop automation), screen capture, and the microphone"
echo "rely on the following system permissions. They cannot be granted by a"
echo "script or by sudo; you must enable them manually in System Settings:"
echo "  - Accessibility"
echo "  - Screen Recording"
echo "  - Microphone"
echo ""
echo "Opening System Settings -> Privacy & Security ..."
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null || true
echo "Add and check your terminal / axiomate in the list."
echo "------------------------------------------------------------"
echo ""
echo "Installation complete. Open a new terminal and run: axiomate --help"
echo ""
