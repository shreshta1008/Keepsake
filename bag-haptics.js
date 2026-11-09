/* ============================================================
   BagHaptics: how Keepsake makes the bag buzz.

   Interface (both versions below implement it):
     kind                 "simulated" | "bluetooth"
     supported            can this browser do it at all
     state                "unsupported" | "unpaired" | "paired" | "connecting" | "connected"
     needsTap             true when reconnecting needs a button press (no remembered-device support)
     deviceName           the bag's Bluetooth name, once paired
     pair()               ask for the bag (shows the browser's chooser; call from a button press)
     connect()            connect to the remembered bag; resolves true when connected
     buzz(command)        send "tap" | "single" | "strong" | "fx:<1-123>"; resolves { ok, ms, error }
     forget()             stop remembering the bag on this phone
     onChange(fn)         called whenever state changes

   Nothing secret goes over Bluetooth: only the buzz command. The bag's key never leaves the
   phone and the tag.
   ============================================================ */
(() => {
  "use strict";
  const CFG = window.KEEPSAKE_CONFIG.bag;
  const REMEMBER = "keepsake.ble"; // { id, name, pairedAt }: which bag to reconnect to. Not secret.
  const now = () => performance.now();
  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000} s`)), ms))]);

  /** "tap", "single", "strong", or "fx:N" with N from 1 to 123 (DRV2605L library effects). */
  function validCommand(c) {
    if (c === "tap" || c === "single" || c === "strong") return true;
    const m = /^fx:(\d{1,3})$/.exec(c || "");
    return !!m && +m[1] >= 1 && +m[1] <= 123;
  }

  function emitter() {
    const fns = new Set();
    return { on: (fn) => (fns.add(fn), () => fns.delete(fn)), emit: (x) => fns.forEach((fn) => { try { fn(x); } catch {} }) };
  }

  /* ---------- simulated: the Virtual bag panel ---------- */
  function SimulatedBagHaptics({ isPowered = () => true, isNear = () => true } = {}) {
    const ev = emitter();
    return {
      kind: "simulated", supported: true, state: "connected", needsTap: false, deviceName: "Virtual bag",
      async pair() { return true; },
      async connect() { return true; },
      async buzz(command) {
        if (!validCommand(command)) return { ok: false, ms: 0, error: `Unknown command "${command}"` };
        const t0 = now();
        if (!isPowered()) return { ok: false, ms: 0, error: "The virtual bag's haptic module is off." };
        if (!isNear()) return { ok: false, ms: 0, error: "The phone isn't near the virtual bag." };
        await new Promise((r) => setTimeout(r, 250)); // feels like a warm Bluetooth write
        ev.emit({ type: "buzz", command });
        return { ok: true, ms: Math.round(now() - t0) };
      },
      forget() {},
      onChange: ev.on,
      onBuzz: ev.on,
    };
  }

  /* ---------- real: Web Bluetooth to the ESP32-S3 ---------- */
  function BluetoothBagHaptics() {
    const bt = navigator.bluetooth;
    const ev = emitter();
    let device = null, ch = null, connecting = null, queue = Promise.resolve();
    const remembered = () => { try { return JSON.parse(localStorage.getItem(REMEMBER) || "null"); } catch { return null; } };
    const self = {
      kind: "bluetooth",
      supported: !!bt && window.isSecureContext,
      state: "unsupported",
      needsTap: !(bt && typeof bt.getDevices === "function"),
      deviceName: remembered()?.name || "",
      lastError: "",
      lastConnectMs: null,
      onChange: ev.on,
      validCommand,
    };
    const set = (state, err) => { self.state = state; if (err !== undefined) self.lastError = err; ev.emit(self); };
    if (self.supported) self.state = remembered() ? "paired" : "unpaired";

    function onDisconnect() { ch = null; if (self.state !== "unpaired") set("paired"); }

    async function attach(d) {
      if (device && device !== d) device.removeEventListener("gattserverdisconnected", onDisconnect);
      device = d;
      device.addEventListener("gattserverdisconnected", onDisconnect);
      const t0 = now();
      set("connecting");
      const server = await withTimeout(device.gatt.connect(), 10000, "Connecting to the bag");
      let svc;
      try { svc = await withTimeout(server.getPrimaryService(CFG.serviceUuid), 5000, "Finding the bag's service"); }
      catch (e) { try { device.gatt.disconnect(); } catch {} throw new Error(`“${device.name || "That device"}” doesn't have the Keepsake service (${CFG.serviceUuid.slice(0, 8)}…). Pick the bag, or check the firmware's service ID.`); }
      try { ch = await withTimeout(svc.getCharacteristic(CFG.commandUuid), 5000, "Finding the buzz command"); }
      catch (e) { try { device.gatt.disconnect(); } catch {} throw new Error(`The bag has the Keepsake service but not the buzz characteristic (${CFG.commandUuid.slice(0, 8)}…). Check the firmware.`); }
      self.lastConnectMs = Math.round(now() - t0);
      set("connected", "");
      return true;
    }

    /** Ask the browser for the bag. Must run inside a button press.
        showAll: list every nearby Bluetooth device (for when the bag's name or advertisement doesn't match). */
    self.pair = async ({ showAll = false } = {}) => {
      if (!self.supported) return false;
      try {
        const d = await bt.requestDevice(showAll
          ? { acceptAllDevices: true, optionalServices: [CFG.serviceUuid] }
          : {
            // The 128-bit service ID and the name may not both fit in one advertisement, so match any of them.
            filters: [{ services: [CFG.serviceUuid] }, { name: CFG.name }, ...(CFG.namePrefixes || []).map((p) => ({ namePrefix: p }))],
            optionalServices: [CFG.serviceUuid],
          });
        await attach(d); // remember it only once it has proved to be a Keepsake bag
        try { localStorage.setItem(REMEMBER, JSON.stringify({ id: d.id, name: d.name || CFG.name, pairedAt: Date.now() })); } catch {}
        self.deviceName = d.name || CFG.name;
        set("connected", "");
        return true;
      } catch (e) {
        // NotFoundError = the person closed the chooser.
        if (!remembered()) { device = null; ch = null; }
        set(remembered() ? "paired" : "unpaired", e?.name === "NotFoundError" ? "" : String(e?.message || e));
        return false;
      }
    };

    /** Find the remembered bag without a chooser, where the browser allows it. */
    async function rememberedDevice() {
      const r = remembered();
      if (!r) return null;
      if (device && (device.id === r.id || !r.id)) return device;
      if (typeof bt.getDevices !== "function") return null;
      const list = await bt.getDevices();
      return list.find((d) => d.id === r.id) || null;
    }

    /** Wait for the bag to advertise, then connect (Chrome's route for remembered devices). */
    async function connectWhenSeen(d, ms) {
      if (typeof d.watchAdvertisements !== "function") return attach(d);
      const ctl = new AbortController();
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("The bag isn't advertising nearby. Is it switched on and within reach?")), ms);
          d.addEventListener("advertisementreceived", () => { clearTimeout(t); resolve(); }, { once: true });
          d.watchAdvertisements({ signal: ctl.signal }).catch(reject);
        });
      } finally { ctl.abort(); }
      return attach(d);
    }

    /** Connect to the remembered bag. Safe to call often; returns quickly when already connected. */
    self.connect = async ({ waitMs = 12000 } = {}) => {
      if (!self.supported || !remembered()) return false;
      if (ch && device?.gatt?.connected) return true;
      if (connecting) return connecting;
      connecting = (async () => {
        try {
          const d = await rememberedDevice();
          if (!d) { set("paired", self.needsTap ? "Tap “Connect the bag” to reconnect." : "This browser forgot the bag. Pair it again."); return false; }
          try { return await attach(d); }
          catch { return await connectWhenSeen(d, waitMs); }
        } catch (e) { set("paired", String(e?.message || e)); return false; }
        finally { connecting = null; }
      })();
      return connecting;
    };

    async function write(bytes) {
      const p = ch.properties || {};
      if (p.write && ch.writeValueWithResponse) return ch.writeValueWithResponse(bytes);
      if (p.writeWithoutResponse && ch.writeValueWithoutResponse) return ch.writeValueWithoutResponse(bytes);
      return ch.writeValue(bytes); // older browsers (and some iOS Web Bluetooth browsers)
    }

    /** Send one command. Writes run one at a time: a GATT link takes one operation at a time. */
    self.buzz = (command) => {
      const job = queue.then(async () => {
        if (!validCommand(command)) return { ok: false, ms: 0, error: `Unknown command "${command}"` };
        if (!self.supported) return { ok: false, ms: 0, error: "This browser can't use Bluetooth." };
        if (!remembered()) return { ok: false, ms: 0, error: "No bag paired yet." };
        const t0 = now();
        try {
          if (!(await self.connect({ waitMs: 3000 }))) return { ok: false, ms: Math.round(now() - t0), error: self.lastError || "Couldn't reach the bag." };
          const bytes = new TextEncoder().encode(command);
          try { await withTimeout(write(bytes), 3000, "Sending to the bag"); }
          catch { // the link may have dropped silently: reconnect once and retry
            ch = null; try { device?.gatt?.disconnect(); } catch {}
            if (!(await self.connect({ waitMs: 3000 }))) throw new Error(self.lastError || "Lost the bag.");
            await withTimeout(write(bytes), 3000, "Sending to the bag");
          }
          return { ok: true, ms: Math.round(now() - t0) };
        } catch (e) { set(self.state === "connected" ? "connected" : "paired", String(e?.message || e)); return { ok: false, ms: Math.round(now() - t0), error: String(e?.message || e) }; }
      });
      queue = job.catch(() => {});
      return job;
    };

    self.forget = async () => {
      try { device?.removeEventListener("gattserverdisconnected", onDisconnect); device?.gatt?.disconnect(); } catch {}
      try { await device?.forget?.(); } catch {}
      device = null; ch = null;
      try { localStorage.removeItem(REMEMBER); } catch {}
      self.deviceName = "";
      set(self.supported ? "unpaired" : "unsupported", "");
    };

    return self;
  }

  window.BagHaptics = { SimulatedBagHaptics, BluetoothBagHaptics, validCommand };
})();
