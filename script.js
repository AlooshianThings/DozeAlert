/*
  Doze Alert - sleep detector
  Runs two Google Teachable Machine models on the same webcam frame:
    1. Image model (./model)       -> Awake, Eyes Closed, Yawning, Nobody
    2. Pose model  (./pose-model)  -> Awake, Drowsy (head dropping), Nobody
  Both agreeing triggers the alarm fastest; one model alone needs longer.
  The pose model is optional: if it fails to load, the image model runs alone.
*/
(() => {
  "use strict";

  // ---- Settings you can tune ------------------------------------------
  const CONFIG = {
    image: { modelURL: "./model/model.json", metadataURL: "./model/metadata.json" },
    pose: { modelURL: "./pose-model/model.json", metadataURL: "./pose-model/metadata.json" },
    sensitivity: { low: 0.9, medium: 0.8, high: 0.65 }, // probability needed to count as drowsy
    // Evidence builds up while you look drowsy, and the alarm starts at drowsyLimit.
    // Both models agreeing builds it fastest, so one confused model can't set it off alone:
    //   both agree  -> alarm after about 3 seconds
    //   eyes only   -> about 6 seconds
    //   head only   -> about 10 seconds (slouching with open eyes is slow to alarm)
    drowsyLimit: 3,
    rates: { both: 1, eyesOnly: 0.5, headOnly: 0.3 },
    yawnThreshold: 0.8,
    recoverSeconds: 2,     // how long awake (or away) before the alarm clears
    nobodyThreshold: 0.6,
    speechEveryMs: 5000
  };

  // Class names are matched by keyword (lowercase).
  const ROLES = {
    drowsy: ["drows", "sleep", "closed", "nod", "head down", "slump"],
    yawn: ["yawn"],
    awake: ["awake", "alert", "focus", "read", "writ", "upright"],
    nobody: ["nobody", "no one", "empty", "background", "none"]
  };

  // ---- Elements --------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const els = {
    container: $("webcam-container"),
    placeholder: $("placeholder"),
    pill: $("status-pill"),
    title: $("status-title"),
    text: $("status-text"),
    bars: $("bars"),
    start: $("start-btn"),
    stop: $("stop-btn"),
    test: $("test-btn"),
    sens: $("sensitivity"),
    alarm: $("alarm"),
    alarmBtn: $("alarm-btn"),
    time: $("stat-time"),
    alerts: $("stat-alerts"),
    yawns: $("stat-yawns"),
    awake: $("stat-awake"),
    meter: $("meter-fill")
  };

  // ---- State -----------------------------------------------------------
  let imageModel = null;
  let poseModel = null;
  let poseTried = false;
  let webcam = null;
  let running = false;
  let busy = false;
  let rafId = 0;
  let lastTs = 0;
  let wakeLock = null;
  let vibrateTimer = 0;
  let speechTimer = 0;
  let testTimer = 0;
  const groups = []; // bar rows per model: [{fill, value}, ...]

  const session = {};
  resetSession();

  function resetSession() {
    session.drowsyTime = 0;
    session.awakeTime = 0;
    session.alarmActive = false;
    session.yawning = false;
    session.alerts = 0;
    session.yawns = 0;
    session.checkedMs = 0;
    session.awakeMs = 0;
    session.presentMs = 0;
  }

  // ---- Helpers ---------------------------------------------------------
  function roleOf(name) {
    const n = name.toLowerCase();
    for (const [role, keys] of Object.entries(ROLES)) {
      if (keys.some((k) => n.includes(k))) return role;
    }
    return null;
  }

  function summarize(predictions) {
    const p = { drowsy: 0, yawn: 0, awake: 0, nobody: 0 };
    for (const item of predictions) {
      const role = roleOf(item.className);
      if (role) p[role] = Math.max(p[role], item.probability);
    }
    return p;
  }

  function fmtTime(ms) {
    const total = Math.floor(ms / 1000);
    return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
  }

  function setStatus(state, pill, title, text) {
    document.body.dataset.state = state;
    els.pill.textContent = pill;
    els.title.textContent = title;
    els.text.textContent = text;
  }

  function threshold() {
    return CONFIG.sensitivity[els.sens.value] || CONFIG.sensitivity.medium;
  }

  function setMeter(fraction) {
    els.meter.style.width = Math.max(0, Math.min(1, fraction)) * 100 + "%";
  }

  // ---- Bars (one group per model) ---------------------------------------
  function addBarGroup(title, labels) {
    const heading = document.createElement("h5");
    heading.textContent = title;
    els.bars.appendChild(heading);

    const rows = labels.map((label) => {
      const role = roleOf(label);
      const row = document.createElement("div");
      row.className = "bar-row" + (role === "drowsy" ? " is-drowsy" : role === "yawn" ? " is-yawn" : "");
      const name = document.createElement("span");
      name.textContent = label;
      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("div");
      fill.className = "bar-fill";
      track.appendChild(fill);
      const value = document.createElement("span");
      value.className = "bar-value";
      value.textContent = "0%";
      row.append(name, track, value);
      els.bars.appendChild(row);
      return { fill, value };
    });
    groups.push(rows);
    return groups.length - 1;
  }

  function updateBars(groupIndex, predictions) {
    const rows = groups[groupIndex];
    if (!rows) return;
    predictions.forEach((item, i) => {
      if (!rows[i]) return;
      const pct = Math.round(item.probability * 100);
      rows[i].fill.style.width = pct + "%";
      rows[i].value.textContent = pct + "%";
    });
  }

  // ---- Alarm sound -----------------------------------------------------
  // A loud two-tone siren is generated in code and played through a normal
  // <audio> element at full volume. Browsers cannot raise the device volume
  // or break through a muted phone, but this is the loudest, most reliable
  // sound a web page can make (and on iPhones it ignores the silent switch).
  function makeSirenUrl() {
    const rate = 22050;
    const seconds = 1.2;
    const n = Math.floor(rate * seconds);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const seg = Math.floor(i / (rate * 0.15)) % 2;
      phase += (2 * Math.PI * (seg ? 1900 : 1100)) / rate;
      const sample = Math.sin(phase) >= 0 ? 1 : -1; // square wave = loudest
      v.setInt16(44 + i * 2, sample * 0.97 * 32767, true);
    }
    return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  }

  const siren = new Audio(makeSirenUrl());
  siren.loop = true;
  siren.volume = 1;
  siren.preload = "auto";

  // Must run inside a click so the browser allows sound later.
  function unlockAudio() {
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) { /* ignore */ }
    siren.muted = true;
    const p = siren.play();
    const done = () => { siren.pause(); siren.currentTime = 0; siren.muted = false; };
    if (p && p.then) p.then(done).catch(() => { siren.muted = false; }); else done();
  }

  function speakWakeUp() {
    try {
      if (!("speechSynthesis" in window)) return;
      const u = new SpeechSynthesisUtterance("Wake up! Wake up!");
      u.volume = 1;
      u.rate = 1.1;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }

  function buzz() {
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);
  }

  function playSiren() {
    siren.currentTime = 0;
    const p = siren.play();
    if (p && p.catch) p.catch(() => {});
  }

  function startAlarm() {
    if (session.alarmActive) return;
    session.alarmActive = true;
    session.awakeTime = 0;
    session.alerts += 1;
    els.alarm.hidden = false;
    document.body.dataset.state = "alarm";
    els.alarmBtn.focus();
    playSiren();
    buzz();
    vibrateTimer = setInterval(buzz, 2200);
    setTimeout(speakWakeUp, 600);
    speechTimer = setInterval(speakWakeUp, CONFIG.speechEveryMs);
  }

  function stopAlarm() {
    session.alarmActive = false;
    session.drowsyTime = 0;
    session.awakeTime = 0;
    siren.pause();
    siren.currentTime = 0;
    clearInterval(vibrateTimer);
    clearInterval(speechTimer);
    try { if ("speechSynthesis" in window) speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    if (navigator.vibrate) navigator.vibrate(0);
    els.alarm.hidden = true;
  }

  function testSound() {
    if (session.alarmActive) return;
    unlockAudio();
    clearTimeout(testTimer);
    setTimeout(() => {
      playSiren();
      buzz();
      testTimer = setTimeout(() => { if (!session.alarmActive) { siren.pause(); siren.currentTime = 0; } }, 1500);
    }, 120);
  }

  // ---- Keep the phone screen awake while checking ---------------------
  async function requestWake() {
    try {
      if ("wakeLock" in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch (err) { /* not supported or denied */ }
  }

  function releaseWake() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
  }

  document.addEventListener("visibilitychange", () => {
    if (running && document.visibilityState === "visible") requestWake();
  });

  // ---- Per-frame logic -------------------------------------------------
  function handle(imgPreds, posePreds, dtMs) {
    updateBars(0, imgPreds);
    if (posePreds) updateBars(1, posePreds);

    const a = summarize(imgPreds);
    const b = posePreds ? summarize(posePreds) : null;
    const thr = threshold();
    const dt = dtMs / 1000;

    const eyesDrowsy = a.drowsy >= thr;
    const headDrowsy = !!b && b.drowsy >= thr;
    const nobodyScore = b ? (a.nobody + b.nobody) / 2 : a.nobody;
    const awakeScore = b ? (a.awake + b.awake) / 2 : a.awake;

    // How fast evidence builds depends on which models agree.
    let rate = 0;
    if (eyesDrowsy && headDrowsy) rate = CONFIG.rates.both;
    else if (eyesDrowsy) rate = b ? CONFIG.rates.eyesOnly : CONFIG.rates.both; // image model alone: trust it
    else if (headDrowsy) rate = CONFIG.rates.headOnly;

    const nobodyHere = nobodyScore >= CONFIG.nobodyThreshold;
    const isDrowsy = !nobodyHere && rate > 0;
    const isYawning = !nobodyHere && !isDrowsy && a.yawn >= CONFIG.yawnThreshold;
    const isAwake = !nobodyHere && !isDrowsy && !isYawning && awakeScore >= 0.5;

    session.checkedMs += dtMs;
    if (!nobodyHere) session.presentMs += dtMs;
    if (isAwake) session.awakeMs += dtMs;

    // Evidence builds while drowsy, drains quickly otherwise (so blinks and glances don't count).
    if (isDrowsy) session.drowsyTime += dt * rate;
    else session.drowsyTime = Math.max(0, session.drowsyTime - dt * 2);

    setMeter(session.alarmActive ? 1 : session.drowsyTime / CONFIG.drowsyLimit);

    // Yawn counter: once per yawn.
    if (isYawning && !session.yawning) { session.yawning = true; session.yawns += 1; }
    else if (a.yawn < 0.5) session.yawning = false;

    // Alarm on / off.
    if (!session.alarmActive && session.drowsyTime >= CONFIG.drowsyLimit) {
      startAlarm();
    } else if (session.alarmActive) {
      if (isAwake || nobodyHere) {
        session.awakeTime += dt;
        if (session.awakeTime >= CONFIG.recoverSeconds) stopAlarm();
      } else {
        session.awakeTime = 0;
      }
    }

    // Status text.
    let why = "Your eyes are closing";
    if (eyesDrowsy && headDrowsy) why = "Eyes closed and head dropping";
    else if (headDrowsy) why = "Sit up, your head is dropping";

    if (session.alarmActive) {
      setStatus("alarm", "Drowsy", "Wake up!", "Look at the camera with your eyes open to switch the alarm off.");
    } else if (nobodyHere) {
      setStatus("idle", "No one in frame", "No one in frame", "Move into view of the camera to carry on.");
    } else if (isDrowsy) {
      const left = Math.max(0, (CONFIG.drowsyLimit - session.drowsyTime) / rate).toFixed(0);
      setStatus("warn", "Getting sleepy", why, `Alarm in about ${left} seconds if this keeps up. Sit up and open your eyes!`);
    } else if (isYawning) {
      setStatus("warn", "Yawning", "Big yawn!", "Maybe time for water or a short break.");
    } else if (isAwake) {
      setStatus("ok", "Awake", "You look awake", "Nice. Doze Alert is keeping watch.");
    }

    els.time.textContent = fmtTime(session.checkedMs);
    els.alerts.textContent = session.alerts;
    els.yawns.textContent = session.yawns;
    els.awake.textContent = session.presentMs > 0
      ? Math.round((session.awakeMs / session.presentMs) * 100) + "%"
      : "\u2013";
  }

  async function predictPose() {
    const { posenetOutput } = await poseModel.estimatePose(webcam.canvas);
    return poseModel.predict(posenetOutput);
  }

  async function loop(ts) {
    if (!running) return;
    webcam.update();
    if (!busy) {
      busy = true;
      const dtMs = lastTs ? Math.min(ts - lastTs, 500) : 0;
      lastTs = ts;
      try {
        const [imgPreds, posePreds] = await Promise.all([
          imageModel.predict(webcam.canvas),
          poseModel ? predictPose() : Promise.resolve(null)
        ]);
        if (running) handle(imgPreds, posePreds, dtMs);
      } catch (err) {
        console.error(err);
      } finally {
        busy = false;
      }
    }
    rafId = requestAnimationFrame(loop);
  }

  // ---- Start and stop --------------------------------------------------
  async function start() {
    els.start.disabled = true;
    setStatus("idle", "Loading", "Loading the models", "This takes a few seconds the first time.");
    unlockAudio();

    try {
      if (!imageModel) {
        imageModel = await tmImage.load(CONFIG.image.modelURL, CONFIG.image.metadataURL);
        els.bars.replaceChildren();
        groups.length = 0;
        addBarGroup("Image model (eyes and yawns)", imageModel.getClassLabels());
      }
    } catch (err) {
      console.error(err);
      setStatus("idle", "Model not loaded", "Couldn't load the image model",
        "Check that the model folder has model.json, metadata.json and weights.bin, and open this page from a web server, not by double-clicking the file.");
      els.start.disabled = false;
      return;
    }

    if (!poseTried) {
      poseTried = true;
      try {
        if (typeof tmPose === "undefined") throw new Error("pose library not loaded");
        poseModel = await tmPose.load(CONFIG.pose.modelURL, CONFIG.pose.metadataURL);
        addBarGroup("Pose model (head position)", poseModel.getClassLabels());
      } catch (err) {
        console.warn("Pose model not loaded, running with the image model only.", err);
        poseModel = null;
      }
    }

    try {
      webcam = new tmImage.Webcam(400, 400, true); // width, height, flip
      await webcam.setup({ facingMode: "user" });
      await webcam.play();
    } catch (err) {
      console.error(err);
      const denied = err && err.name === "NotAllowedError";
      setStatus("idle", "Camera blocked",
        denied ? "Camera access was blocked" : "No camera found",
        denied ? "Allow camera access in your browser's site settings, then press Start checking again."
               : "Connect a webcam and press Start checking again.");
      els.start.disabled = false;
      return;
    }

    resetSession();
    els.placeholder.hidden = true;
    els.container.replaceChildren(webcam.canvas);
    els.stop.disabled = false;
    running = true;
    lastTs = 0;
    requestWake();
    setStatus("ok", "Checking", "Checking", poseModel ? "Watching your eyes and head." : "Watching your eyes (pose model not loaded).");
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
    stopAlarm();
    if (webcam) webcam.stop();
    releaseWake();
    setMeter(0);
    els.container.replaceChildren();
    els.placeholder.hidden = false;
    els.start.disabled = false;
    els.stop.disabled = true;
    setStatus("idle", "Camera off", "Checking stopped", "Press Start checking to run another session.");
  }

  els.start.addEventListener("click", start);
  els.stop.addEventListener("click", stop);
  els.test.addEventListener("click", testSound);
  els.alarmBtn.addEventListener("click", () => {
    stopAlarm();
    setStatus("ok", "Checking", "Checking", "Alarm cleared.");
  });
})();
