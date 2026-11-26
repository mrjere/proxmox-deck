# Changelog

All notable changes to Proxmox Deck are listed here, newest first.

## 0.2.0

### Removed

- **Start and shutdown.** The plugin is now view-only. The code that could send commands is gone,
  and the token no longer needs `VM.PowerMgmt`. If you set up with v0.1, see
  [Setup](README.md#setup) to take that permission away.

### Changed

- **Press vs hold, everywhere.** Press opens the web UI, and hold refreshes with visible feedback.
  Previously a long press on a dial also opened the browser, with no sign that anything had
  refreshed.

### Added

- **Storage carousel** and **Tasks & backups** dials.
- Host metrics for **IO delay** (time spent waiting on disks) and **swap**.

## 0.1.1

### Fixed

- Changing a key's settings (for example Host stat → RAM, or picking a guest) had no effect. The
  settings page was identifying its messages with the key's ID. It now uses its own UUID, as
  Elgato's sdpi-components library does. **Test connection** and the guest list were affected by
  the same bug.
- Occasional "disconnects". A read that hits a connection Proxmox has just closed is now retried
  once (reads only; start/shutdown was never retried). Keys only show **Offline** after two failed
  polls in a row, keeping the last good numbers in between.

### Added

- Poll failures and recoveries are written to the plugin log, and a safety net stops a stray
  error from crashing (and restarting) the plugin.

## 0.1.0

- First version.
