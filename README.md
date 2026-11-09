# Keepsake: a purse that remembers

A leather heirloom bag that carries each generation's memories forward. You seal a photo, a recording or a few words to a place; it opens only when someone carrying the bag comes back there and taps the bag's NFC tag, and the bag buzzes.

This repo is the web app. It was rebuilt on 2026-11-09 from the live site at https://keepsake-bag.expo.app (the first commit is that site byte for byte), then extended to talk to the real bag.

## What's in the repo

| File | What it does |
|---|---|
| `index.html` | The whole app: screens, encryption (AES-256-GCM), places, the virtual bag simulator |
| `keepsake.config.js` | **The one place for hardware settings**: Bluetooth name (`Keepsake Bag`), service and characteristic IDs, which buzz command each moment sends, where the tag's link points |
| `bag-haptics.js` | `BagHaptics`: a simulated version and a Web Bluetooth version |
| `tag-reader.js` | `TagReader`: the tag-link reader (any phone) and a Web NFC reader (Chrome on Android) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline cache and home-screen install |
| `CLAUDE.md` | Rules for working on this repo |

No build step and no dependencies. No analytics. Nothing leaves the phone except the buzz command to the bag.

## What works where

The browser decides what the hardware can do:

| | Tag tap opens a memory | Write the tag | Bag buzzes over Bluetooth |
|---|---|---|---|
| **Android, Chrome** | Yes: in the open page (Web NFC), or the tag's link opens Chrome | Yes, in the app | Yes (Web Bluetooth) |
| **iPhone, Safari** | Yes: the iPhone reads the tag's link and shows a banner (iPhone XS or newer) | With the NFC Tools app | **No.** No iPhone browser from Apple supports Web Bluetooth. The buzz shows on screen only |
| **iPhone, Bluefy browser** (free, App Store) | Not directly: a tag tap opens Safari, which has separate storage | With the NFC Tools app | Yes (Bluefy adds Web Bluetooth) |
| **Any browser, no hardware** | Virtual bag → Tap | n/a | Virtual bag animates |

**The iPhone gap:** in a browser alone, an iPhone can't do both the tag tap and the buzz in one place. Safari gets the tag tap but has no Bluetooth; Bluefy has Bluetooth but tag taps go to Safari. Two things worth checking on your iPhone:
1. Settings → Apps → Default Browser App: if Bluefy is listed there, set it as the default. Tag taps should then open in Bluefy, which would close the gap. **Unverified**: I don't know whether Bluefy can be a default browser.
2. If it can't, iPhone users get NFC with an on-screen buzz in Safari, or Bluetooth with the virtual Tap in Bluefy. Doing both on iPhone needs the native app route (Expo or Capacitor plus an Apple Developer account), which this rebuild chose not to take for the MVP.

## Run it

Web Bluetooth and Web NFC only work on **https** pages (or `localhost` on the same device).

On a computer, for the simulator:

```bash
cd keepsake
```

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

On your phones, it has to be on an https host. Any static host works: GitHub Pages, Netlify, Cloudflare Pages, or Expo's hosting if you can still sign in to the account that owns `keepsake-bag.expo.app`.

- **Same address (`keepsake-bag.expo.app`):** tags you already wrote keep working, and memories saved there stay visible.
- **New address:** browsers keep data per address, so memories saved on the old site don't appear on the new one (use **Export everything** there first). Rewrite your tags from the new site: the link written to a tag points at whatever address the app is running from, unless `tagHost` in `keepsake.config.js` says otherwise.

After every change, bump `BUILD` in `index.html` and `CACHE` in `sw.js` together, so phones fetch the new files.

## Hardware settings

All in `keepsake.config.js`:

- `bag.name`: `"Keepsake Bag"`, the working name the ESP32-S3 advertises.
- `bag.serviceUuid`: `6e1a0001-4b6f-4d8e-9a53-0c2f6b7a1e10`
- `bag.commandUuid`: `6e1a0002-4b6f-4d8e-9a53-0c2f6b7a1e10` (write; plain text `tap`, `single`, `strong`, `fx:1`…`fx:123`)
- `buzz`: open → `tap`, arrival → `strong`, seal / pass / reply / claim → `single`.

The chooser matches the bag by service ID **or** by name, because a 128-bit service ID and the name together may not fit in one Bluetooth advertisement.

The tag holds one NDEF URL record: `https://<host>/#v1.<bagId>.<key>`. The bag ID is 11 characters and the key 43 (base64url), about 90 bytes in all, which fits easily on an NTAG215 (504 bytes). Everything after `#` stays on the phone. NTAG424 DNA is not implemented yet: it would be a third `TagReader` that also checks the tag's signed code.

## Test it on your phone, step by step

You'll need the bag powered and nearby, an NTAG215 sticker, the site on https, and a stopwatch (your phone's Clock app, run on a second phone).

### Step 1: Bluetooth (Android Chrome, or Bluefy on iPhone)
1. Open the site. Go through the welcome screens and pick **A new bag**. Tap **Make this bag's key**.
2. For now, tap the Virtual bag's **Tap** button to stand in for the tag (step 2 uses the real one). Name the bag and tap **Continue**.
3. **Let the bag buzz** → **Find my bag**. Pick "Keepsake Bag" in the chooser.
   - Check: the bag buzzes once (`single`), and the toast says "Found Keepsake Bag".
   - If the chooser shows nothing: confirm in nRF Connect that the bag is advertising, and that no other app holds the connection.
4. Open **Virtual bag** (bottom right) → **Real bag (Bluetooth)**. Tap **tap**, **single** and **strong**, then enter `47` and tap **Send fx**. Then try `200`.
   - Check: each command feels different, the toast shows the send time, and `200` is refused with "Effects run from 1 to 123".
5. Reload the page and open any memory from the home screen.
   - Check: the memory screen says "Connecting…" and then connects by itself. If it shows a **Connect the bag** button instead, your browser can't reconnect without asking: tap it, then pick the bag.
6. Switch the bag off, then send a test command.
   - Check: within about 3 s you get "The bag didn't buzz: …" and the app doesn't freeze.

### Step 2: NFC
**iPhone (Safari)**
1. Settings & privacy → **Set up the tag** → **Copy this bag's link** → write it with NFC Tools as the steps say.
2. Lock and unlock the phone, then hold its top edge to the tag. Tap the banner.
   - Check: Keepsake opens in Safari with the bag closed, and the address bar shows no `#v1…` part.

**Android (Chrome)**
1. Settings & privacy → **Set up the tag** → **Write the tag with this phone**. Hold the back of the phone flat on the tag.
   - Check: "Written. This tag now opens this bag."
2. On any "Tap your phone to the bag's tag" prompt, tap **Read the tag with this phone** once and allow NFC. After that, Keepsake listens by itself whenever it's open.
3. Tap the tag while Keepsake is open.
   - Check: it reacts in the same tab, and Android doesn't open a new tab. If a new tab opens, note it: in-page reading isn't taking the tap.
4. Tap a sticker that holds some other link.
   - Check: "That tag doesn't hold a Keepsake link."

### Step 3: End to end, and measure against the specs
**Setup:** save a memory at a real spot outdoors, walk more than 100 m away, then come back. Or use Virtual bag → Where you are → a pretend place, set **Distance** to 3 km and then back to **Right here**.

**Tap to open** (spec: 2 s or less, phone 3 cm or closer to the tag)
1. Put the tag inside the bag where it will live, and hold the phone 3 cm away (a 3 cm stack of cards is an easy spacer).
2. Start the stopwatch the moment the phone reaches the tag. Stop it when the memory's words appear.
3. Compare with Virtual bag → **Timing** → `tap→open`. On Android with in-page reading, that number covers the whole tap. On iPhone, it starts when Safari begins loading, so it leaves out the banner tap; your stopwatch includes it.

**Tap to buzz** (spec: 3 s or less, bag within 1 m)
1. Same tap. Stop the stopwatch when you feel the bag buzz.
2. `tap→buzz` in Timing is the time until the bag accepted the command, which is slightly before the motor starts.
3. Run it twice: **warm** (the page already open and connected) and **cold** (reload the page first, which drops the Bluetooth link). Cold is the worst case.
4. Range check: put the bag 1 m from the phone, go to Settings & privacy → **Test the buzz**, and use the stopwatch.

Run each test 10 times and write down the median and the worst:

| Test | Phone / browser | Median | Worst | Pass? |
|---|---|---|---|---|
| Tap to open, 3 cm | | | | |
| Tap to buzz, warm, 1 m | | | | |
| Tap to buzz, cold, 1 m | | | | |

## Tested and untested (as of 2026-11-09)

**Tested** in headless Chromium on a computer, with stand-in ("fake") Bluetooth and NFC objects. These tests check that the app calls the right things; they say nothing about real radios:
- The restored app runs with no errors in a browser without Bluetooth (as Safari would be): onboarding, example bag, arrival, opening a memory with the virtual tap, Settings.
- Claim → **Find my bag** asks for the right service ID and name, remembers the bag, and sends `single`.
- Arrival sends `strong` and opening sends `tap`. The test buttons send `tap`, `single`, `strong` and `fx:47`, and refuse `fx:200`.
- After a reload, the memory screen reconnects by itself (when the browser offers remembered devices). **Forget this bag** works.
- Android-like run: **Write the tag with this phone** writes `https://…/#v1.<id>.<key>` as a URL record and counts as the claim tap. An in-page tag read seals and opens memories and buzzes the bag. A tag from another bag is refused. A page opened by the tag's link still opens the memory and removes the key from the address bar.

**Untested: needs your phone and your bag**
- Pairing with and writing to the real ESP32-S3. In particular, whether the chooser finds it by service ID or by name, and whether the characteristic takes write-with-response.
- Reconnecting without the chooser on Chrome for Android (`getDevices` and `watchAdvertisements`) and in Bluefy. If either isn't available, the app falls back to a **Connect the bag** button, and that fallback is also untested.
- Web NFC on a real Android phone with an NTAG215: reading in place, writing, and whether Android still opens a new tab while Keepsake is listening.
- Whether Bluefy can be set as the iPhone's default browser.
- The new service worker updating cleanly on phones that already have the old site installed.
- All timings against the 2 s and 3 s specs.
- NTAG424 DNA: not built yet.
