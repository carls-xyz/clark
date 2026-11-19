// ── Dictée : le micro enregistre, le Mac transcrit, le texte arrive dans le champ ──

const mic = $("#mic");
const micTime = $("#mic-time");
const DICTATION_MAX = 5 * 60_000;
let recorder = null;
let recordingCancelled = false;

function renderMic() {
  const can = Boolean(state.voice?.ready && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  mic.hidden = !can && !recorder;
}

function micState(phase) {
  mic.dataset.state = phase;
  mic.setAttribute("aria-pressed", String(phase === "rec"));
  mic.setAttribute("aria-label", phase === "rec" ? "Arrêter la dictée (Échap pour l'annuler)" : phase === "busy" ? "Transcription en cours" : "Dicter un message");
  mic.disabled = phase === "busy";
  micTime.hidden = phase === "idle";
  if (phase === "busy") micTime.textContent = "Transcription…";
}

const dictationError = (text) => {
  sendError.textContent = text;
  sendError.hidden = false;
};

async function startDictation() {
  sendError.hidden = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return dictationError("Micro refusé : autorise-le pour cette page dans le navigateur.");
  }
  const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : {});
  const chunks = [];
  const started = Date.now();
  recordingCancelled = false;
  const tick = () => {
    const sec = Math.floor((Date.now() - started) / 1000);
    micTime.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    if (Date.now() - started > DICTATION_MAX && rec.state === "recording") rec.stop();
  };
  const timer = setInterval(tick, 500);
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    if (recordingCancelled || !chunks.length) {
      micState("idle");
      $("#announce").textContent = "Dictée annulée";
      return;
    }
    micState("busy");
    try {
      const blob = new Blob(chunks, { type: (rec.mimeType || "audio/webm").split(";")[0] });
      const res = await fetch("/api/voice/transcribe", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
      if (!data.text) throw new Error("rien entendu");
      // Le texte s'ajoute à ce qui est déjà écrit ; tu relis avant d'envoyer.
      input.value = input.value.trim() ? `${input.value.trimEnd()} ${data.text}` : data.text;
      autosize();
      send.disabled = !input.value.trim();
      $("#announce").textContent = "Dictée ajoutée au message";
    } catch (err) {
      dictationError(`Dictée non transcrite : ${err.message}`);
    } finally {
      micState("idle");
      renderMic();
      input.focus();
    }
  };
  recorder = rec;
  rec.start();
  tick();
  micState("rec");
}

mic.addEventListener("click", () => (recorder ? recorder.stop() : void startDictation()));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && recorder) {
    recordingCancelled = true;
    recorder.stop();
  }
});

// ── Écouter un message de Clark (voix macOS), et l'essai de voix des réglages ──

let listening = null; // { id, phase: "loading" | "playing", audio }

function stopListening() {
  if (!listening) return;
  listening.audio.pause();
  listening.audio.removeAttribute("src");
  listening = null;
  renderThread();
}

function play(url, id) {
  stopListening();
  const audio = new Audio(url);
  listening = { id, phase: "loading", audio };
  if (id !== null) renderThread();
  audio.addEventListener("playing", () => {
    if (listening?.audio !== audio) return;
    listening.phase = "playing";
    if (id !== null) renderThread();
  });
  const done = () => listening?.audio === audio && stopListening();
  audio.addEventListener("ended", done);
  audio.addEventListener("error", () => {
    if (listening?.audio !== audio) return;
    done();
    const where = id !== null ? sendError : $("#voice-error");
    if (where) {
      where.textContent = "Lecture impossible pour l'instant.";
      where.hidden = false;
    }
  });
  audio.play().catch(() => {});
}

side.addEventListener("click", (e) => {
  const listen = e.target.closest("[data-listen]");
  if (listen) {
    const id = Number(listen.dataset.listen);
    if (listening?.id === id) stopListening();
    else play(`/api/voice/speech/${id}`, id);
    return;
  }
  if (e.target.closest("[data-voice-sample]")) {
    play(`/api/voice/sample?voix=${encodeURIComponent($("#voice-name")?.value ?? "")}`, null);
    return;
  }
  if (e.target.closest("[data-personality-reset]")) void savePersonalityText("", true);
});

async function saveVoice(body) {
  const error = $("#voice-error");
  try {
    await post("/api/voice/settings", body);
    if (error) error.hidden = true;
  } catch (err) {
    if (error) {
      error.textContent = err.message;
      error.hidden = false;
    }
  }
}

side.addEventListener("change", (e) => {
  if (e.target.matches("[data-voice-mode]")) void saveVoice({ mode: e.target.value });
  else if (e.target.matches("[data-voice-name]")) void saveVoice({ voice: e.target.value });
  else if (e.target.matches("[data-voice-vocab]")) void saveVoice({ vocabulary: e.target.value });
});

side.addEventListener("input", (e) => {
  if (e.target.id !== "pf-text") return;
  personalityDirty = true;
  $("#pf-count").textContent = `${e.target.value.length} / ${state.personality?.limit ?? 4000} caractères`;
});

async function savePersonalityText(text, reset = false) {
  if (reset && !(await ask("Revenir à la personnalité par défaut ?", "Ton texte actuel est remplacé.", "Revenir au défaut"))) return;
  const error = $("#pf-error");
  try {
    await post("/api/personality", { text });
    personalityDirty = false;
    renderSettings();
    $("#announce").textContent = "Personnalité enregistrée";
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
}

side.addEventListener("submit", (e) => {
  if (e.target.id !== "personality-form") return;
  e.preventDefault();
  void savePersonalityText(e.target.elements.text.value);
});

const EFFORT_M = { none: "nul", minimal: "minimal", low: "faible", medium: "moyen", high: "élevé", xhigh: "très élevé", max: "maximal" };

// Comparer : Claude contre Codex quand les deux sont là, sinon un même moteur à deux efforts.
function comparePairs() {
  const engines = (state?.engines ?? []).filter((e) => e.ready !== false);
  const pairs = [];
  if (engines.some((e) => e.name === "claude") && engines.some((e) => e.name === "codex"))
    pairs.push({ value: "claude|codex", label: "Claude et Codex", sides: [{ engine: "claude" }, { engine: "codex" }] });
  for (const e of engines) {
    const efforts = [...new Set((e.models ?? []).flatMap((m) => m.efforts ?? []))];
    const [lo, hi] = efforts.includes("medium") && efforts.includes("high") ? ["medium", "high"] : efforts.length >= 2 ? efforts.slice(-2) : [];
    if (lo && hi)
      pairs.push({ value: `${e.name}:${lo}|${e.name}:${hi}`, label: `${ENGINE_NAMES[e.name] ?? e.name}, effort ${EFFORT_M[lo] ?? lo} et ${EFFORT_M[hi] ?? hi}`, sides: [{ engine: e.name, effort: lo }, { engine: e.name, effort: hi }] });
  }
  return pairs;
}

let pairsKey = "";
function renderComparePairs() {
  const pairs = comparePairs();
  const key = pairs.map((x) => x.value).join(",");
  if (key === pairsKey) return;
  pairsKey = key;
  const select = $("#compare-pair");
  const current = select.value;
  select.innerHTML = pairs.length ? pairs.map((x) => `<option value="${esc(x.value)}">${esc(x.label)}</option>`).join("") : `<option value="">Aucun moteur connecté</option>`;
  if (pairs.some((x) => x.value === current)) select.value = current;
}

let projectsKey = "";
function renderProjectOptions() {
  const projects = state.dev?.projects ?? [];
  const key = projects.map((p) => `${p.id}:${p.name}`).join(",");
  if (key === projectsKey) return;
  projectsKey = key;
  const select = $("#dev-project");
  const current = select.value;
  select.innerHTML = projects.length ? projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("") : `<option value="">Aucun projet</option>`;
  if (projects.some((p) => String(p.id) === current)) select.value = current;
  renderComparePairs();
}

showView();


