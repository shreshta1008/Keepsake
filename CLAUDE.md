# Keepsake: rules for working on this repo

Rebuilt on 2026-11-09. The original CLAUDE.md was lost along with the original repo; these rules come from the owner's own summary.

## Product rules (do not break)
- No analytics, no trackers, no third-party scripts beyond the Google Fonts stylesheet already in use.
- Nothing the cloud can read. Memories are sealed with AES-256-GCM on the phone. If sync is ever added, it may store only sealed files, never a key.
- Keys stay on the phone and the tag. The bag's key is written to the NFC tag as part of the link's `#` fragment (`#v1.<bagId>.<key>`), which browsers never send to a server. The Bluetooth haptic module gets only buzz commands, never the key.
- The virtual bag simulator must keep working, so every flow can be tried without hardware.

## Shape of the app
- Plain web app, no build step: `index.html` (UI and logic), `keepsake.config.js` (hardware names, IDs and buzz commands), `bag-haptics.js` (BagHaptics), `tag-reader.js` (TagReader), `sw.js` (offline cache).
- Hardware stays behind two interfaces: `BagHaptics` (simulated or Web Bluetooth) and `TagReader` (tag link or Web NFC; NTAG424 DNA later).
- When you change any shipped file, bump `BUILD` in `index.html` and `CACHE` in `sw.js` together, and add new files to `SHELL` in `sw.js`.
