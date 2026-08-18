"use strict";

/* ======================= STORAGE ======================= */
const STORAGE_KEY = "calendarioIA:v1";

const DEFAULT_STATE = {
  settings: {
    geminiApiKey: "",
    geminiModel: "gemini-2.5-flash",
    wakeTime: "07:00",
    sleepTime: "23:00",
    preferences: "",
  },
  weeklySchedule: [], // {id, day(1-7 Lun-Dom), title, start, end}
  books: [],          // {id, title, author, totalPages, currentPage, deadline, priority, finished}
  tasks: [],          // {id, title, date(YYYY-MM-DD|null), duration(min|null), priority, notes, done}
  days: {},           // { "YYYY-MM-DD": { blocks: [{id,start,end,title,note,type,source,relatedId,done}] } }
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    return {
      settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
      weeklySchedule: parsed.weeklySchedule || [],
      books: parsed.books || [],
      tasks: parsed.tasks || [],
      days: parsed.days || {},
    };
  } catch (e) {
    console.error("Error leyendo datos, se reinicia estado", e);
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();

/* ======================= HELPERS ======================= */
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function pad2(n) { return String(n).padStart(2, "0"); }
function dateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function isoDow(d) { const x = d.getDay(); return x === 0 ? 7 : x; } // 1=Lunes..7=Domingo

const DOW_NAMES = ["", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
const MONTH_NAMES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

function subtitleFor(d) {
  return `${DOW_NAMES[isoDow(d)]}, ${d.getDate()} de ${MONTH_NAMES[d.getMonth()]}`;
}

function timeToMin(t) {
  if (!t) return 0;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minToLabel(m) { return `${pad2(Math.floor(m/60))}:${pad2(m%60)}`; }

function overlaps(aStart, aEnd, bStart, bEnd) {
  return timeToMin(aStart) < timeToMin(bEnd) && timeToMin(bStart) < timeToMin(aEnd);
}

function daysUntil(dateStr, fromKey) {
  if (!dateStr) return null;
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = dateStr.split("-").map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86400000);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function toast(msg, ms = 2600) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

const PRIORITY_ORDER = { alta: 0, media: 1, baja: 2 };
const PRIORITY_LABEL = { alta: "Alta prioridad", media: "Prioridad media", baja: "Baja prioridad" };

/* ======================= NAVIGATION ======================= */
const VIEWS = ["hoy", "semana", "libros", "tareas", "ajustes"];
let currentView = "hoy";

function switchView(view) {
  currentView = view;
  VIEWS.forEach((v) => {
    document.getElementById(`view-${v}`).hidden = v !== view;
  });
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.view === view);
  });
  const titles = { hoy: "Hoy", semana: "Semana", libros: "Libros", tareas: "Tareas", ajustes: "Ajustes" };
  document.getElementById("topbarTitle").textContent = titles[view];
  if (view !== "hoy") document.getElementById("topbarSubtitle").textContent = "";
  renderView(view);
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

function renderView(view) {
  if (view === "hoy") renderHoy();
  else if (view === "semana") renderSemana();
  else if (view === "libros") renderLibros();
  else if (view === "tareas") renderTareas();
  else if (view === "ajustes") renderAjustes();
}

function renderAll() { renderView(currentView); }

/* ======================= SHEET (modal) ======================= */
const sheetOverlay = document.getElementById("sheetOverlay");
const sheetContent = document.getElementById("sheetContent");

function openSheet(html) {
  sheetContent.innerHTML = html;
  sheetOverlay.hidden = false;
}
function closeSheet() {
  sheetOverlay.hidden = true;
  sheetContent.innerHTML = "";
}
sheetOverlay.addEventListener("click", (e) => { if (e.target === sheetOverlay) closeSheet(); });

function chipRowHtml(name, options, selected) {
  return `<div class="chip-row" data-chipgroup="${name}">` +
    options.map(([val, label]) =>
      `<button type="button" class="chip${val === selected ? " selected" : ""}" data-value="${val}">${label}</button>`
    ).join("") + `</div>`;
}
function wireChipRow(root, name) {
  const group = root.querySelector(`[data-chipgroup="${name}"]`);
  group.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    group.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
    chip.classList.add("selected");
  });
}
function chipValue(root, name) {
  const sel = root.querySelector(`[data-chipgroup="${name}"] .chip.selected`);
  return sel ? sel.dataset.value : null;
}

/* ======================= HOY / SELECTOR DE DÍA ======================= */
let selectedKey = dateKey(new Date());

function rollingWeekDates(n = 7) {
  const out = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  for (let i = 0; i < n; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    out.push(d);
  }
  return out;
}

function keyToDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function renderDayPicker() {
  const container = document.getElementById("dayPicker");
  const dates = rollingWeekDates();
  container.innerHTML = dates.map((d, i) => {
    const key = dateKey(d);
    const label = i === 0 ? "Hoy" : i === 1 ? "Mañana" : DOW_NAMES[isoDow(d)].slice(0, 3);
    return `<button type="button" class="day-chip${key === selectedKey ? " selected" : ""}" data-key="${key}"><span class="dow">${label}</span>${d.getDate()}</button>`;
  }).join("");
}

document.getElementById("dayPicker").addEventListener("click", (e) => {
  const chip = e.target.closest(".day-chip");
  if (!chip) return;
  selectedKey = chip.dataset.key;
  renderHoy();
});

function todayBlocksSorted(key) {
  const day = state.days[key];
  const blocks = day ? [...day.blocks] : [];
  blocks.sort((a, b) => timeToMin(a.start) - timeToMin(b.start));
  return blocks;
}

function renderHoy() {
  renderDayPicker();
  const timeline = document.getElementById("todayTimeline");
  const empty = document.getElementById("todayEmpty");
  const blocks = todayBlocksSorted(selectedKey);

  empty.style.display = blocks.length ? "none" : "";
  timeline.innerHTML = blocks.map(blockHtml).join("");

  const isToday = selectedKey === dateKey(new Date());
  const heading = document.getElementById("todayHeading");
  if (heading) {
    heading.textContent = isToday ? "Horario de hoy" : `Horario del ${DOW_NAMES[isoDow(keyToDate(selectedKey))]} ${keyToDate(selectedKey).getDate()}`;
  }
  if (currentView === "hoy") {
    document.getElementById("topbarSubtitle").textContent = subtitleFor(keyToDate(selectedKey));
  }
}

function blockHtml(b) {
  const typeClass = `type-${b.source === "fixed" ? "fixed" : b.type === "lectura" ? "book" : b.source === "manual" ? "manual" : "ai"}`;
  const locked = b.source === "fixed";
  return `
  <div class="block ${typeClass}${b.done ? " done" : ""}" data-id="${b.id}">
    ${locked
      ? `<div class="block-check" style="visibility:hidden"></div>`
      : `<div class="block-check${b.done ? " checked" : ""}" data-action="toggle-done">${b.done ? "✓" : ""}</div>`}
    <div class="block-main">
      <div class="block-time">${b.start} – ${b.end}</div>
      <div class="block-title${b.done ? " strike" : ""}">${escapeHtml(b.title)}${locked ? `<span class="block-lock">🔒</span>` : ""}</div>
      ${b.note ? `<div class="block-note">${escapeHtml(b.note)}</div>` : ""}
    </div>
    ${locked ? "" : `
    <div class="block-actions">
      <button data-action="edit-block">✏️</button>
      <button data-action="delete-block">🗑</button>
    </div>`}
  </div>`;
}

document.getElementById("todayTimeline").addEventListener("click", (e) => {
  const blockEl = e.target.closest(".block");
  if (!blockEl) return;
  const id = blockEl.dataset.id;
  const action = e.target.closest("[data-action]")?.dataset.action;
  const blocks = state.days[selectedKey]?.blocks || [];
  const b = blocks.find((x) => x.id === id);
  if (!b) return;

  if (action === "toggle-done") {
    b.done = !b.done;
    saveState(); renderHoy();
  } else if (action === "delete-block") {
    state.days[selectedKey].blocks = blocks.filter((x) => x.id !== id);
    saveState(); renderHoy();
  } else if (action === "edit-block") {
    openManualBlockSheet(selectedKey, b);
  }
});

document.getElementById("btnAddManualToday").addEventListener("click", () => {
  openManualBlockSheet(selectedKey, null);
});

function openManualBlockSheet(key, existing) {
  const isEdit = !!existing;
  const dateLabel = key === dateKey(new Date()) ? "hoy" : `el ${DOW_NAMES[isoDow(keyToDate(key))]} ${keyToDate(key).getDate()}`;
  openSheet(`
    <h3>${isEdit ? "Editar bloque" : `Agregar bloque · ${dateLabel}`}</h3>
    <div class="field-row">
      <div class="field"><label>Inicio</label><input type="time" id="f-start" value="${existing?.start || "09:00"}"></div>
      <div class="field"><label>Fin</label><input type="time" id="f-end" value="${existing?.end || "10:00"}"></div>
    </div>
    <div class="field"><label>Título</label><input type="text" id="f-title" placeholder="Ej: Recado, llamada..." value="${escapeHtml(existing?.title || "")}"></div>
    <div class="field"><label>Nota (opcional)</label><input type="text" id="f-note" value="${escapeHtml(existing?.note || "")}"></div>
    <div class="sheet-buttons">
      ${isEdit ? `<button class="btn-danger" id="f-delete">Eliminar</button>` : ""}
      <button class="btn-primary" id="f-save">Guardar</button>
    </div>
  `);
  const root = sheetContent;
  root.querySelector("#f-save").addEventListener("click", () => {
    const start = root.querySelector("#f-start").value;
    const end = root.querySelector("#f-end").value;
    const title = root.querySelector("#f-title").value.trim();
    const note = root.querySelector("#f-note").value.trim();
    if (!title || !start || !end) { toast("Completa título y horario"); return; }
    if (!state.days[key]) state.days[key] = { blocks: [] };
    if (isEdit) {
      Object.assign(existing, { start, end, title, note });
    } else {
      state.days[key].blocks.push({ id: uid(), start, end, title, note, type: "manual", source: "manual", done: false });
    }
    saveState(); closeSheet(); renderHoy();
  });
  if (isEdit) {
    root.querySelector("#f-delete").addEventListener("click", () => {
      state.days[key].blocks = state.days[key].blocks.filter((x) => x.id !== existing.id);
      saveState(); closeSheet(); renderHoy();
    });
  }
}

/* ======================= ARCHIVOS ADJUNTOS (Gemini Files API) ======================= */
// Los archivos viven solo en memoria (nunca en localStorage). Se suben a Gemini justo
// antes de organizar, se usan para esa única respuesta, y se eliminan de Gemini enseguida.
let pendingAttachments = []; // File[]
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_SIZE = 18 * 1024 * 1024; // 18MB, con margen bajo el límite de la API

function renderAttachList() {
  const list = document.getElementById("attachList");
  list.innerHTML = pendingAttachments.map((f, i) => `
    <div class="attach-chip">
      <span class="name">📄 ${escapeHtml(f.name)}</span>
      <button type="button" data-index="${i}">✕</button>
    </div>`).join("");
}

document.getElementById("btnAttach").addEventListener("click", () => {
  document.getElementById("fileInput").click();
});

document.getElementById("fileInput").addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  for (const f of files) {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) { toast(`Máximo ${MAX_ATTACHMENTS} archivos a la vez`); break; }
    if (f.size > MAX_ATTACHMENT_SIZE) { toast(`"${f.name}" es muy grande (máx. 18MB)`); continue; }
    pendingAttachments.push(f);
  }
  renderAttachList();
  e.target.value = "";
});

document.getElementById("attachList").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-index]");
  if (!btn) return;
  pendingAttachments.splice(Number(btn.dataset.index), 1);
  renderAttachList();
});

function guessMimeType(file) {
  if (file.type) return file.type;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const map = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", heic: "image/heic", heif: "image/heif", txt: "text/plain", md: "text/markdown" };
  return map[ext] || "application/octet-stream";
}

async function uploadFileToGemini(apiKey, file) {
  const mimeType = guessMimeType(file);
  const startRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(file.size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: file.name } }),
  });
  if (!startRes.ok) {
    let msg = `${startRes.status} ${startRes.statusText}`;
    try { const j = await startRes.json(); if (j?.error?.message) msg = j.error.message; } catch {}
    throw new Error(`No se pudo iniciar la subida de "${file.name}": ${msg}`);
  }
  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error(`No se pudo iniciar la subida de "${file.name}" a Gemini.`);

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(file.size),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: file,
  });
  if (!uploadRes.ok) throw new Error(`No se pudo subir "${file.name}" a Gemini.`);
  const data = await uploadRes.json();
  return waitForFileActive(apiKey, data.file);
}

async function waitForFileActive(apiKey, info) {
  let tries = 0;
  while (info.state === "PROCESSING" && tries < 10) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${info.name}?key=${encodeURIComponent(apiKey)}`);
    if (res.ok) info = await res.json();
    tries++;
  }
  if (info.state === "FAILED") throw new Error(`Gemini no pudo procesar "${info.displayName || info.name}".`);
  return info;
}

async function deleteGeminiFile(apiKey, name) {
  try {
    await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${encodeURIComponent(apiKey)}`, { method: "DELETE" });
  } catch (e) {
    console.error("No se pudo eliminar el archivo de Gemini", e);
  }
}

async function uploadAttachments(apiKey, statusEl) {
  if (!pendingAttachments.length) return [];
  const uploaded = [];
  for (const file of pendingAttachments) {
    statusEl.textContent = `Subiendo "${file.name}" a Gemini…`;
    uploaded.push(await uploadFileToGemini(apiKey, file));
  }
  return uploaded;
}

async function cleanupAttachments(apiKey, uploaded) {
  if (!uploaded.length) return;
  await Promise.all(uploaded.map((f) => deleteGeminiFile(apiKey, f.name)));
  pendingAttachments = [];
  renderAttachList();
}

function attachmentParts(uploaded) {
  return uploaded.map((f) => ({ fileData: { fileUri: f.uri, mimeType: f.mimeType } }));
}

/* ======================= AI ORGANIZE ======================= */
document.getElementById("btnOrganize").addEventListener("click", () => organizeDay(selectedKey));
document.getElementById("btnOrganizeWeek").addEventListener("click", organizeWeek);

function buildPendingBooks(fromKey) {
  return state.books.filter((b) => !b.finished).map((b) => {
    const remaining = Math.max((b.totalPages || 0) - (b.currentPage || 0), 0);
    const dLeft = b.deadline ? daysUntil(b.deadline, fromKey) : null;
    const suggested = dLeft && dLeft > 0 ? Math.ceil(remaining / dLeft) : null;
    return { ...b, remaining, daysLeft: dLeft, suggestedPagesToday: suggested };
  }).sort((a, b) => {
    const da = a.daysLeft === null ? Infinity : a.daysLeft;
    const db = b.daysLeft === null ? Infinity : b.daysLeft;
    return da - db;
  });
}

async function organizeDay(targetKey) {
  const { geminiApiKey, geminiModel, wakeTime, sleepTime, preferences } = state.settings;
  const statusEl = document.getElementById("aiStatus");

  if (!geminiApiKey) {
    toast("Primero agrega tu clave de Gemini en Ajustes");
    switchView("ajustes");
    return;
  }

  const dow = isoDow(keyToDate(targetKey));
  const extra = document.getElementById("todayContext").value.trim();

  const fixedBlocks = state.weeklySchedule
    .filter((b) => b.day === dow)
    .sort((a, b) => timeToMin(a.start) - timeToMin(b.start));

  if (!state.days[targetKey]) state.days[targetKey] = { blocks: [] };
  const manualBlocks = state.days[targetKey].blocks.filter((b) => b.source === "manual");

  const pendingTasks = state.tasks
    .filter((t) => !t.done && (t.date === targetKey || t.date === null || (t.date && t.date < targetKey)))
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

  const pendingBooks = buildPendingBooks(targetKey);

  let prompt = buildPrompt({
    dayName: DOW_NAMES[dow], dateKey: targetKey, wakeTime, sleepTime, preferences, extra,
    fixedBlocks, manualBlocks, pendingTasks, pendingBooks,
  });

  const btns = [document.getElementById("btnOrganize"), document.getElementById("btnOrganizeWeek")];
  btns.forEach((b) => (b.disabled = true));
  let uploaded = [];

  try {
    if (pendingAttachments.length) {
      uploaded = await uploadAttachments(geminiApiKey, statusEl);
      prompt += `\n\nSe adjuntaron ${uploaded.length} archivo(s) (fotos o documentos). Revisa su contenido (puede ser un horario de clases/trabajo, una lista de lecturas, un sílabo, tareas, etc.) y úsalo para tu planificación.`;
    }
    statusEl.textContent = "Pensando en el mejor horario…";
    const aiBlocks = await callGeminiJSON(geminiApiKey, geminiModel, [...attachmentParts(uploaded), { text: prompt }]);
    if (!Array.isArray(aiBlocks)) throw new Error("Respuesta inesperada de la IA.");
    const cleaned = sanitizeAiBlocks(aiBlocks, fixedBlocks, manualBlocks, wakeTime, sleepTime);

    state.days[targetKey].blocks = [
      ...fixedBlocks.map((b) => ({ id: `fixed-${b.id}`, start: b.start, end: b.end, title: b.title, note: "", type: "fijo", source: "fixed", done: false })),
      ...manualBlocks,
      ...cleaned,
    ];
    saveState();
    if (selectedKey === targetKey) renderHoy();
    statusEl.textContent = `Listo ✓ ${cleaned.length} bloque(s) nuevos agregados.`;
    document.getElementById("todayContext").value = "";
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    if (uploaded.length) {
      const finalMsg = statusEl.textContent;
      statusEl.textContent = `${finalMsg}\nEliminando archivo(s) de Gemini…`;
      await cleanupAttachments(geminiApiKey, uploaded);
      statusEl.textContent = finalMsg;
    }
    btns.forEach((b) => (b.disabled = false));
    setTimeout(() => { statusEl.textContent = ""; }, 7000);
  }
}

async function organizeWeek() {
  const { geminiApiKey, geminiModel, wakeTime, sleepTime, preferences } = state.settings;
  const statusEl = document.getElementById("aiStatus");

  if (!geminiApiKey) {
    toast("Primero agrega tu clave de Gemini en Ajustes");
    switchView("ajustes");
    return;
  }

  const extra = document.getElementById("todayContext").value.trim();
  const days = rollingWeekDates().map((d) => {
    const key = dateKey(d);
    const dow = isoDow(d);
    const fixedBlocks = state.weeklySchedule.filter((b) => b.day === dow).sort((a, b) => timeToMin(a.start) - timeToMin(b.start));
    if (!state.days[key]) state.days[key] = { blocks: [] };
    const manualBlocks = state.days[key].blocks.filter((b) => b.source === "manual");
    return { key, dow, dayName: DOW_NAMES[dow], fixedBlocks, manualBlocks };
  });

  const lastKey = days[days.length - 1].key;
  const pendingTasks = state.tasks
    .filter((t) => !t.done && (!t.date || t.date <= lastKey))
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  const pendingBooks = buildPendingBooks(days[0].key);

  let prompt = buildWeekPrompt({ days, wakeTime, sleepTime, preferences, extra, pendingTasks, pendingBooks });

  const btns = [document.getElementById("btnOrganize"), document.getElementById("btnOrganizeWeek")];
  btns.forEach((b) => (b.disabled = true));
  let uploaded = [];

  try {
    if (pendingAttachments.length) {
      uploaded = await uploadAttachments(geminiApiKey, statusEl);
      prompt += `\n\nSe adjuntaron ${uploaded.length} archivo(s) (fotos o documentos). Revisa su contenido (puede ser un horario de clases/trabajo, una lista de lecturas, un sílabo, tareas, etc.) y úsalo para tu planificación de la semana.`;
    }
    statusEl.textContent = "Planeando tu semana…";
    const weekPlan = await callGeminiJSON(geminiApiKey, geminiModel, [...attachmentParts(uploaded), { text: prompt }]);
    if (!weekPlan || typeof weekPlan !== "object" || Array.isArray(weekPlan)) throw new Error("Respuesta inesperada de la IA.");

    let total = 0;
    for (const day of days) {
      const raw = Array.isArray(weekPlan[day.key]) ? weekPlan[day.key] : [];
      const cleaned = sanitizeAiBlocks(raw, day.fixedBlocks, day.manualBlocks, wakeTime, sleepTime);
      state.days[day.key].blocks = [
        ...day.fixedBlocks.map((b) => ({ id: `fixed-${b.id}`, start: b.start, end: b.end, title: b.title, note: "", type: "fijo", source: "fixed", done: false })),
        ...day.manualBlocks,
        ...cleaned,
      ];
      total += cleaned.length;
    }
    saveState();
    renderHoy();
    statusEl.textContent = `Listo ✓ Semana organizada con ${total} bloque(s) nuevos.`;
    document.getElementById("todayContext").value = "";
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    if (uploaded.length) {
      const finalMsg = statusEl.textContent;
      statusEl.textContent = `${finalMsg}\nEliminando archivo(s) de Gemini…`;
      await cleanupAttachments(geminiApiKey, uploaded);
      statusEl.textContent = finalMsg;
    }
    btns.forEach((b) => (b.disabled = false));
    setTimeout(() => { statusEl.textContent = ""; }, 7000);
  }
}

function buildWeekPrompt({ days, wakeTime, sleepTime, preferences, extra, pendingTasks, pendingBooks }) {
  const perDay = days.map((d) => {
    const fixedList = d.fixedBlocks.length ? d.fixedBlocks.map((b) => `    - ${b.start}–${b.end}: ${b.title}`).join("\n") : "    (ninguno)";
    const manualList = d.manualBlocks.length ? d.manualBlocks.map((b) => `    - ${b.start}–${b.end}: ${b.title}`).join("\n") : "    (ninguno)";
    return `${d.key} (${d.dayName}):\n  Fijos:\n${fixedList}\n  Manuales:\n${manualList}`;
  }).join("\n\n");

  const tasksList = pendingTasks.length
    ? pendingTasks.map((t) => `- id:${t.id} | "${t.title}" | prioridad:${t.priority}${t.duration ? ` | duración aprox: ${t.duration} min` : ""}${t.date ? ` | fecha sugerida: ${t.date}` : ""}`).join("\n")
    : "(ninguna)";
  const booksList = pendingBooks.length
    ? pendingBooks.map((b) => `- id:${b.id} | "${b.title}" | páginas restantes: ${b.remaining}${b.daysLeft !== null ? ` | días hasta fecha límite: ${b.daysLeft}` : " | sin fecha límite"}`).join("\n")
    : "(ninguno)";

  const dateKeys = days.map((d) => d.key).join(", ");

  return `Eres un asistente que organiza la semana completa de una persona real de forma realista y equilibrada.

Debes planear estos 7 días: ${dateKeys}. Horario disponible cada día: entre las ${wakeTime} y las ${sleepTime}.

Para cada día, estos son los bloques FIJOS y MANUALES ya reservados (NO los repitas en tu respuesta, solo evita poner algo encima de ellos):

${perDay}

TAREAS pendientes para repartir en los días que tengan espacio libre durante la semana (usa "relacionadoId" con el id exacto):
${tasksList}

LIBROS pendientes de lectura, reparte el tiempo de lectura a lo largo de varios días priorizando los de fecha límite más próxima (usa "relacionadoId" con el id exacto):
${booksList}

Preferencias generales de la persona: ${preferences || "(sin preferencias especiales)"}
Nota especial para esta semana: ${extra || "(ninguna)"}

Instrucciones:
1. Devuelve SOLO un objeto JSON (sin texto adicional, sin markdown) con una clave por cada una de estas fechas (${dateKeys}) y como valor un array de los bloques NUEVOS que propones para ese día.
2. No incluyas los bloques fijos ni los manuales en tu respuesta, solo lo nuevo.
3. No superpongas horarios dentro de un mismo día.
4. Reparte tareas y lecturas de forma realista a lo largo de la semana en vez de amontonarlas en un solo día.
5. Incluye tiempo razonable para comidas y descansos cortos cada día.
6. No llenes cada minuto a la fuerza; deja tiempo libre si no hay suficiente que planear.
7. Cada bloque debe tener este formato exacto:
{"start":"HH:MM","end":"HH:MM","title":"texto corto","type":"tarea|lectura|descanso|comida|otro","note":"texto breve opcional","relacionadoId":"id o null"}

Responde únicamente con el objeto JSON, con esta forma: {"${days[0].key}":[{...}, ...], "${days[1].key}":[...], ...}`;
}

function buildPrompt({ dayName, dateKey, wakeTime, sleepTime, preferences, extra, fixedBlocks, manualBlocks, pendingTasks, pendingBooks }) {
  const fixedList = fixedBlocks.length
    ? fixedBlocks.map((b) => `- ${b.start}–${b.end}: ${b.title}`).join("\n")
    : "(ninguno)";
  const manualList = manualBlocks.length
    ? manualBlocks.map((b) => `- ${b.start}–${b.end}: ${b.title}`).join("\n")
    : "(ninguno)";
  const tasksList = pendingTasks.length
    ? pendingTasks.map((t) => `- id:${t.id} | "${t.title}" | prioridad:${t.priority}${t.duration ? ` | duración aprox: ${t.duration} min` : ""}${t.date && t.date < dateKey ? " | ATRASADA" : ""}`).join("\n")
    : "(ninguna)";
  const booksList = pendingBooks.length
    ? pendingBooks.map((b) => `- id:${b.id} | "${b.title}" | páginas restantes: ${b.remaining}${b.daysLeft !== null ? ` | días hasta fecha límite: ${b.daysLeft} | páginas sugeridas hoy: ${b.suggestedPagesToday}` : " | sin fecha límite"}`).join("\n")
    : "(ninguno)";

  return `Eres un asistente que organiza el día de una persona real de forma realista y equilibrada.

Día a planear: ${dayName} (${dateKey}). Horario disponible: entre las ${wakeTime} y las ${sleepTime}.

BLOQUES FIJOS ya reservados (NO los repitas en tu respuesta, solo evita poner algo encima de ellos):
${fixedList}

BLOQUES MANUALES que la persona ya agregó hoy (tampoco los repitas, solo evita superponerte):
${manualList}

TAREAS pendientes que te gustaría encajar en huecos libres (usa "relacionadoId" con el id exacto cuando uses una de estas):
${tasksList}

LIBROS pendientes de lectura, prioriza los de fecha límite más próxima (usa "relacionadoId" con el id exacto cuando reserves tiempo de lectura):
${booksList}

Preferencias generales de la persona: ${preferences || "(sin preferencias especiales)"}
Nota especial solo para hoy: ${extra || "(ninguna)"}

Instrucciones:
1. Devuelve SOLO un array JSON (sin texto adicional, sin markdown) con los bloques NUEVOS que propones para los huecos libres entre ${wakeTime} y ${sleepTime}.
2. No incluyas los bloques fijos ni los manuales en tu respuesta, solo lo nuevo.
3. No superpongas horarios entre sí ni con los bloques fijos/manuales.
4. Incluye tiempo razonable para comidas y descansos cortos.
5. No llenes cada minuto del día a la fuerza; deja algo de tiempo libre si no hay suficientes tareas/lecturas para llenarlo todo.
6. Cada bloque debe tener este formato exacto:
{"start":"HH:MM","end":"HH:MM","title":"texto corto","type":"tarea|lectura|descanso|comida|otro","note":"texto breve opcional","relacionadoId":"id o null"}

Responde únicamente con el array JSON.`;
}

async function callGeminiJSON(apiKey, model, parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); if (j?.error?.message) msg = j.error.message; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/) || text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("La IA no devolvió un JSON válido.");
    return JSON.parse(match[0]);
  }
}

function sanitizeAiBlocks(aiBlocks, fixedBlocks, manualBlocks, wakeTime, sleepTime) {
  const occupied = [...fixedBlocks, ...manualBlocks].map((b) => [b.start, b.end]);
  const out = [];
  for (const raw of aiBlocks) {
    if (!raw || !raw.start || !raw.end || !raw.title) continue;
    if (timeToMin(raw.end) <= timeToMin(raw.start)) continue;
    if (timeToMin(raw.start) < timeToMin(wakeTime) || timeToMin(raw.end) > timeToMin(sleepTime)) continue;
    const clash = occupied.some(([s, e]) => overlaps(raw.start, raw.end, s, e))
      || out.some((b) => overlaps(raw.start, raw.end, b.start, b.end));
    if (clash) continue;
    out.push({
      id: uid(),
      start: raw.start,
      end: raw.end,
      title: String(raw.title).slice(0, 120),
      note: raw.note ? String(raw.note).slice(0, 200) : "",
      type: raw.type || "otro",
      source: "ai",
      relatedId: raw.relacionadoId || null,
      done: false,
    });
  }
  return out;
}

/* ======================= SEMANA ======================= */
function renderSemana() {
  const container = document.getElementById("weekDays");
  container.innerHTML = [1,2,3,4,5,6,7].map((dow) => {
    const blocks = state.weeklySchedule
      .filter((b) => b.day === dow)
      .sort((a, b) => timeToMin(a.start) - timeToMin(b.start));
    return `
    <div class="week-day">
      <div class="week-day-title">${DOW_NAMES[dow]}</div>
      <div class="week-day-blocks">
        ${blocks.length ? blocks.map((b) => `
          <div class="block type-fixed" data-id="${b.id}">
            <div class="block-check" style="visibility:hidden"></div>
            <div class="block-main">
              <div class="block-time">${b.start} – ${b.end}</div>
              <div class="block-title">${escapeHtml(b.title)}</div>
            </div>
            <div class="block-actions">
              <button data-action="edit-weekly">✏️</button>
              <button data-action="delete-weekly">🗑</button>
            </div>
          </div>`).join("") : `<div class="week-day-empty">Sin bloques</div>`}
      </div>
    </div>`;
  }).join("");
}

document.getElementById("weekDays").addEventListener("click", (e) => {
  const blockEl = e.target.closest(".block");
  if (!blockEl) return;
  const id = blockEl.dataset.id;
  const action = e.target.closest("[data-action]")?.dataset.action;
  const b = state.weeklySchedule.find((x) => x.id === id);
  if (!b) return;
  if (action === "delete-weekly") {
    state.weeklySchedule = state.weeklySchedule.filter((x) => x.id !== id);
    saveState(); renderSemana();
  } else if (action === "edit-weekly") {
    openWeeklySheet(b);
  }
});

document.getElementById("btnAddWeekly").addEventListener("click", () => openWeeklySheet(null));

function openWeeklySheet(existing) {
  const isEdit = !!existing;
  openSheet(`
    <h3>${isEdit ? "Editar bloque fijo" : "Nuevo bloque fijo"}</h3>
    <div class="field">
      <label>Día</label>
      ${chipRowHtml("day", [[1,"Lun"],[2,"Mar"],[3,"Mié"],[4,"Jue"],[5,"Vie"],[6,"Sáb"],[7,"Dom"]], existing?.day || 1)}
    </div>
    <div class="field"><label>Título</label><input type="text" id="f-title" placeholder="Ej: Clase de matemáticas" value="${escapeHtml(existing?.title || "")}"></div>
    <div class="field-row">
      <div class="field"><label>Inicio</label><input type="time" id="f-start" value="${existing?.start || "09:00"}"></div>
      <div class="field"><label>Fin</label><input type="time" id="f-end" value="${existing?.end || "10:00"}"></div>
    </div>
    <div class="sheet-buttons">
      ${isEdit ? `<button class="btn-danger" id="f-delete">Eliminar</button>` : ""}
      <button class="btn-primary" id="f-save">Guardar</button>
    </div>
  `);
  const root = sheetContent;
  wireChipRow(root, "day");
  root.querySelector("#f-save").addEventListener("click", () => {
    const day = Number(chipValue(root, "day"));
    const title = root.querySelector("#f-title").value.trim();
    const start = root.querySelector("#f-start").value;
    const end = root.querySelector("#f-end").value;
    if (!title || !start || !end) { toast("Completa todos los campos"); return; }
    if (timeToMin(end) <= timeToMin(start)) { toast("La hora de fin debe ser después del inicio"); return; }
    if (isEdit) {
      Object.assign(existing, { day, title, start, end });
    } else {
      state.weeklySchedule.push({ id: uid(), day, title, start, end });
    }
    saveState(); closeSheet(); renderSemana();
  });
  if (isEdit) {
    root.querySelector("#f-delete").addEventListener("click", () => {
      state.weeklySchedule = state.weeklySchedule.filter((x) => x.id !== existing.id);
      saveState(); closeSheet(); renderSemana();
    });
  }
}

/* ======================= LIBROS ======================= */
function renderLibros() {
  const list = document.getElementById("booksList");
  const empty = document.getElementById("booksEmpty");
  const books = [...state.books].sort((a, b) => (a.finished === b.finished ? 0 : a.finished ? 1 : -1));
  empty.style.display = books.length ? "none" : "";
  const todayKey = dateKey(new Date());

  list.innerHTML = books.map((b) => {
    const pct = b.totalPages ? Math.min(100, Math.round((b.currentPage / b.totalPages) * 100)) : 0;
    const dLeft = b.deadline ? daysUntil(b.deadline, todayKey) : null;
    let deadlineText = "";
    if (b.deadline) {
      deadlineText = dLeft === null ? "" : dLeft < 0 ? `Venció hace ${-dLeft} día(s)` : dLeft === 0 ? "Vence hoy" : `Faltan ${dLeft} día(s)`;
    }
    return `
    <div class="card" data-id="${b.id}">
      <div class="card-top">
        <div>
          <div class="card-title">${escapeHtml(b.title)}${b.finished ? " ✅" : ""}</div>
          <div class="card-sub">${b.author ? escapeHtml(b.author) + " · " : ""}${b.currentPage}/${b.totalPages} pág.${deadlineText ? " · " + deadlineText : ""}</div>
        </div>
        <div class="card-actions">
          <button data-action="edit-book">✏️</button>
          <button data-action="delete-book">🗑</button>
        </div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span class="priority-tag priority-${b.priority}">${PRIORITY_LABEL[b.priority]}</span>
    </div>`;
  }).join("");
}

document.getElementById("booksList").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const id = card.dataset.id;
  const action = e.target.closest("[data-action]")?.dataset.action;
  const b = state.books.find((x) => x.id === id);
  if (!b) return;
  if (action === "delete-book") {
    state.books = state.books.filter((x) => x.id !== id);
    saveState(); renderLibros();
  } else if (action === "edit-book") {
    openBookSheet(b);
  } else {
    openBookSheet(b);
  }
});

document.getElementById("btnAddBook").addEventListener("click", () => openBookSheet(null));

function openBookSheet(existing) {
  const isEdit = !!existing;
  openSheet(`
    <h3>${isEdit ? "Editar libro" : "Nuevo libro"}</h3>
    <div class="field"><label>Título</label><input type="text" id="f-title" value="${escapeHtml(existing?.title || "")}"></div>
    <div class="field"><label>Autor (opcional)</label><input type="text" id="f-author" value="${escapeHtml(existing?.author || "")}"></div>
    <div class="field-row">
      <div class="field"><label>Página actual</label><input type="number" min="0" id="f-current" value="${existing?.currentPage ?? 0}"></div>
      <div class="field"><label>Total páginas</label><input type="number" min="1" id="f-total" value="${existing?.totalPages ?? ""}"></div>
    </div>
    <div class="field"><label>Fecha límite (opcional)</label><input type="date" id="f-deadline" value="${existing?.deadline || ""}"></div>
    <div class="field">
      <label>Prioridad</label>
      ${chipRowHtml("priority", [["alta","Alta"],["media","Media"],["baja","Baja"]], existing?.priority || "media")}
    </div>
    <div class="sheet-buttons">
      ${isEdit ? `<button class="btn-danger" id="f-delete">Eliminar</button>` : ""}
      <button class="btn-primary" id="f-save">Guardar</button>
    </div>
    ${isEdit ? `<button class="btn-secondary" id="f-finish">${existing.finished ? "Marcar como no terminado" : "Marcar como terminado"}</button>` : ""}
  `);
  const root = sheetContent;
  wireChipRow(root, "priority");
  root.querySelector("#f-save").addEventListener("click", () => {
    const title = root.querySelector("#f-title").value.trim();
    const author = root.querySelector("#f-author").value.trim();
    const currentPage = Number(root.querySelector("#f-current").value || 0);
    const totalPages = Number(root.querySelector("#f-total").value || 0);
    const deadline = root.querySelector("#f-deadline").value || null;
    const priority = chipValue(root, "priority");
    if (!title || !totalPages) { toast("Agrega al menos título y total de páginas"); return; }
    if (isEdit) {
      Object.assign(existing, { title, author, currentPage, totalPages, deadline, priority });
    } else {
      state.books.push({ id: uid(), title, author, currentPage, totalPages, deadline, priority, finished: false });
    }
    saveState(); closeSheet(); renderLibros();
  });
  if (isEdit) {
    root.querySelector("#f-delete").addEventListener("click", () => {
      state.books = state.books.filter((x) => x.id !== existing.id);
      saveState(); closeSheet(); renderLibros();
    });
    root.querySelector("#f-finish").addEventListener("click", () => {
      existing.finished = !existing.finished;
      saveState(); closeSheet(); renderLibros();
    });
  }
}

/* ======================= TAREAS ======================= */
function renderTareas() {
  const list = document.getElementById("tasksList");
  const empty = document.getElementById("tasksEmpty");
  const tasks = [...state.tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  });
  empty.style.display = tasks.length ? "none" : "";

  list.innerHTML = tasks.map((t) => `
    <div class="card" data-id="${t.id}">
      <div class="card-top">
        <div>
          <div class="card-title" style="${t.done ? "text-decoration:line-through;opacity:.6" : ""}">${escapeHtml(t.title)}</div>
          <div class="card-sub">${t.date ? "Para " + t.date : "Sin fecha fija"}${t.duration ? " · ~" + t.duration + " min" : ""}</div>
          ${t.notes ? `<div class="card-sub">${escapeHtml(t.notes)}</div>` : ""}
        </div>
        <div class="card-actions">
          <button data-action="toggle-task">${t.done ? "↩️" : "✅"}</button>
          <button data-action="edit-task">✏️</button>
          <button data-action="delete-task">🗑</button>
        </div>
      </div>
      <span class="priority-tag priority-${t.priority}">${PRIORITY_LABEL[t.priority]}</span>
    </div>`).join("");
}

document.getElementById("tasksList").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const id = card.dataset.id;
  const action = e.target.closest("[data-action]")?.dataset.action;
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  if (action === "delete-task") {
    state.tasks = state.tasks.filter((x) => x.id !== id);
    saveState(); renderTareas();
  } else if (action === "toggle-task") {
    t.done = !t.done;
    saveState(); renderTareas();
  } else if (action === "edit-task") {
    openTaskSheet(t);
  }
});

document.getElementById("btnAddTask").addEventListener("click", () => openTaskSheet(null));

function openTaskSheet(existing) {
  const isEdit = !!existing;
  openSheet(`
    <h3>${isEdit ? "Editar tarea" : "Nueva tarea"}</h3>
    <div class="field"><label>Título</label><input type="text" id="f-title" value="${escapeHtml(existing?.title || "")}"></div>
    <div class="field-row">
      <div class="field"><label>Fecha (opcional)</label><input type="date" id="f-date" value="${existing?.date || ""}"></div>
      <div class="field"><label>Duración aprox. (min)</label><input type="number" min="0" id="f-duration" value="${existing?.duration ?? ""}"></div>
    </div>
    <div class="field">
      <label>Prioridad</label>
      ${chipRowHtml("priority", [["alta","Alta"],["media","Media"],["baja","Baja"]], existing?.priority || "media")}
    </div>
    <div class="field"><label>Notas (opcional)</label><input type="text" id="f-notes" value="${escapeHtml(existing?.notes || "")}"></div>
    <div class="sheet-buttons">
      ${isEdit ? `<button class="btn-danger" id="f-delete">Eliminar</button>` : ""}
      <button class="btn-primary" id="f-save">Guardar</button>
    </div>
  `);
  const root = sheetContent;
  wireChipRow(root, "priority");
  root.querySelector("#f-save").addEventListener("click", () => {
    const title = root.querySelector("#f-title").value.trim();
    const date = root.querySelector("#f-date").value || null;
    const duration = root.querySelector("#f-duration").value ? Number(root.querySelector("#f-duration").value) : null;
    const priority = chipValue(root, "priority");
    const notes = root.querySelector("#f-notes").value.trim();
    if (!title) { toast("Agrega un título"); return; }
    if (isEdit) {
      Object.assign(existing, { title, date, duration, priority, notes });
    } else {
      state.tasks.push({ id: uid(), title, date, duration, priority, notes, done: false });
    }
    saveState(); closeSheet(); renderTareas();
  });
  if (isEdit) {
    root.querySelector("#f-delete").addEventListener("click", () => {
      state.tasks = state.tasks.filter((x) => x.id !== existing.id);
      saveState(); closeSheet(); renderTareas();
    });
  }
}

/* ======================= AJUSTES ======================= */
function renderAjustes() {
  document.getElementById("setApiKey").value = state.settings.geminiApiKey;
  document.getElementById("setModel").value = state.settings.geminiModel;
  document.getElementById("setWake").value = state.settings.wakeTime;
  document.getElementById("setSleep").value = state.settings.sleepTime;
  document.getElementById("setPrefs").value = state.settings.preferences;
}

document.getElementById("btnToggleKey").addEventListener("click", () => {
  const el = document.getElementById("setApiKey");
  el.type = el.type === "password" ? "text" : "password";
});

document.getElementById("btnSaveSettings").addEventListener("click", () => {
  state.settings.geminiApiKey = document.getElementById("setApiKey").value.trim();
  state.settings.geminiModel = document.getElementById("setModel").value;
  state.settings.wakeTime = document.getElementById("setWake").value || "07:00";
  state.settings.sleepTime = document.getElementById("setSleep").value || "23:00";
  state.settings.preferences = document.getElementById("setPrefs").value.trim();
  saveState();
  toast("Ajustes guardados ✓");
});

document.getElementById("btnExport").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `calendario-ia-backup-${dateKey(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("btnImport").addEventListener("click", () => {
  document.getElementById("importFile").click();
});
document.getElementById("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed.settings || !parsed.weeklySchedule) throw new Error("Archivo inválido");
    state = {
      settings: { ...DEFAULT_STATE.settings, ...parsed.settings },
      weeklySchedule: parsed.weeklySchedule || [],
      books: parsed.books || [],
      tasks: parsed.tasks || [],
      days: parsed.days || {},
    };
    saveState();
    renderAll();
    toast("Copia de seguridad importada ✓");
  } catch (err) {
    toast("No se pudo importar el archivo");
  } finally {
    e.target.value = "";
  }
});

document.getElementById("btnReset").addEventListener("click", () => {
  if (!confirm("¿Borrar todos los datos de la app? Esto no se puede deshacer.")) return;
  state = structuredClone(DEFAULT_STATE);
  saveState();
  renderAll();
  toast("Datos borrados");
});

/* ======================= INIT ======================= */
switchView("hoy");

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.error("SW error", err));
  });
}
