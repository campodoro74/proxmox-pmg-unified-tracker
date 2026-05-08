const $ = (id) => document.getElementById(id);

const state = {
  offset: 0,
  limit: 200,
  total: 0,
  lastQuery: null,
  autoRefreshTimer: null,
  autoRefreshCountdownTimer: null,
  nextRefreshAtMs: null,
  sortKey: "time",
  sortDir: "desc",
  lastRows: [],
};

const STORAGE_KEYS = {
  autoRefreshEnabled: "pmgTracker:autoRefreshEnabled",
  autoRefreshMinutes: "pmgTracker:autoRefreshMinutes",
  simpleModeEnabled: "pmgTracker:simpleModeEnabled",
  hideSearchEnabled: "pmgTracker:hideSearchEnabled",
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toLocalInputValue(d) {
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function toEpochSecondsFromLocalInput(value) {
  // value is "YYYY-MM-DDTHH:mm" in local timezone.
  const d = new Date(value);
  return Math.floor(d.getTime() / 1000);
}

function fmtTime(epochSeconds) {
  if (!epochSeconds) return "";
  const d = new Date(epochSeconds * 1000);
  return d.toLocaleString();
}

function fmtBytes(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return "";
  const b = Number(bytes);
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const fixed = i === 0 ? 0 : v < 10 ? 2 : 1;
  return `${v.toFixed(fixed)} ${units[i]}`;
}

function statusPill(status) {
  const s = (status || "").toLowerCase();
  let cls = "pill--muted";
  if (s.includes("accepted") || s === "a") cls = "pill--ok";
  else if (s.includes("relayed") || s === "2") cls = "pill--ok";
  else if (s.includes("deferred") || s === "d" || s === "4" || s.includes("grey")) cls = "pill--warn";
  else if (s.includes("reject") || s.includes("block") || s.includes("unknown") || s === "r" || s === "b" || s === "n" || s === "5") cls = "pill--bad";
  return `<span class="pill ${cls}"><span class="dot"></span><span>${escapeHtml(status || "unknown")}</span></span>`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildQueryFromForm() {
  const form = $("searchForm");
  const data = new FormData(form);

  const start = data.get("start");
  const end = data.get("end");
  if (!start || !end) throw new Error("Start and End are required.");

  const query = new URLSearchParams();
  query.set("starttime", String(toEpochSecondsFromLocalInput(String(start))));
  query.set("endtime", String(toEpochSecondsFromLocalInput(String(end))));
  query.set("offset", String(state.offset));
  query.set("limit", String(state.limit));

  const from = String(data.get("from") || "").trim();
  const target = String(data.get("target") || "").trim();
  const xfilter = String(data.get("xfilter") || "").trim();
  if (from) query.set("from", from);
  if (target) query.set("target", target);
  if (xfilter) query.set("xfilter", xfilter);

  query.set("greylist", data.get("greylist") ? "true" : "false");
  query.set("ndr", data.get("ndr") ? "true" : "false");
  query.set("errors_only", data.get("errors_only") ? "true" : "false");

  const statuses = data.getAll("status").map((s) => String(s).trim()).filter(Boolean);
  for (const s of statuses) {
    query.append("status", s);
  }

  const nodes = data.getAll("node").map((s) => String(s).trim()).filter(Boolean);
  for (const n of nodes) {
    query.append("node", n);
  }

  const client = String(data.get("client") || "").trim();
  const qid = String(data.get("qid") || "").trim();
  const msgid = String(data.get("msgid") || "").trim();
  const minSize = String(data.get("min_size") || "").trim();
  const maxSize = String(data.get("max_size") || "").trim();
  if (client) query.set("client", client);
  if (qid) query.set("qid", qid);
  if (msgid) query.set("msgid", msgid);
  if (minSize) query.set("min_size", minSize);
  if (maxSize) query.set("max_size", maxSize);
  return query;
}

async function apiGet(path) {
  const res = await fetch(path, { headers: { "Accept": "application/json" } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = payload?.detail || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return payload;
}

function setMeta(text) {
  $("resultMeta").textContent = text;
}

function setPager() {
  const page = Math.floor(state.offset / state.limit) + 1;
  const pages = state.total ? Math.ceil(state.total / state.limit) : 0;
  $("pageInfo").textContent = `${page} / ${pages}`;
  $("prevPage").disabled = state.offset <= 0;
  $("nextPage").disabled = state.offset + state.limit >= state.total;
}

function renderErrors(errors) {
  const el = $("nodeErrors");
  if (!errors || errors.length === 0) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = `<strong>Some nodes failed:</strong><br />` +
    errors.map((e) => `<div><code>${escapeHtml(e.node)}</code>: ${escapeHtml(e.error)}</div>`).join("");
}

function renderRows(rows, queryParams) {
  const tbody = $("resultsBody");
  tbody.innerHTML = "";

  for (const row of rows || []) {
    const tr = document.createElement("tr");
    const status = String(row.status || row.dstatus || row.rstatus || "").toLowerCase();
    const isError = status && !status.includes("accepted") && !status.includes("relayed");
    if (isError) tr.classList.add("is-error");
    tr.innerHTML = `
      <td>${escapeHtml(fmtTime(row.time))}</td>
      <td><code>${escapeHtml(row.node || "")}</code></td>
      <td>${escapeHtml(row.from || "")}</td>
      <td>${escapeHtml(row.to || "")}</td>
      <td>${statusPill(row.status || row.dstatus || row.rstatus)}</td>
      <td class="advanced-col"><code>${escapeHtml(row.dstatus || "")}</code></td>
      <td class="advanced-col"><code>${escapeHtml(row.rstatus || "")}</code></td>
      <td class="num">${escapeHtml(fmtBytes(row.size))}</td>
      <td><code>${escapeHtml(row.msgid || "")}</code></td>
      <td class="advanced-col"><code>${escapeHtml(row.qid || "")}</code></td>
      <td class="advanced-col"><code>${escapeHtml(row.relay || "")}</code></td>
      <td class="advanced-col"><code>${escapeHtml(row.client || "")}</code></td>
    `;

    tr.addEventListener("click", () => openDetail(row, queryParams));
    tbody.appendChild(tr);
  }
}

function sortedRows(rows) {
  const key = state.sortKey || "time";
  const dir = state.sortDir === "asc" ? 1 : -1;

  const get = (row) => {
    if (key === "time" || key === "size") return Number(row?.[key] ?? 0);
    if (key === "status") return String(row?.status || row?.dstatus || row?.rstatus || "").toLowerCase();
    return String(row?.[key] ?? "").toLowerCase();
  };

  const out = [...(rows || [])];
  out.sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    if (typeof av === "number" && typeof bv === "number") {
      if (av !== bv) return (av - bv) * dir;
    } else {
      const c = String(av).localeCompare(String(bv));
      if (c !== 0) return c * dir;
    }
    // tie-breaker: latest first
    return (Number(b?.time ?? 0) - Number(a?.time ?? 0));
  });
  return out;
}

function wireSorting() {
  const table = $("resultsTable");
  if (!table) return;
  const thead = table.querySelector("thead");
  if (!thead) return;

  thead.addEventListener("click", (e) => {
    const th = e.target?.closest?.("th");
    const key = th?.getAttribute?.("data-sort");
    if (!key) return;

    if (state.sortKey === key) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDir = key === "time" ? "desc" : "asc";
    }

    if (state.lastRows?.length) {
      const queryParams = state.lastQuery ? new URLSearchParams(state.lastQuery) : new URLSearchParams();
      queryParams.delete("offset");
      queryParams.delete("limit");
      renderRows(sortedRows(state.lastRows), queryParams);
    }
  });
}

function openDrawer() {
  $("detailDrawer").setAttribute("aria-hidden", "false");
  $("backdrop").hidden = true;
}

function closeDrawer() {
  $("detailDrawer").setAttribute("aria-hidden", "true");
  $("backdrop").hidden = true;
  $("detailLogs").textContent = "";
  $("detailKv").innerHTML = "";
}

function kvRow(k, v) {
  return `<div class="kv__k">${escapeHtml(k)}</div><div class="kv__v">${escapeHtml(v)}</div>`;
}

function encodeMailId(id) {
  // URL-safe base64 (best effort). Backend accepts raw too.
  try {
    return btoa(String(id)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  } catch {
    return encodeURIComponent(String(id));
  }
}

async function openDetail(row, queryParams) {
  $("detailTitle").textContent = `Message detail (${row.node})`;
  $("detailKv").innerHTML =
    kvRow("time", fmtTime(row.time)) +
    kvRow("node", row.node || "") +
    kvRow("from", row.from || "") +
    kvRow("to", row.to || "") +
    kvRow("status", row.status || row.dstatus || row.rstatus || "") +
    kvRow("dstatus", row.dstatus || "") +
    kvRow("rstatus", row.rstatus || "") +
    kvRow("size", fmtBytes(row.size)) +
    kvRow("msgid", row.msgid || "") +
    kvRow("qid", row.qid || "") +
    kvRow("relay", row.relay || "") +
    kvRow("client", row.client || "");
  $("detailLogs").textContent = "Loading…";
  openDrawer();

  const qp = new URLSearchParams(queryParams);
  // Ensure the same start/end are used for detail query.
  const url = `/api/detail/${encodeURIComponent(row.node)}/${encodeURIComponent(encodeMailId(row.id))}?${qp.toString()}`;
  try {
    const payload = await apiGet(url);
    const logs = payload?.logs || [];
    $("detailLogs").textContent = Array.isArray(logs) ? logs.join("\n") : String(logs);
  } catch (err) {
    $("detailLogs").textContent = `Failed to load detail: ${err?.message || err}`;
  }
}

async function doSearch() {
  const query = buildQueryFromForm();
  state.lastQuery = query;

  setMeta("Searching…");
  $("resultsBody").innerHTML = "";
  renderErrors([]);
  setPager();

  const payload = await apiGet(`/api/search?${query.toString()}`);
  state.total = payload.total || 0;
  state.lastRows = payload.rows || [];

  setMeta(`Showing ${Math.min(state.limit, (payload.rows || []).length)} of ${state.total} messages`);
  setPager();
  renderErrors(payload.errors);

  // Keep a stable base query for detail calls (start/end/from/target/xfilter/greylist/ndr).
  const detailParams = new URLSearchParams(query);
  detailParams.delete("offset");
  detailParams.delete("limit");
  renderRows(sortedRows(payload.rows || []), detailParams);
}

async function refreshHealth() {
  try {
    const payload = await apiGet("/api/health");
    const nodes = (payload.nodes || []).join(", ");
    $("healthStatus").textContent = payload.ok ? `OK (${nodes})` : "Not OK";
    renderNodeFilters(payload.nodes || []);
  } catch {
    $("healthStatus").textContent = "API unreachable";
  }
}

function renderNodeFilters(nodes) {
  const wrap = $("nodeFilters");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (const node of nodes) {
    const label = document.createElement("label");
    label.className = "check";
    label.innerHTML = `<input type="checkbox" name="node" value="${escapeHtml(node)}" /> <span>${escapeHtml(node)}</span>`;
    wrap.appendChild(label);
  }
}

function setLast24h() {
  const now = new Date();
  const start = new Date(now.getTime() - 24 * 3600 * 1000);
  document.querySelector('input[name="start"]').value = toLocalInputValue(start);
  document.querySelector('input[name="end"]').value = toLocalInputValue(now);
}

function setLastHour() {
  const now = new Date();
  const start = new Date(now.getTime() - 60 * 60 * 1000);
  document.querySelector('input[name="start"]').value = toLocalInputValue(start);
  document.querySelector('input[name="end"]').value = toLocalInputValue(now);
}

function setLast30m() {
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 60 * 1000);
  document.querySelector('input[name="start"]').value = toLocalInputValue(start);
  document.querySelector('input[name="end"]').value = toLocalInputValue(now);
}

function setToday() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  document.querySelector('input[name="start"]').value = toLocalInputValue(start);
  document.querySelector('input[name="end"]').value = toLocalInputValue(now);
}

function clearForm() {
  $("searchForm").reset();
  setLast24h();
  state.offset = 0;
  state.total = 0;
  state.lastQuery = null;
  $("resultsBody").innerHTML = "";
  renderErrors([]);
  setMeta("No results.");
  $("pageInfo").textContent = "0 / 0";
}

function wireEvents() {
  $("btnRefreshPage")?.addEventListener("click", () => {
    window.location.reload();
  });

  $("searchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    state.offset = 0;
    try {
      await doSearch();
    } catch (err) {
      setMeta(`Search failed: ${err?.message || err}`);
    }
  });

  $("btnNow24h").addEventListener("click", () => {
    setLast24h();
    state.offset = 0;
    doSearch().catch(() => {});
  });
  $("btnLastHour")?.addEventListener("click", () => {
    setLastHour();
    state.offset = 0;
    doSearch().catch(() => {});
  });
  $("btnToday")?.addEventListener("click", () => {
    setToday();
    state.offset = 0;
    doSearch().catch(() => {});
  });
  $("btnClear").addEventListener("click", () => clearForm());

  $("prevPage").addEventListener("click", async () => {
    if (!state.lastQuery) return;
    state.offset = Math.max(0, state.offset - state.limit);
    await doSearch().catch(() => {});
  });
  $("nextPage").addEventListener("click", async () => {
    if (!state.lastQuery) return;
    state.offset = state.offset + state.limit;
    await doSearch().catch(() => {});
  });

  $("closeDrawer").addEventListener("click", closeDrawer);
  $("backdrop").addEventListener("click", closeDrawer);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });
}

function setSimpleMode(enabled) {
  document.body.classList.toggle("simple-mode", Boolean(enabled));
  try {
    localStorage.setItem(STORAGE_KEYS.simpleModeEnabled, enabled ? "1" : "0");
  } catch {}
}

function setHideSearch(enabled) {
  const card = $("searchCard");
  if (card) card.hidden = Boolean(enabled);
  try {
    localStorage.setItem(STORAGE_KEYS.hideSearchEnabled, enabled ? "1" : "0");
  } catch {}
}

function setAutoRefresh(enabled, minutes) {
  if (state.autoRefreshTimer) {
    clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
  if (state.autoRefreshCountdownTimer) {
    clearInterval(state.autoRefreshCountdownTimer);
    state.autoRefreshCountdownTimer = null;
  }
  state.nextRefreshAtMs = null;

  const mins = Math.max(1, Number(minutes || 5));
  if (enabled) {
    state.nextRefreshAtMs = Date.now() + mins * 60 * 1000;
    state.autoRefreshTimer = setInterval(() => {
      doSearch().catch(() => {});
      state.nextRefreshAtMs = Date.now() + mins * 60 * 1000;
    }, mins * 60 * 1000);

    const countdownEl = $("autoRefreshCountdown");
    if (countdownEl) {
      countdownEl.hidden = false;
      const tick = () => {
        if (!state.nextRefreshAtMs) return;
        const remaining = Math.max(0, state.nextRefreshAtMs - Date.now());
        const totalSeconds = Math.ceil(remaining / 1000);
        const mm = Math.floor(totalSeconds / 60);
        const ss = totalSeconds % 60;
        countdownEl.textContent = `Next refresh in ${mm}:${String(ss).padStart(2, "0")}`;
      };
      tick();
      state.autoRefreshCountdownTimer = setInterval(tick, 1000);
    }
  } else {
    const countdownEl = $("autoRefreshCountdown");
    if (countdownEl) countdownEl.hidden = true;
  }

  try {
    localStorage.setItem(STORAGE_KEYS.autoRefreshEnabled, enabled ? "1" : "0");
    localStorage.setItem(STORAGE_KEYS.autoRefreshMinutes, String(mins));
  } catch {}
}

function initPreferences() {
  const autoEnabledEl = $("autoRefreshEnabled");
  const autoMinutesEl = $("autoRefreshMinutes");
  const simpleEl = $("simpleModeEnabled");
  const hideSearchEl = $("hideSearchEnabled");

  let autoEnabled = false;
  let autoMinutes = 5;
  let simpleEnabled = false;
  let hideSearchEnabled = false;
  try {
    autoEnabled = localStorage.getItem(STORAGE_KEYS.autoRefreshEnabled) === "1";
    const storedMins = Number(localStorage.getItem(STORAGE_KEYS.autoRefreshMinutes) || "5");
    autoMinutes = Number.isFinite(storedMins) && storedMins > 0 ? storedMins : 5;
    const storedSimple = localStorage.getItem(STORAGE_KEYS.simpleModeEnabled);
    simpleEnabled = storedSimple === null ? true : storedSimple === "1";
    hideSearchEnabled = localStorage.getItem(STORAGE_KEYS.hideSearchEnabled) === "1";
  } catch {}

  if (autoEnabledEl) autoEnabledEl.checked = autoEnabled;
  if (autoMinutesEl) autoMinutesEl.value = String(autoMinutes);
  if (simpleEl) simpleEl.checked = simpleEnabled;
  if (hideSearchEl) hideSearchEl.checked = hideSearchEnabled;

  setSimpleMode(simpleEnabled);
  setHideSearch(hideSearchEnabled);
  setAutoRefresh(autoEnabled, autoMinutes);

  autoEnabledEl?.addEventListener("change", () => {
    setAutoRefresh(Boolean(autoEnabledEl.checked), autoMinutesEl?.value || "5");
  });
  autoMinutesEl?.addEventListener("change", () => {
    setAutoRefresh(Boolean(autoEnabledEl?.checked), autoMinutesEl.value || "5");
  });
  simpleEl?.addEventListener("change", () => setSimpleMode(Boolean(simpleEl.checked)));
  hideSearchEl?.addEventListener("change", () => setHideSearch(Boolean(hideSearchEl.checked)));
}

setLast30m();
wireEvents();
initPreferences();
wireSorting();
refreshHealth();
doSearch().catch(() => {});
