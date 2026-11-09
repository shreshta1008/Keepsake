/* Keepsake hardware settings: the one place to change the bag's name, Bluetooth IDs and buzz patterns.
   Nothing here is secret: the bag's key lives only on the phone and on the NFC tag, never in this file. */
window.KEEPSAKE_CONFIG = Object.freeze({
  bag: {
    // Bluetooth name the ESP32-S3 advertises. A working name: change it here only.
    name: "Keepsake Bag",
    // Also match any device whose name starts with one of these (Bluetooth names are case-sensitive).
    namePrefixes: ["Keepsake", "keepsake", "KEEPSAKE"],
    serviceUuid: "6e1a0001-4b6f-4d8e-9a53-0c2f6b7a1e10",
    // Write characteristic. Commands are plain text: "tap" (double tap), "single", "strong", "fx:<1-123>".
    commandUuid: "6e1a0002-4b6f-4d8e-9a53-0c2f6b7a1e10",
  },

  // Which command the bag gets for each moment in the app.
  buzz: {
    open: "tap",       // a memory opened
    arrival: "strong", // you reached a place where a memory waits
    seal: "single",    // a memory was sealed (the clasp snaps)
    pass: "single",    // the bag was passed down
    reply: "single",   // a reply was sealed to a memory
    claim: "single",   // the buzzer was paired while claiming the bag
  },

  // The address written onto the NFC tag. null means "wherever this app is served from".
  // Tags already written for keepsake-bag.expo.app keep opening that address.
  tagHost: null,

  // Targets for the MVP measurements (shown in the Virtual bag panel's Timing section).
  specs: { tapToOpenMs: 2000, tapToBuzzMs: 3000 },
});
