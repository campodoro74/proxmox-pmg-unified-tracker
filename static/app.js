const $ = (id) => document.getElementById(id);

const state = {
  offset: 0,
  limit: 200,
  total: 0,
  lastQuery: null,
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
    tr.innerHTML = `
      <td>${escapeHtml(fmtTime(row.time))}</td>
      <td><code>${escapeHtml(row.node || "")}</code></td>
      <td>${escapeHtml(row.from || "")}</td>
      <td>${escapeHtml(row.to || "")}</td>
      <td>${statusPill(row.status || row.dstatus || row.rstatus)}</td>
      <td><code>${escapeHtml(row.dstatus || "")}</code></td>
      <td><code>${escapeHtml(row.rstatus || "")}</code></td>
      <td class="num">${escapeHtml(fmtBytes(row.size))}</td>
      <td><code>${escapeHtml(row.msgid || "")}</code></td>
      <td><code>${escapeHtml(row.qid || "")}</code></td>
      <td><code>${escapeHtml(row.relay || "")}</code></td>
      <td><code>${escapeHtml(row.client || "")}</code></td>
    `;

    tr.addEventListener("click", () => openDetail(row, queryParams));
    tbody.appendChild(tr);
  }
}

function openDrawer() {
  $("detailDrawer").setAttribute("aria-hidden", "false");
  $("backdrop").hidden = false;
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

  setMeta(`Showing ${Math.min(state.limit, (payload.rows || []).length)} of ${state.total} messages`);
  setPager();
  renderErrors(payload.errors);

  // Keep a stable base query for detail calls (start/end/from/target/xfilter/greylist/ndr).
  const detailParams = new URLSearchParams(query);
  detailParams.delete("offset");
  detailParams.delete("limit");
  renderRows(payload.rows, detailParams);
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

function setLast30m() {
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 60 * 1000);
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

setLast30m();
wireEvents();
refreshHealth();
doSearch().catch(() => {});
