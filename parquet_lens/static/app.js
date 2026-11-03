"use strict";

const { t } = window.I18n;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
const number = (value) =>
  new Intl.NumberFormat(I18n.language === "en" ? "en-US" : "zh-CN").format(
    value,
  );
function bytes(value) {
  if (!value) return "0 B";
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}
const icons = {
  plus: "M12 5v14M5 12h14",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5",
  grid: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18",
  schema:
    "M12 3v6M5 15v-4h14v4M3 15h4v5H3zM10 15h4v5h-4zM17 15h4v5h-4zM10 3h4v4h-4z",
  layers: "m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5",
  info: "M12 11v6M12 7h.01",
  filter: "M4 4h16l-6 7v8l-4 2V11z",
  columns: "M3 4h18v16H3zM9 4v16M15 4v16",
  download: "M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6",
  refresh: "M20 7v5h-5M4 17v-5h5M6.1 6a8 8 0 0 1 13.3 3M4.6 15A8 8 0 0 0 18 18",
  shield: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7zM8 12l3 3 5-6",
  bolt: "m13 2-9 12h7l-1 8L21 9h-8z",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  moon: "M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13",
  chevron: "m9 5 7 7-7 7",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  check: "m5 12 4 4L19 6",
  clock: "M12 7v5l3 2",
  close: "M6 6l12 12M6 18 18 6",
};
function icon(name, size = 16) {
  const circle = ["info", "clock"].includes(name)
    ? '<circle cx="12" cy="12" r="9"/>'
    : "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${circle}<path d="${icons[name] || icons.file}"/></svg>`;
}

const state = {
  files: [],
  file: null,
  tab: "data",
  page: null,
  offset: 0,
  limit: 100,
  columns: [],
  filters: [],
  sort: null,
  direction: "asc",
  loading: false,
  error: "",
  groupsOffset: 0,
  statsOffset: 0,
  schemaIndex: 0,
  controller: null,
  epoch: 0,
  viewEpoch: 0,
  config: {},
  selectedColumns: new Set(),
  filterDraft: [],
  upload: null,
  rowIndex: null,
};
let toastTimer;
function toast(message) {
  $("#toast").textContent = t(message);
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 4500);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Accept-Language": I18n.language,
      ...options.headers,
    },
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(t("服务响应异常，请确认服务仍在运行。"));
  }
  if (!response.ok) {
    const detail = result.detail;
    throw new Error(
      typeof detail === "string" ? detail : t("请求参数无效，请检查后重试。"),
    );
  }
  return result;
}
const post = (path, body, options = {}) =>
  api(path, { method: "POST", body: JSON.stringify(body), ...options });

function render() {
  $("#app").innerHTML = `<div class="app-shell"><aside class="sidebar">
    <div class="brand"><img src="/favicon.svg" alt=""><div><strong>Parquet Lens</strong><span>SEE DATA CLEARLY</span></div></div>
    <button class="button primary open-button" data-action="open">${icon("plus")} ${t("打开文件")} <span class="shortcut">⌘ / Ctrl O</span></button>
    <div class="sidebar-label">${t("工作区")} <span>${state.files.length.toString().padStart(2, "0")}</span></div>
    <div class="file-list">${state.files.length ? state.files.map((file) => `<div class="file-item ${file.id === state.file?.id ? "active" : ""}"><button class="file-select" data-action="select-file" data-id="${file.id}" title="${escapeHTML(file.name)}"><span class="file-icon">${icon("file", 19)}</span><span class="file-name-wrap"><span class="file-name">${escapeHTML(file.name)}</span><span class="file-sub">${bytes(file.size)} <span>·</span> ${number(file.rows)} ${t("行")}</span></span></button><button class="icon-button file-close" data-action="close-file" data-id="${file.id}" aria-label="${t("关闭")} ${escapeHTML(file.name)}">×</button></div>`).join("") : `<p class="sidebar-empty">${t("还没有打开的文件")}<br>${t("从一份 Parquet 开始探索。")}</p>`}</div>
    <div class="sidebar-tip"><div>${icon("bolt", 14)} ${t("为大文件而设计")}</div><p>${t("先看结构，再按需读取。")}<br>${t("只加载你正在浏览的数据。")}</p></div>
    <div class="sidebar-bottom"><span class="status-dot"></span> ${t("本地服务 · 隐私优先")} <button class="icon-button" data-action="theme" aria-label="${t("切换明暗主题")}">${icon("moon", 14)}</button></div>
  </aside><section class="workspace"><header class="topbar"><div class="breadcrumbs">${icon("layers", 15)}<span>${t("工作区")}</span><span>/</span><strong>${escapeHTML(state.file?.name || t("数据探索"))}</strong></div>
    <div class="mobile-files"><img src="/favicon.svg" width="24" height="24" alt="Parquet Lens"><select id="mobile-file" aria-label="${t("切换文件")}"><option value="">${t("工作区")}</option>${state.files.map((f) => `<option value="${f.id}" ${f.id === state.file?.id ? "selected" : ""}>${escapeHTML(f.name)}</option>`).join("")}</select><button class="icon-button" data-action="open" aria-label="${t("打开文件")}">${icon("plus")}</button><button class="icon-button" data-action="theme" aria-label="${t("切换明暗主题")}">${icon("moon", 14)}</button>${state.file ? `<button class="icon-button" data-action="close-file" data-id="${state.file.id}" aria-label="${t("关闭当前文件")}">×</button>` : ""}</div>
    <div class="topbar-right">${icon("shield", 13)} ${t("你的数据，由你掌控")} <span class="version">v0.1.0</span></div><button class="button language-button" data-action="language" aria-label="${I18n.language === "zh" ? t("切换为英文") : t("切换为中文")}" title="中文 / English">${I18n.language === "zh" ? "English" : "中文"}</button></header>
    ${state.file ? fileView() : welcomeView()}
    <footer class="app-footer"><span class="footer-left"><span class="status-dot"></span> ${state.file ? t("只读浏览 · 原始文件不会被修改") : t("本地优先 · 跨平台 · 无外部网页资源")}</span><span>${state.file ? t("点击一行查看详情") : t("把复杂的数据，变得清晰。")}</span></footer>
  </section></div>`;
  document.title = state.file
    ? `${state.file.name} · Parquet Lens`
    : t("Parquet Lens · 看清每一层数据");
  if (state.file) renderTab();
}

function welcomeView() {
  return `<div class="content-empty"><div class="welcome"><div class="welcome-kicker"><span class="status-dot"></span> A CLEARER VIEW OF YOUR DATA</div><h1>${t("看清每一层，")}<br>${t("读懂")}<em>${t("每一份数据。")}</em></h1><p>${t("从文件结构到具体内容，让 Parquet 不再是黑盒。")}<br>${t("轻松打开，按需浏览，大文件也能从容探索。")}</p><div class="welcome-actions"><button class="button primary" data-action="open">${icon("plus")} ${t("打开 Parquet 文件")}</button><button class="button" data-action="demo">${t("探索示例数据")} ${icon("arrow", 14)}</button></div><div class="welcome-art" aria-hidden="true"><div class="art-sheet"><div class="art-title">${icon("file", 13)} your_next_discovery.parquet</div><div class="art-grid">${"<i></i>".repeat(25)}</div></div><div class="art-badge">${icon("check", 13)} ${t("只读取你需要的部分")}</div></div><div class="feature-grid"><div>${icon("schema", 20)}<h3>${t("结构，一目了然")}</h3><p>${t("字段类型、嵌套层级与空值属性，清晰呈现。")}</p></div><div>${icon("bolt", 20)}<h3>${t("大文件，按需加载")}</h3><p>${t("行组定位与分页读取，让内存留给真正有用的数据。")}</p></div><div>${icon("shield", 20)}<h3>${t("本地优先，多端访问")}</h3><p>${t("电脑本地运行，浏览器即开即用，支持可信局域网访问。")}</p></div></div></div></div>`;
}
function metric(label, value, unit, caption, symbol) {
  return `<div class="metric"><div class="metric-label">${label}${icon(symbol, 14)}</div><div class="metric-value">${value}<span class="unit">${unit}</span></div><div class="metric-caption">${caption}</div></div>`;
}
function fileView() {
  const f = state.file;
  const size = bytes(f.size).split(" ");
  return `<main class="main-content"><div class="file-heading"><div class="file-title"><div class="title-icon">${icon("file", 22)}</div><div><span class="eyebrow">PARQUET EXPLORER</span><h1 title="${escapeHTML(f.name)}">${escapeHTML(f.name)}</h1><p>${f.source === "upload" ? t("设备上传") : t("本机读取")} <span>·</span> Apache Parquet <span>·</span> <span class="mono">${escapeHTML(f.compression.join(" / ") || t("未压缩"))}</span></p></div></div><div class="heading-actions"><button class="button" data-action="refresh" title="${t("重新读取当前页")}">${icon("refresh", 14)}<span>${t("刷新")}</span></button><button class="button" data-action="export" ${!state.page?.rows.length || state.loading ? "disabled" : ""}>${icon("download", 14)}<span>${t("导出当前页")}</span></button></div></div>
    <div class="metric-grid">${metric(t("总行数"), number(f.rows), t("行"), t("来自文件元数据"), "grid")}${metric(t("字段数量"), number(f.columns), t("列"), t("包含嵌套类型"), "columns")}${metric(t("文件大小"), size[0], size[1], t("磁盘存储大小"), "file")}${metric(t("行组数量"), number(f.row_groups), t("组"), t("独立的数据读取单元"), "layers")}</div>
    <nav class="tabs" aria-label="${t("文件视图")}">${[
      ["data", "grid", t("数据预览"), null],
      ["schema", "schema", t("文件结构"), f.columns],
      ["groups", "layers", t("行组"), f.row_groups],
      ["metadata", "info", t("元数据"), null],
    ]
      .map(
        ([id, symbol, label, count]) =>
          `<button class="tab ${state.tab === id ? "active" : ""}" data-action="tab" data-tab="${id}" aria-current="${state.tab === id ? "page" : "false"}">${icon(symbol, 15)}${label}${count !== null ? `<span class="count">${count}</span>` : ""}</button>`,
      )
      .join(
        "",
      )}<span class="tabs-note">${icon("bolt", 11)} ${t("按需读取，轻量浏览")}</span></nav><div id="view" class="view"></div></main>`;
}

function renderTab() {
  if (!state.file) return;
  if (state.tab === "data") renderData();
  else if (state.tab === "schema") renderSchema();
  else if (state.tab === "groups") renderGroups();
  else renderMetadata();
}
const ops = {
  eq: "等于",
  neq: "不等于",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
  contains: "包含文本",
  is_null: "为空",
  not_null: "不为空",
};
function renderData() {
  const p = state.page;
  const queried = state.filters.length || state.sort;
  $("#view").innerHTML =
    `<div class="data-toolbar"><div class="toolbar-group"><button class="button" data-action="filters">${icon("filter", 14)}${t("筛选")}${state.filters.length ? `<span class="filter-count">${state.filters.length}</span>` : ""}</button><button class="button" data-action="columns">${icon("columns", 14)}${t("字段")} <span class="muted">${state.columns.length} / ${state.file.columns}</span></button>${queried ? `<button class="text-button" data-action="clear-query">${t("重置")}</button>` : ""}</div><div class="toolbar-note">${queried ? t("筛选 / 排序可能扫描文件 · 受资源限制保护") : t("行组定位读取 · 双击单元格也可查看详情")}</div></div>
    ${queried ? `<div class="chips">${state.filters.map((f, i) => `<span class="chip" title="${escapeHTML(f.value)}">${escapeHTML(f.column)} ${t(ops[f.op])} ${["is_null", "not_null"].includes(f.op) ? "" : escapeHTML(f.value.slice(0, 35))}<button data-action="remove-filter" data-index="${i}" aria-label="${t("移除此筛选")}">×</button></span>`).join("")}${state.sort ? `<span class="chip">${escapeHTML(state.sort)} ${state.direction === "asc" ? t("升序 ↑") : t("降序 ↓")}<button data-action="clear-sort" aria-label="${t("取消排序")}">×</button></span>` : ""}</div>` : ""}
    <div class="table-frame" aria-busy="${state.loading}">${state.loading ? `<div class="loading-layer"><span class="spinner"></span>${queried ? t("正在查询，超时将自动停止…") : t("正在读取当前页…")}</div>` : ""}${state.error ? `<div class="empty-state error-state">${icon("info", 28)}<strong>${t("暂时无法加载")}</strong><p>${escapeHTML(t(state.error))}</p><button class="button" data-action="retry">${t("重新尝试")}</button></div>` : p?.rows.length ? tableHTML(p) : !state.loading ? `<div class="empty-state">${icon("search", 30)}<strong>${queried ? t("没有符合条件的数据") : t("文件中没有数据行")}</strong><span>${queried ? t("试试调整筛选条件，或者重置筛选。") : t("仍然可以在“文件结构”中查看字段。")}</span>${queried ? `<button class="button" data-action="clear-query">${t("重置筛选与排序")}</button>` : ""}</div>` : ""}</div>
    <div class="page-footer"><div class="page-stats"><span>${p && !state.loading && !state.error ? (p.rows.length ? `<strong>${number(p.offset + 1)} – ${number(p.offset + p.rows.length)}</strong> / ${p.total === null ? t("筛选结果 · 总数未扫描") : number(p.total) + t(" 行")}` : t("0 行")) : t("按需加载")}</span>${p && !state.loading ? `<span class="timing">${icon("bolt", 11)} ${p.elapsed_ms} ms</span>` : ""}${p?.truncated.length ? `<span title="${t("超长单元格仅展示有限预览，源文件未改变")}">${t("部分值已截断")}</span>` : ""}</div><div class="pagination"><select id="page-size" aria-label="${t("每页行数")}">${[25, 50, 100, 200].map((n) => `<option ${n === state.limit ? "selected" : ""} value="${n}">${n} ${t("行 / 页")}</option>`).join("")}</select><button class="icon-button" data-action="first" aria-label="${t("第一页")}" ${state.offset === 0 || state.loading ? "disabled" : ""}>«</button><button class="icon-button" data-action="prev" aria-label="${t("上一页")}" ${state.offset === 0 || state.loading ? "disabled" : ""}>‹</button><input class="page-jump" id="page-jump" type="number" min="1" max="${queried ? 10000000 : Math.max(1, Math.ceil(state.file.rows / state.limit))}" aria-label="${t("跳转到页，输入后按回车")}" title="${t("输入页码，按回车跳转")}" value="${Math.floor(state.offset / state.limit) + 1}"><button class="icon-button" data-action="next" aria-label="${t("下一页")}" ${!p?.has_more || state.loading || state.error ? "disabled" : ""}>›</button>${!queried ? `<button class="icon-button" data-action="last" aria-label="${t("最后一页")}" ${!p?.has_more || state.loading || state.error ? "disabled" : ""}>»</button>` : ""}</div></div>`;
  const exportButton = $('[data-action="export"]');
  if (exportButton)
    exportButton.disabled = !p?.rows.length || state.loading || !!state.error;
}
function cellHTML(value, column) {
  if (value === null) return '<span class="null">null</span>';
  if (typeof value === "object")
    return `<span class="nested-value">${icon("layers", 11)} ${Array.isArray(value) ? `Array [${value.length}]` : `{ ${Object.keys(value).slice(0, 2).map(escapeHTML).join(", ")}${Object.keys(value).length > 2 ? ", …" : ""} }`}</span>`;
  if (typeof value === "boolean")
    return `<span class="bool ${value ? "" : "false"}">${value}</span>`;
  if (
    column.name === "status" &&
    ["已完成", "配送中", "待付款", "已取消"].includes(value)
  )
    return `<span class="cell-status ${["配送中", "待付款"].includes(value) ? "pending" : value === "已取消" ? "cancelled" : ""}">${value}</span>`;
  return escapeHTML(String(value).slice(0, 250));
}
function tableHTML(p) {
  const truncated = new Set(p.truncated.map(([r, c]) => `${r}:${c}`));
  return `<div class="table-scroll"><table class="data-table" aria-label="${t("Parquet 数据预览")}"><thead><tr><th class="row-index">#</th>${p.columns.map((col, i) => `<th scope="col"><button class="sort-button" data-action="sort" data-index="${i}" title="${t("点击切换升序、降序、取消排序")}"><span>${escapeHTML(col.name)}<span class="field-type mono" title="${escapeHTML(col.type)}">${escapeHTML(col.type)}</span></span><span class="sort-icon ${state.sort === col.name ? "sorted" : ""}">${state.sort === col.name ? (state.direction === "asc" ? "↑" : "↓") : "↕"}</span></button></th>`).join("")}</tr></thead><tbody>${p.rows.map((row, ri) => `<tr data-row="${ri}" tabindex="0" aria-label="${t("查看第 {0} 行详情", p.offset + ri + 1)}"><td class="row-index">${number(p.offset + ri + 1)}</td>${row.map((v, ci) => `<td class="${/^(u?int|float|double|decimal)/.test(p.columns[ci].type) ? "numeric" : "string"}" title="${t("点击查看详情")}${truncated.has(`${ri}:${ci}`) ? t(" · 此值已截断") : ""}">${cellHTML(v, p.columns[ci])}${truncated.has(`${ri}:${ci}`) ? '<span class="truncated-mark">…</span>' : ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
async function selectFile(id) {
  if (id === state.file?.id) return;
  const epoch = ++state.epoch;
  ++state.viewEpoch;
  state.controller?.abort();
  closeDrawer();
  try {
    const file = await api(`/api/files/${id}`);
    if (epoch !== state.epoch) return;
    state.file = file;
    state.page = null;
    state.tab = "data";
    state.offset = 0;
    state.groupsOffset = 0;
    state.statsOffset = 0;
    state.columns = file.schema.slice(0, 20).map((f) => f.name);
    state.filters = [];
    state.sort = null;
    state.error = "";
    state.schemaIndex = 0;
    state.loading = true;
    document.title = `${file.name} · Parquet Lens`;
    render();
    await loadData();
  } catch (error) {
    if (epoch === state.epoch) toast(error.message);
  }
}
async function addFile(file) {
  if (!state.files.some((f) => f.id === file.id)) state.files.push(file);
  await selectFile(file.id);
}
async function loadData() {
  if (!state.file) return;
  if (!state.columns.length) {
    state.loading = false;
    state.page = null;
    if (state.tab === "data") renderData();
    return;
  }
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  const epoch = state.epoch;
  state.loading = true;
  state.error = "";
  closeDrawer();
  if (state.tab === "data") renderData();
  try {
    const page = await post(
      `/api/files/${state.file.id}/page`,
      {
        offset: state.offset,
        limit: state.limit,
        columns: state.columns,
        filters: state.filters,
        sort: state.sort,
        direction: state.direction,
      },
      { signal: controller.signal },
    );
    if (controller.signal.aborted || epoch !== state.epoch) return;
    state.page = page;
  } catch (error) {
    if (controller.signal.aborted || epoch !== state.epoch) return;
    state.error =
      error.message === "Failed to fetch"
        ? t("连接已断开，请确认本机服务仍在运行。")
        : error.message;
    state.page = null;
  } finally {
    if (!controller.signal.aborted && epoch === state.epoch) {
      state.loading = false;
      if (state.tab === "data") renderData();
    }
  }
}

function fieldBadge(type) {
  if (/^(u?int|float|double|decimal)/.test(type)) return "#";
  if (type === "bool") return "⊨";
  if (/timestamp|date|time/.test(type)) return "◷";
  if (/list|map/.test(type)) return "[]";
  if (/struct/.test(type)) return "{}";
  return "Aa";
}
function childrenHTML(fields) {
  return fields
    .map(
      (f) =>
        `<div class="schema-child"><span>${escapeHTML(f.name)}</span> <span class="mono">${escapeHTML(f.type)}</span>${f.children.length ? childrenHTML(f.children) : ""}</div>`,
    )
    .join("");
}
function renderSchema() {
  $("#view").innerHTML =
    `<div class="schema-layout"><div class="schema-tree"><div class="panel-head"><strong>${t("字段结构")}</strong><span class="tag">${state.file.columns} ${t("个顶层字段")}</span></div><input id="schema-search" type="search" placeholder="${t("搜索字段…")}" aria-label="${t("搜索结构字段")}"><div id="schema-fields">${state.file.schema.map((f, i) => `<div class="schema-node" data-name="${escapeHTML(f.name.toLowerCase())}"><button class="schema-field ${state.schemaIndex === i ? "selected" : ""}" data-action="schema-field" data-index="${i}"><span class="type-badge mono">${fieldBadge(f.type)}</span><div>${escapeHTML(f.name)}<span class="field-type mono">${escapeHTML(f.type)}</span></div>${f.nullable ? `<span class="tag">${t("可空")}</span>` : ""}</button>${f.children.length ? `<div class="schema-children">${childrenHTML(f.children)}</div>` : ""}</div>`).join("")}</div></div><div class="schema-detail" id="schema-detail"></div></div>`;
  loadStats();
}
async function loadStats() {
  const field = state.file.schema[state.schemaIndex];
  const id = ++state.viewEpoch;
  if (!field) {
    $("#schema-detail").innerHTML =
      `<div class="empty-state">${t("没有字段")}</div>`;
    return;
  }
  $("#schema-detail").innerHTML =
    `<div class="schema-detail-content"><div class="detail-title"><span class="type-badge mono">${fieldBadge(field.type)}</span><div><span class="eyebrow">FIELD DETAILS</span><h2>${escapeHTML(field.name)}</h2></div></div><dl class="kv-grid"><div><dt>${t("数据类型")}</dt><dd class="mono">${escapeHTML(field.type)}</dd></div><div><dt>${t("空值约束")}</dt><dd>${field.nullable ? t("允许为空（nullable）") : t("不允许为空（required）")}</dd></div></dl><h3 class="section-label">${t("行组统计")}</h3><p class="info-note">${t("直接来自 Parquet 页脚，无需扫描数据。null 表示文件未记录对应统计信息；min / max 为各行组的统计值。")}</p><div id="stats-content"><div class="empty-state"><span class="spinner"></span>${t("读取统计信息…")}</div></div></div>`;
  try {
    const result = await api(
      `/api/files/${state.file.id}/stats?column=${encodeURIComponent(field.name)}&offset=${state.statsOffset}`,
    );
    if (id !== state.viewEpoch || state.tab !== "schema") return;
    $("#stats-content").innerHTML = result.nested
      ? `<div class="info-note">${t("这是一个嵌套字段。可在左侧展开查看子字段；嵌套叶子的统计不直接等同于父字段统计，因此这里不合并空值数。")}</div>`
      : `<div class="table-scroll"><table class="compact-table"><thead><tr><th>${t("行组")}</th><th>${t("空值数")}</th><th>${t("最小值")}</th><th>${t("最大值")}</th><th>${t("压缩")}</th></tr></thead><tbody>${result.groups.map((g) => `<tr><td>${g.id + 1}</td><td>${g.nulls === null ? '<span class="null">null</span>' : number(g.nulls)}</td><td title="${escapeHTML(g.min)}">${g.min === null ? '<span class="null">null</span>' : escapeHTML(g.min)}</td><td title="${escapeHTML(g.max)}">${g.max === null ? '<span class="null">null</span>' : escapeHTML(g.max)}</td><td>${escapeHTML(g.compression)}</td></tr>`).join("")}</tbody></table></div><div class="page-footer"><span>${t("行组")} ${result.total ? state.statsOffset + 1 : 0}–${state.statsOffset + result.groups.length} / ${number(result.total)}</span><div class="pagination"><button class="icon-button" data-action="stats-prev" aria-label="${t("上一批字段统计")}" ${state.statsOffset === 0 ? "disabled" : ""}>‹</button><button class="icon-button" data-action="stats-next" aria-label="${t("下一批字段统计")}" ${state.statsOffset + result.groups.length >= result.total ? "disabled" : ""}>›</button></div></div>`;
  } catch (error) {
    if (id === state.viewEpoch && $("#stats-content"))
      $("#stats-content").innerHTML =
        `<p class="inline-error">${escapeHTML(t(error.message))}</p>`;
  }
}
async function renderGroups() {
  const id = ++state.viewEpoch;
  $("#view").innerHTML =
    `<div class="groups-intro"><p>${t("行组是 Parquet 的独立读取单元。点击“浏览数据”可直接跳转到该组。")}<br>${t("合适的行组大小有助于并行读取与筛选跳过。")}</p><span class="tag">${t("仅元数据 · 无数据扫描")}</span></div><div class="table-frame"><div class="empty-state"><span class="spinner"></span>${t("读取行组信息…")}</div></div>`;
  try {
    const result = await api(
      `/api/files/${state.file.id}/groups?offset=${state.groupsOffset}`,
    );
    if (id !== state.viewEpoch || state.tab !== "groups") return;
    const maxSize = Math.max(1, ...result.groups.map((g) => g.compressed));
    $(".table-frame").innerHTML =
      `<div class="table-scroll"><table class="compact-table"><thead><tr><th>${t("行组")}</th><th>${t("行范围（从 1 开始）")}</th><th>${t("行数")}</th><th>${t("压缩大小")}</th><th>${t("未压缩大小")}</th><th>${t("节省空间")}</th><th></th></tr></thead><tbody>${result.groups.map((g) => `<tr><td><span class="tag">RG ${String(g.id + 1).padStart(2, "0")}</span></td><td>${number(g.start + 1)} – ${number(g.start + g.rows)}</td><td>${number(g.rows)}</td><td>${bytes(g.compressed)}<div class="storage-bar"><i data-width="${Math.round((g.compressed / maxSize) * 100)}"></i></div></td><td>${bytes(g.uncompressed)}</td><td>${g.uncompressed ? Math.round((1 - g.compressed / g.uncompressed) * 100) + "%" : "—"}</td><td><button class="text-button" data-action="browse-group" data-offset="${g.start}">${t("浏览数据 →")}</button></td></tr>`).join("")}</tbody></table>${!result.groups.length ? `<div class="empty-state">${t("文件没有行组")}</div>` : ""}</div>`;
    $$(".storage-bar i").forEach((bar) => {
      bar.style.width = `${bar.dataset.width}%`;
    });
    $("#view").insertAdjacentHTML(
      "beforeend",
      `<div class="page-footer"><span>${t("行组")} ${result.total ? state.groupsOffset + 1 : 0}–${state.groupsOffset + result.groups.length} / ${number(result.total)}</span><div class="pagination"><button class="button" data-action="groups-prev" ${!state.groupsOffset ? "disabled" : ""}>${t("上一批")}</button><button class="button" data-action="groups-next" ${state.groupsOffset + result.groups.length >= result.total ? "disabled" : ""}>${t("下一批")}</button></div></div>`,
    );
  } catch (error) {
    if (id === state.viewEpoch && state.tab === "groups")
      $(".table-frame").innerHTML =
        `<div class="empty-state">${escapeHTML(t(error.message))}<button class="button" data-action="refresh">${t("重试")}</button></div>`;
  }
}
function renderMetadata() {
  const f = state.file;
  $("#view").innerHTML =
    `<div class="metadata-content"><div class="metadata-card"><h3>${t("文件信息")}</h3><dl class="kv-grid">${[
      [t("文件名称"), f.name],
      [t("格式版本"), f.format_version],
      [t("写入工具"), f.created_by || t("未记录")],
      [t("页脚大小"), bytes(f.footer_size)],
      [
        t("数据来源"),
        f.source === "upload"
          ? t("设备上传 / 会话临时文件")
          : t("本机文件 / 直接只读访问"),
      ],
      [t("压缩编码（首个行组）"), f.compression.join(", ") || t("无")],
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHTML(v)}</dd></div>`)
      .join(
        "",
      )}</dl></div><div class="metadata-card"><h3>${t("自定义元数据")}</h3>${
      Object.keys(f.metadata).length
        ? Object.entries(f.metadata)
            .map(
              ([k, v]) =>
                `<div class="row-field"><dt class="small muted">${escapeHTML(k)}</dt><pre class="metadata-value">${escapeHTML(v)}</pre></div>`,
            )
            .join("")
        : `<p class="muted small">${t("该文件没有可展示的自定义元数据。")}</p>`
    }<p class="info-note">${t("最多展示 50 项，每项最多 4,096 字符；内部 Arrow schema 元数据已隐藏。")}</p></div></div>`;
}

function openDialog() {
  $("#open-error").textContent = "";
  $("#path-section").hidden = !state.config.local_path;
  $("#open-dialog").showModal();
}
function closeDialogs() {
  $$("dialog[open]")
    .filter((d) => d.id !== "progress-dialog")
    .forEach((d) => d.close());
}
function renderColumns() {
  const search = $("#column-search").value.toLowerCase();
  $("#column-options").innerHTML = state.file.schema
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.name.toLowerCase().includes(search))
    .map(
      ({ f, i }) =>
        `<label class="column-option"><input type="checkbox" data-column-index="${i}" ${state.selectedColumns.has(f.name) ? "checked" : ""}><span>${escapeHTML(f.name)}</span><small class="mono">${escapeHTML(f.type)}</small></label>`,
    )
    .join("");
  $("#column-count").textContent = t(
    "已选 {0} / 80",
    state.selectedColumns.size,
  );
}
function readFilters() {
  return $$(".filter-line").map((line) => ({
    column: $('[name="column"]', line).value,
    op: $('[name="op"]', line).value,
    value: $('[name="value"]', line).value,
  }));
}
function renderFilters() {
  $("#filter-options").innerHTML = state.filterDraft
    .map(
      (f, i) =>
        `<div class="filter-line"><select name="column" aria-label="${t("条件")} ${i + 1} ${t("字段")}">${state.file.schema.map((field) => `<option ${field.name === f.column ? "selected" : ""} value="${escapeHTML(field.name)}">${escapeHTML(field.name)}</option>`).join("")}</select><select name="op" aria-label="${t("条件")} ${i + 1} ${t("运算")}">${Object.entries(
          ops,
        )
          .map(
            ([id, label]) =>
              `<option value="${id}" ${id === f.op ? "selected" : ""}>${t(label)}</option>`,
          )
          .join(
            "",
          )}</select><input name="value" aria-label="${t("条件")} ${i + 1} ${t("筛选值")}" placeholder="${t("输入筛选值")}" value="${escapeHTML(f.value)}" maxlength="2000" ${["is_null", "not_null"].includes(f.op) ? "disabled" : ""}><button class="icon-button" data-action="filter-remove" data-index="${i}" aria-label="${t("移除此条件")}">×</button></div>`,
    )
    .join("");
}
function openRow(index) {
  if (!state.page || state.loading) return;
  state.rowIndex = index;
  const p = state.page;
  const row = p.rows[index];
  $("#row-drawer").innerHTML =
    `<div class="drawer-head"><div><span class="eyebrow">ROW INSPECTOR</span><h2>${t("第 {0} 行", number(p.offset + index + 1))}</h2><p class="muted small">${p.total === null ? t("筛选 / 排序结果中的行号") : t("源文件行号")} · ${t("当前已加载的 {0} 个字段", p.columns.length)}</p></div><button class="icon-button" data-action="close-drawer" aria-label="${t("关闭行详情")}">×</button></div><div class="drawer-actions"><button class="button" data-action="copy-row">${icon("columns", 13)}${t("复制 JSON")}</button><button class="button" data-action="row-prev" ${index === 0 ? "disabled" : ""}>${t("上一行")}</button><button class="button" data-action="row-next" ${index === p.rows.length - 1 ? "disabled" : ""}>${t("下一行")}</button></div><dl class="row-fields">${p.columns.map((c, i) => `<div class="row-field"><dt>${escapeHTML(c.name)}<span class="field-type mono">${escapeHTML(c.type)}</span></dt><dd>${row[i] === null ? '<span class="null">null</span>' : escapeHTML(typeof row[i] === "object" ? JSON.stringify(row[i], null, 2) : row[i])}</dd>${p.truncated.some(([r, col]) => r === index && col === i) ? `<p class="info-note">${t("值较长，仅显示截断预览；导出和复制也只包含此预览。")}</p>` : ""}</div>`).join("")}</dl>`;
  $("#row-drawer").hidden = false;
  $("#drawer-backdrop").hidden = false;
  $("#row-drawer").scrollTop = 0;
  $('[data-action="close-drawer"]').focus();
}
function closeDrawer() {
  $("#row-drawer").hidden = true;
  $("#drawer-backdrop").hidden = true;
  state.rowIndex = null;
}
async function copyRow() {
  const object = Object.fromEntries(
    state.page.columns.map((c, i) => [
      c.name,
      state.page.rows[state.rowIndex][i],
    ]),
  );
  const text = JSON.stringify(object, null, 2);
  try {
    if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
    await navigator.clipboard.writeText(text);
    toast(t("已复制当前行 JSON（超长值为预览）"));
  } catch {
    download(
      text,
      `${state.file.name}-row-${state.page.offset + state.rowIndex + 1}.json`,
      "application/json",
    );
    toast(t("浏览器不支持剪贴板，已下载 JSON"));
  }
}
function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportPage() {
  const p = state.page;
  if (!p?.rows.length || state.loading) return;
  const csvCell = (v) => {
    let text =
      v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (typeof v === "string" && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const text =
    "\ufeff" +
    [
      p.columns.map((c) => csvCell(c.name)).join(","),
      ...p.rows.map((row) => row.map(csvCell).join(",")),
    ].join("\r\n");
  download(
    text,
    `${state.file.name.replace(/\.(parquet|pq)$/i, "")}-rows-${p.offset + 1}-${p.offset + p.rows.length}.csv`,
    "text/csv;charset=utf-8",
  );
  toast(
    t(
      "已导出当前页 {0} 行{1}；null 输出为空单元格",
      p.rows.length,
      p.truncated.length ? t("（含截断预览）") : "",
    ),
  );
}
async function uploadFile(file) {
  if (!/\.(parquet|pq)$/i.test(file.name))
    return toast(t("请选择 .parquet 或 .pq 文件"));
  if (file.size > state.config.max_upload)
    return toast(t("文件超过上传限制，请使用本机路径打开"));
  if (state.upload) return toast(t("请等待当前上传完成"));
  closeDialogs();
  $("#upload-name").textContent = `${file.name} · ${bytes(file.size)}`;
  $("#upload-status").textContent = t("准备上传…");
  $("#upload-progress").value = 0;
  $('[data-action="upload-cancel"]').disabled = false;
  $("#progress-dialog").showModal();
  const xhr = new XMLHttpRequest();
  state.upload = xhr;
  xhr.open("POST", `/api/files/upload?name=${encodeURIComponent(file.name)}`);
  xhr.setRequestHeader("Content-Type", "application/octet-stream");
  xhr.setRequestHeader("Accept-Language", I18n.language);
  xhr.upload.onprogress = (event) => {
    const percent = event.lengthComputable
      ? Math.round((event.loaded / event.total) * 100)
      : 0;
    $("#upload-progress").value = percent;
    $("#upload-status").textContent =
      percent >= 100
        ? t("传输完成，正在读取文件结构…")
        : t("已传输 {0}% · {1}", percent, bytes(event.loaded)); // Do not abort after all bytes are sent: the server may already have registered the file.
    // Do not abort after all bytes are sent: the server may already have registered the file.
    // Do not abort after all bytes are sent: the server may already have registered the file.true;
  };
  const finish = () => {
    $("#progress-dialog").close();
    state.upload = null;
    $("#file-input").value = "";
  };
  xhr.onload = async () => {
    finish();
    try {
      const result = JSON.parse(xhr.responseText);
      if (xhr.status < 200 || xhr.status >= 300)
        throw new Error(
          typeof result.detail === "string"
            ? result.detail
            : t("上传失败，请检查文件"),
        );
      await addFile(result);
    } catch (error) {
      toast(error.message);
    }
  };
  xhr.onerror = () => {
    finish();
    toast(t("上传中断，请检查连接后重试"));
  };
  xhr.onabort = () => {
    finish();
    toast(t("已取消上传"));
  };
  xhr.send(file);
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) {
    const row = event.target.closest("[data-row]");
    if (row) openRow(Number(row.dataset.row));
    return;
  }
  const action = button.dataset.action;
  try {
    switch (action) {
      case "language": {
        const row = state.rowIndex;
        I18n.setLanguage(I18n.language === "zh" ? "en" : "zh");
        render();
        if (row !== null) openRow(row);
        break;
      }
      case "open":
        openDialog();
        break;
      case "close-dialog":
        closeDialogs();
        break;
      case "choose-file":
        $("#file-input").click();
        break;
      case "demo": {
        button.disabled = true;
        button.textContent = t("正在准备示例…");
        try {
          await addFile(await post("/api/demo", {}));
        } finally {
          if (button.isConnected) {
            button.disabled = false;
            button.innerHTML = t("探索示例数据 {0}", icon("arrow", 14));
          }
        }
        break;
      }
      case "select-file":
        await selectFile(button.dataset.id);
        break;
      case "close-file": {
        const id = button.dataset.id;
        await api(`/api/files/${id}`, { method: "DELETE" });
        state.files = state.files.filter((f) => f.id !== id);
        if (state.file?.id === id) {
          ++state.epoch;
          ++state.viewEpoch;
          state.controller?.abort();
          closeDrawer();
          state.file = null;
          state.page = null;
          if (state.files.length) await selectFile(state.files.at(-1).id);
          else {
            document.title = t("Parquet Lens · 看清每一层数据");
            render();
          }
        } else render();
        break;
      }
      case "theme": {
        const theme =
          document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = theme;
        try {
          localStorage.setItem("parquet-lens-theme", theme);
        } catch {
          /* Optional preference. */
        }
        break;
      }
      case "tab":
        state.tab = button.dataset.tab;
        ++state.viewEpoch;
        render();
        break;
      case "refresh":
        if (state.tab === "data") await loadData();
        else renderTab();
        break;
      case "retry":
        await loadData();
        break;
      case "columns":
        state.selectedColumns = new Set(state.columns);
        $("#column-search").value = "";
        renderColumns();
        $("#columns-dialog").showModal();
        break;
      case "columns-all":
        state.selectedColumns = new Set(
          state.file.schema.slice(0, 80).map((f) => f.name),
        );
        renderColumns();
        break;
      case "columns-none":
        state.selectedColumns.clear();
        renderColumns();
        break;
      case "columns-apply":
        if (!state.selectedColumns.size || state.selectedColumns.size > 80) {
          toast(t("请选择 1–80 个字段"));
          break;
        }
        state.columns = state.file.schema
          .map((f) => f.name)
          .filter((name) => state.selectedColumns.has(name));
        state.offset = 0;
        closeDialogs();
        await loadData();
        break;
      case "filters":
        if (!state.file.schema.length) {
          toast(t("该文件没有可筛选的字段"));
          break;
        }
        state.filterDraft = state.filters.map((f) => ({ ...f }));
        if (!state.filterDraft.length)
          state.filterDraft.push({
            column: state.file.schema[0].name,
            op: "eq",
            value: "",
          });
        renderFilters();
        $("#filter-dialog").showModal();
        break;
      case "filter-add":
        state.filterDraft = readFilters();
        if (state.filterDraft.length >= 12) {
          toast(t("最多添加 12 个条件"));
          break;
        }
        state.filterDraft.push({
          column: state.file.schema[0].name,
          op: "eq",
          value: "",
        });
        renderFilters();
        break;
      case "filter-remove":
        state.filterDraft = readFilters();
        state.filterDraft.splice(Number(button.dataset.index), 1);
        renderFilters();
        break;
      case "filter-apply":
        state.filters = readFilters();
        state.offset = 0;
        closeDialogs();
        await loadData();
        break;
      case "remove-filter":
        state.filters.splice(Number(button.dataset.index), 1);
        state.offset = 0;
        await loadData();
        break;
      case "clear-query":
        state.filters = [];
        state.sort = null;
        state.offset = 0;
        await loadData();
        break;
      case "clear-sort":
        state.sort = null;
        state.offset = 0;
        await loadData();
        break;
      case "sort": {
        const name = state.page.columns[Number(button.dataset.index)].name;
        if (state.sort === name && state.direction === "desc")
          state.sort = null;
        else {
          state.direction = state.sort === name ? "desc" : "asc";
          state.sort = name;
        }
        state.offset = 0;
        await loadData();
        break;
      }
      case "first":
        state.offset = 0;
        await loadData();
        break;
      case "prev":
        state.offset = Math.max(0, state.offset - state.limit);
        await loadData();
        break;
      case "next":
        state.offset += state.limit;
        await loadData();
        break;
      case "last":
        state.offset = Math.max(
          0,
          (Math.ceil(state.file.rows / state.limit) - 1) * state.limit,
        );
        await loadData();
        break;
      case "schema-field":
        state.schemaIndex = Number(button.dataset.index);
        state.statsOffset = 0;
        $$(".schema-field").forEach((b) =>
          b.classList.toggle("selected", b === button),
        );
        await loadStats();
        break;
      case "groups-prev":
        state.groupsOffset = Math.max(0, state.groupsOffset - 30);
        await renderGroups();
        break;
      case "groups-next":
        state.groupsOffset += 30;
        await renderGroups();
        break;
      case "stats-prev":
        state.statsOffset = Math.max(0, state.statsOffset - 30);
        await loadStats();
        break;
      case "stats-next":
        state.statsOffset += 30;
        await loadStats();
        break;
      case "browse-group":
        state.offset = Number(button.dataset.offset);
        state.filters = [];
        state.sort = null;
        state.tab = "data";
        ++state.viewEpoch;
        state.page = null;
        state.loading = true;
        render();
        await loadData();
        break;
      case "close-drawer":
        closeDrawer();
        break;
      case "row-prev":
        openRow(state.rowIndex - 1);
        break;
      case "row-next":
        openRow(state.rowIndex + 1);
        break;
      case "copy-row":
        await copyRow();
        break;
      case "export":
        exportPage();
        break;
      case "upload-cancel":
        state.upload?.abort();
        break;
    }
  } catch (error) {
    toast(error.message);
  }
});
document.addEventListener("change", (event) => {
  const el = event.target;
  if (el.id === "file-input" && el.files[0]) uploadFile(el.files[0]);
  if (el.id === "mobile-file" && el.value) selectFile(el.value);
  if (el.id === "page-size") {
    state.limit = Number(el.value);
    state.offset = 0;
    loadData();
  }
  if (el.dataset.columnIndex !== undefined) {
    const name = state.file.schema[Number(el.dataset.columnIndex)].name;
    if (el.checked && state.selectedColumns.size >= 80) {
      el.checked = false;
      toast(t("最多同时展示 80 个字段"));
      return;
    }
    if (el.checked) state.selectedColumns.add(name);
    else state.selectedColumns.delete(name);
    $("#column-count").textContent = t(
      "已选 {0} / 80",
      state.selectedColumns.size,
    );
  }
  if (el.name === "op")
    $('[name="value"]', el.closest(".filter-line")).disabled = [
      "is_null",
      "not_null",
    ].includes(el.value);
});
document.addEventListener("input", (event) => {
  if (event.target.id === "column-search") renderColumns();
  if (event.target.id === "schema-search") {
    const value = event.target.value.toLowerCase();
    $$(".schema-node").forEach((el) => {
      el.hidden = !el.dataset.name.includes(value);
    });
  }
});
$("#path-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("button", event.target);
  button.disabled = true;
  $("#open-error").textContent = "";
  try {
    const result = await post("/api/files/local", {
      path: $("#file-path").value.trim(),
    });
    closeDialogs();
    await addFile(result);
  } catch (error) {
    $("#open-error").textContent = t(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#drawer-backdrop").addEventListener("click", closeDrawer);
$("#progress-dialog").addEventListener("cancel", (event) =>
  event.preventDefault(),
);
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    if (!state.upload) openDialog();
    return;
  }
  if (event.key === "Escape") closeDrawer();
  if (event.target.id === "page-jump" && event.key === "Enter") {
    const value = Number(event.target.value);
    const max =
      state.filters.length || state.sort
        ? 10000000
        : Math.max(1, Math.ceil(state.file.rows / state.limit));
    if (!Number.isInteger(value) || value < 1 || value > max) {
      toast(t("请输入 1–{0} 之间的页码", number(max)));
      return;
    }
    state.offset = (value - 1) * state.limit;
    loadData();
  }
  if (event.target.matches("[data-row]") && event.key === "Enter")
    openRow(Number(event.target.dataset.row));
});
let dragDepth = 0;
document.addEventListener("dragenter", (event) => {
  if (event.dataTransfer.types.includes("Files") && !state.upload) {
    event.preventDefault();
    dragDepth++;
    document.body.classList.add("dragging");
  }
});
document.addEventListener("dragover", (event) => {
  if (event.dataTransfer.types.includes("Files")) event.preventDefault();
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove("dragging");
});
document.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  if (event.dataTransfer.files.length) {
    if (event.dataTransfer.files.length > 1)
      toast(t("一次打开一个文件，已选择第一个"));
    uploadFile(event.dataTransfer.files[0]);
  }
});
try {
  document.documentElement.dataset.theme =
    localStorage.getItem("parquet-lens-theme") || "light";
} catch {
  /* Private browsing. */
}
(async () => {
  try {
    await I18n.init();
    render();
    [state.config, state.files] = await Promise.all([
      api("/api/config"),
      api("/api/files"),
    ]);
    if (state.files.length) await selectFile(state.files[0].id);
    else render();
  } catch (error) {
    render();
    toast(error.message);
  }
})();
