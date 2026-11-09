/* ============================================================
   TagReader: how Keepsake reads (and writes) the NFC tag inside the bag.

   The tag holds one NDEF URL record:   https://<keepsake host>/#v1.<bagId>.<key>
     bagId  8 random bytes, base64url (11 characters)
     key    32-byte AES-256 key, base64url (43 characters)
   Everything after "#" stays on the phone: browsers never send it to the server.

   Interface (every reader below implements it):
     kind          "link" | "web-nfc"
     canRead       this browser can read tags with this reader
     canWrite      this browser can write tags with this reader
     scanning      true while listening for a tag
     start(onTag)  begin listening; onTag({ bagId, key, via, tapAt }) for each Keepsake tag
     stop()
     write(url)    write the bag's link onto the next tag held to the phone (resolves when done)

   Readers:
     LinkTagReader      Any phone. The phone's own NFC reading opens the tag's link, which loads
                        Keepsake with #v1... in the address. Works on iPhone (Safari) and Android.
     WebNfcTagReader    Chrome on Android only (Web NFC). Reads and writes inside the open page,
                        so the page (and its Bluetooth link to the bag) stays put.
     Simulated          The Virtual bag panel's Tap button (tapBag() in index.html) stands in for a
                        tap of this bag's own tag.

   NTAG424 DNA later: its SUN messages put a fresh, signed code in the link on every tap. That needs
   a reader whose parse() also checks the code; the rest of the app only sees { bagId, key }.
   ============================================================ */
(() => {
  "use strict";
  const PATTERN = /#?v1\.([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{43})$/;

  /** A tag's link (or just its "#v1..." part) to { bagId, key }, or null when it isn't a Keepsake tag. */
  function parse(text) {
    const m = PATTERN.exec(String(text || "").trim());
    return m ? { bagId: m[1], key: m[2] } : null;
  }
  const linkFor = (host, bag) => `${host}#v1.${bag.id}.${bag.key}`;

  /* ---------- any phone: the tag's link opens this page ---------- */
  function LinkTagReader() {
    let handler = null;
    const onHash = () => { const t = parse(location.hash); if (t && handler) handler({ ...t, via: "tag link", tapAt: performance.now() }); };
    return {
      kind: "link", canRead: true, canWrite: false, scanning: false,
      /** The tag that opened this page, if any. Counts from when the browser started loading it. */
      initial() { const t = parse(location.hash); return t ? { ...t, via: "tag link", tapAt: 0 } : null; },
      start(onTag) { handler = onTag; window.addEventListener("hashchange", onHash); this.scanning = true; },
      stop() { window.removeEventListener("hashchange", onHash); this.scanning = false; },
      async write() { throw new Error("This browser can't write NFC tags. Use the NFC Tools app."); },
    };
  }

  /* ---------- Chrome on Android: Web NFC ---------- */
  function WebNfcTagReader() {
    const supported = "NDEFReader" in window && window.isSecureContext;
    let ctl = null, handler = null, onError = null;
    const self = {
      kind: "web-nfc", canRead: supported, canWrite: supported, scanning: false, lastError: "",
      /** "granted" | "prompt" | "denied" | "unsupported" */
      async permission() {
        if (!supported) return "unsupported";
        try { return (await navigator.permissions.query({ name: "nfc" })).state; } catch { return "prompt"; }
      },
      /** Start listening. The first time, call it from a button press: it asks for permission. */
      async start(onTag, onErr) {
        if (!supported) return false;
        handler = onTag || handler; onError = onErr || onError;
        if (self.scanning) return true;
        ctl = new AbortController();
        const reader = new NDEFReader();
        reader.onreading = (e) => {
          const tapAt = performance.now();
          for (const rec of e.message.records) {
            if (rec.recordType !== "url" && rec.recordType !== "absolute-url" && rec.recordType !== "text") continue;
            const text = new TextDecoder(rec.encoding || "utf-8").decode(rec.data);
            const t = parse(text);
            if (t) { handler?.({ ...t, via: "web nfc", tapAt, serial: e.serialNumber }); return; }
          }
          onError?.("That tag doesn't hold a Keepsake link.");
        };
        reader.onreadingerror = () => onError?.("Couldn't read that tag. Hold the phone still against it and try again.");
        try { await reader.scan({ signal: ctl.signal }); self.scanning = true; self.lastError = ""; return true; }
        catch (e) { self.scanning = false; self.lastError = e?.name === "NotAllowedError" ? "NFC permission was declined. Allow it in Chrome's site settings." : e?.name === "NotReadableError" ? "NFC is off. Turn it on in Android's settings." : String(e?.message || e); return false; }
      },
      stop() { ctl?.abort(); ctl = null; self.scanning = false; },
      /** Write the link onto the next tag held to the phone. Pauses reading meanwhile. */
      async write(url, { timeoutMs = 30000 } = {}) {
        if (!supported) throw new Error("This browser can't write NFC tags.");
        const wasScanning = self.scanning; self.stop();
        const wc = new AbortController();
        const t = setTimeout(() => wc.abort(), timeoutMs);
        try { await new NDEFReader().write({ records: [{ recordType: "url", data: url }] }, { overwrite: true, signal: wc.signal }); }
        catch (e) { throw new Error(e?.name === "AbortError" ? "No tag came near the phone. Try again." : e?.name === "NotAllowedError" ? "NFC permission was declined." : String(e?.message || e)); }
        finally { clearTimeout(t); if (wasScanning) self.start(); }
      },
    };
    return self;
  }

  window.TagReader = { parse, linkFor, LinkTagReader, WebNfcTagReader };
})();
