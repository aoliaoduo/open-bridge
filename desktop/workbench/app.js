/**
 * Open Bridge 桌面客户端渲染层 v2。
 * 定位：网页 AI 的本地客户端 —— 总览、活动实况、工具目录。
 * 性能与观感原则：增量渲染（DocumentFragment + 键去重）、节点上限、
 * 不可见即停轮询、只动 transform/opacity 的动画。
 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const VIEWS = {
  home: { crumb: "总览" },
  feed: { crumb: "活动实况" },
  tools: { crumb: "工具目录" },
};
const STATUS_GLYPH = { running: "● 进行中", completed: "✓ 成功", error: "✗ 失败", warning: "▲ 警告", progress: "◌ 进展" };
const FEED_DOM_CAP = 250;
const FEED_CACHE_CAP = 500;

/* ———— 全局状态 ———— */
const state = {
  view: "home",
  status: null,
  masked: true,
  feedEntries: [],
  feedSeen: new Set(),
  feedPaused: false,
  feedFilter: "all",
  feedSearch: "",
  feedTimer: null,
  tools: null,
  toolsLoading: false,
  toolsError: "",
  toolSearch: "",
};

/* ———— 小工具 ———— */
function toast(text, isErr) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = text;
  $("#toasts").appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 220);
  }, 2200);
}

function maskUrl(raw) {
  if (!raw) return "—";
  const cut = raw.lastIndexOf("/mcp/");
  return (cut > 0 ? raw.slice(0, cut + 5) : raw) + "••••••••••••••••";
}

function timeLabel(entry) {
  if (entry.ts) {
    const d = new Date(entry.ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  return typeof entry.at === "string" ? entry.at.slice(-8) : "";
}

function entryKey(entry) {
  const msg = String(entry.message || "").slice(0, 48);
  return `${entry.ts || 0}|${entry.tool || ""}|${msg}`;
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ———— 视图切换 ———— */
function showView(name, push) {
  if (!VIEWS[name]) return;
  console.info(`[ob] view -> ${name} (hash=${window.location.hash})`);
  state.view = name;
  $("#viewHome").hidden = name !== "home";
  $("#viewFeed").hidden = name !== "feed";
  $("#viewTools").hidden = name !== "tools";
  $("#crumb").textContent = VIEWS[name].crumb;
  $$(".nav-item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (push !== false && window.location.hash !== `#${name}`) {
    window.location.hash = name; // 猎人位：hash 路由，smoke 也能直取任意视图取证
  }
  if (name === "feed") startFeed(); else stopFeed();
  if (name === "tools") void ensureTools();
}

function restoreViewFromHash() {
  const name = window.location.hash.replace(/^#/, "");
  showView(VIEWS[name] ? name : "home", false);
}

/* ———— 壳状态 ———— */
function renderStatus() {
  const s = state.status;
  if (!s) return;
  const running = Boolean(s.port);
  const pill = $("#topStatus");
  pill.className = "status-pill " + (running ? "ok" : "bad");
  pill.querySelector(".txt").textContent = running ? `桥运行中 · :${s.port}` : "桥未运行";
  const dot = $("#heroDot");
  dot.className = "hero-dot " + (running ? "ok" : "bad");
  $("#heroState").textContent = running ? "本地桥运行中" : "本地桥未运行";
  $("#heroSub").textContent = running
    ? `${s.attached ? "附着到已运行实例" : "本壳自管"} · 端口 ${s.port} · 工作区 ${s.workspace || "—"}`
    : "打开控制台或重启桥以拉起服务";
  $("#wsPath").textContent = s.workspace || "（未选择）";
  $("#wsPath").title = s.workspace || "";
  const pub = s.publicMcpUrl || "";
  const loop = s.loopbackMcpUrl || "";
  const pubEl = $("#urlPublic");
  const loopEl = $("#urlLoop");
  pubEl.dataset.raw = pub;
  loopEl.dataset.raw = loop;
  pubEl.textContent = pub ? (state.masked ? maskUrl(pub) : pub) : "—";
  loopEl.textContent = loop ? (state.masked ? maskUrl(loop) : loop) : "—";
  $("#rowPublic").hidden = !pub;
  $("#tunnelNote").hidden = Boolean(pub) || !running;
  $("#maskToggle").textContent = state.masked ? "显示" : "隐藏";
  $("#statPort").textContent = s.port || "—";
  $("#statMode").textContent = s.attached ? "附着" : "自管";
  if (s.logFile) {
    $("#statLog").textContent = `日志：${s.logFile}`;
    $("#statLog").title = s.logFile;
  }
  $("#statActivity").textContent = state.feedEntries.length || (running ? "0" : "—");
  if (state.tools) $("#statTools").textContent = state.tools.length;
}

async function refreshStatus() {
  try {
    state.status = await obDesktop.status();
    renderStatus();
    // 桥活着就顺手预载工具数：总览的统计格不该为此让人先点进工具目录。
    if (state.status && state.status.port && !state.tools && !state.toolsLoading) {
      void ensureTools(false);
    }
  } catch { /* 壳尚未就绪，下轮再来 */ }
}

/* ———— 复制 ———— */
async function copyRaw(el) {
  const raw = el.dataset.raw || "";
  if (!raw) return;
  try {
    await navigator.clipboard.writeText(raw);
  } catch {
    try { await obDesktop.copyText(raw); } catch { toast("剪贴板不可达，请手动选择复制", true); return; }
  }
  toast("已复制到剪贴板");
}

/* ———— 活动实况 ———— */
function feedMatches(entry) {
  if (state.feedFilter !== "all" && entry.status !== state.feedFilter) return false;
  const q = state.feedSearch.trim().toLowerCase();
  if (!q) return true;
  const hay = `${entry.tool || ""} ${entry.message || ""} ${entry.args_summary || ""}`.toLowerCase();
  return hay.includes(q);
}

function buildFeedItem(entry, fresh) {
  const item = document.createElement("div");
  item.className = `feed-item st-${entry.status || "progress"}` + (fresh ? " fresh" : "");
  const row1 = document.createElement("div");
  row1.className = "row1";
  const time = document.createElement("span");
  time.className = "feed-time";
  time.textContent = timeLabel(entry);
  const chip = document.createElement("span");
  chip.className = "tool-chip";
  chip.textContent = entry.tool || "?";
  const st = document.createElement("span");
  st.className = `feed-status ${entry.status || ""}`;
  st.textContent = STATUS_GLYPH[entry.status] || "·";
  row1.append(time, chip, st);
  const msg = document.createElement("div");
  msg.className = "feed-msg";
  msg.textContent = entry.message || "";
  item.append(row1, msg);
  if (entry.args_summary) {
    const args = document.createElement("div");
    args.className = "feed-args";
    args.textContent = entry.args_summary;
    item.appendChild(args);
  }
  if (Array.isArray(entry.changes) && entry.changes.length) {
    const changes = document.createElement("div");
    changes.className = "feed-changes";
    changes.textContent = entry.changes
      .map((c) => `${c.path} +${c.additions}/-${c.deletions}`)
      .join("  ·  ");
    item.appendChild(changes);
  }
  return item;
}

const rerenderFeed = () => {
  const feed = $("#feed");
  feed.innerHTML = "";
  const visible = state.feedEntries.filter(feedMatches).slice(0, FEED_DOM_CAP);
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "feed-empty";
    empty.textContent = state.feedEntries.length
      ? "没有符合过滤条件的活动。"
      : "暂无活动：网页 AI 经 MCP 调用工具时，这里会滚动直播。";
    feed.appendChild(empty);
  } else {
    const frag = document.createDocumentFragment();
    for (const entry of visible) frag.appendChild(buildFeedItem(entry, false));
    feed.appendChild(frag);
  }
  updateFeedMeta();
};

function updateFeedMeta() {
  const n = $("#feed").children.length;
  const total = state.feedEntries.length;
  $("#feedMeta").textContent = state.feedPaused
    ? `已暂停 · 显示 ${n} 条（共缓存 ${total} 条）`
    : `显示 ${n} 条（共缓存 ${total} 条，最新在前，每 2s 刷新）`;
  $("#statActivity").textContent = total;
}

async function pollFeed() {
  if (state.feedPaused || document.hidden) return;
  let batch;
  try {
    batch = await obDesktop.activity();
  } catch {
    return; // 桥未起/不可达：等下一轮
  }
  if (!Array.isArray(batch)) return;
  const fresh = [];
  // 桥的活动列表最新在前；倒着插回缓存头部，保持缓存同序。
  for (let i = batch.length - 1; i >= 0; i--) {
    const key = entryKey(batch[i]);
    if (state.feedSeen.has(key)) continue;
    state.feedSeen.add(key);
    fresh.unshift(batch[i]);
  }
  if (!fresh.length) {
    updateFeedMeta();
    return;
  }
  state.feedEntries = fresh.concat(state.feedEntries).slice(0, FEED_CACHE_CAP);
  if (state.feedSeen.size > FEED_CACHE_CAP * 2) {
    state.feedSeen = new Set(state.feedEntries.map(entryKey));
  }
  const filtering = state.feedFilter !== "all" || state.feedSearch.trim() !== "";
  if (filtering) {
    rerenderFeed();
    return;
  }
  // 无过滤：**只增量插入**，不整表重建。
  const feed = $("#feed");
  const empty = feed.querySelector(".feed-empty");
  if (empty) empty.remove();
  const frag = document.createDocumentFragment();
  for (const entry of fresh) frag.appendChild(buildFeedItem(entry, true));
  feed.insertBefore(frag, feed.firstChild);
  while (feed.children.length > FEED_DOM_CAP) feed.removeChild(feed.lastChild);
  if ($("#autoScroll").checked) $("#viewFeed").scrollTo({ top: 0 });
  updateFeedMeta();
}

function startFeed() {
  stopFeed();
  state.feedTimer = setInterval(() => { void pollFeed(); }, 2000);
  void pollFeed();
}

function stopFeed() {
  if (state.feedTimer) clearInterval(state.feedTimer);
  state.feedTimer = null;
}

/* ———— 工具目录 ———— */
async function ensureTools(force) {
  if (state.toolsLoading) return;
  if (state.tools && !force) {
    renderTools();
    return;
  }
  state.toolsLoading = true;
  state.toolsError = "";
  $("#toolsState").textContent = "正在与本地桥握手并拉取工具清单…";
  try {
    const list = await obDesktop.mcp.tools();
    state.tools = Array.isArray(list) ? list : [];
    $("#toolsState").textContent = "";
    if (state.tools.length) $("#statTools").textContent = state.tools.length;
  } catch (error) {
    state.toolsError = error instanceof Error ? error.message : String(error);
    $("#toolsState").textContent = `工具清单拉取失败：${state.toolsError}（桥未运行时此页为空很正常）`;
  } finally {
    state.toolsLoading = false;
    renderTools();
  }
}

function renderTools() {
  if (!state.tools) return;
  const q = state.toolSearch.trim().toLowerCase();
  const list = state.tools.filter((t) => {
    if (!q) return true;
    return `${t.name || ""} ${t.description || ""}`.toLowerCase().includes(q);
  });
  $("#toolsCount").textContent = state.tools.length ? `${list.length}/${state.tools.length}` : "";
  const box = $("#tools");
  box.innerHTML = "";
  if (!list.length) {
    if (state.tools.length) $("#toolsState").textContent = "没有匹配的工具。";
    return;
  }
  const frag = document.createDocumentFragment();
  for (const tool of list) {
    const row = document.createElement("div");
    row.className = "tool-row";
    const name = document.createElement("div");
    name.className = "tool-name";
    name.textContent = tool.name || "?";
    const desc = document.createElement("div");
    desc.className = "tool-desc";
    desc.textContent = tool.description || "";
    row.append(name, desc);
    frag.appendChild(row);
  }
  box.appendChild(frag);
}

/* ———— 主题与折叠 ———— */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("ob.theme", theme); } catch { /* file:// 下不可写时裸奔 */ }
}

function initTheme() {
  let theme = "";
  try { theme = localStorage.getItem("ob.theme") || ""; } catch { /* 忽略 */ }
  if (!theme) {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  applyTheme(theme);
}

function initCollapse() {
  let collapsed = false;
  try { collapsed = localStorage.getItem("ob.sbCollapsed") === "1"; } catch { /* 忽略 */ }
  $("#app").classList.toggle("collapsed", collapsed);
}

/* ———— 事件绑定 ———— */
function wire() {
  $$(".nav-item[data-view]").forEach((b) => {
    b.addEventListener("click", () => showView(b.dataset.view));
  });
  $("#navConsole").onclick = () => { void obDesktop.openConsole(); };
  $("#btnConsoleHome").onclick = () => { void obDesktop.openConsole(); };
  $("#openConsoleFromNote").onclick = () => { void obDesktop.openConsole(); };
  $("#navLog").onclick = async () => {
    try { await obDesktop.revealPath("log"); } catch { toast("日志路径不可用", true); }
  };
  $("#btnRestart").onclick = async () => {
    if (!window.confirm("重启本地桥？正在进行的网页 AI 调用会中断。")) return;
    toast("正在重启桥…");
    try {
      await obDesktop.restartBridge();
      toast("桥已重启");
    } catch (error) {
      toast(`重启失败：${error instanceof Error ? error.message : error}`, true);
    }
    await refreshStatus();
  };
  $("#collapseBtn").onclick = () => {
    const collapsed = !$("#app").classList.contains("collapsed");
    $("#app").classList.toggle("collapsed", collapsed);
    try { localStorage.setItem("ob.sbCollapsed", collapsed ? "1" : "0"); } catch { /* 忽略 */ }
  };
  $("#themeToggle").onclick = () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  };
  $("#maskToggle").onclick = () => {
    state.masked = !state.masked;
    renderStatus();
  };
  document.addEventListener("click", (event) => {
    const btn = event.target.closest(".copy-btn");
    if (!btn) return;
    const target = document.getElementById(btn.dataset.target);
    if (!target) return;
    void copyRaw(target);
    btn.classList.add("copied");
    btn.textContent = "已复制";
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.textContent = "复制";
    }, 1100);
  });
  $("#wsChange").onclick = async () => {
    const picked = await obDesktop.chooseWorkspace();
    if (!picked) return;
    $("#heroState").textContent = "重启中…";
    try {
      await obDesktop.setWorkspace(picked);
      toast("工作区已切换");
    } catch (error) {
      toast(`切换失败：${error instanceof Error ? error.message : error}`, true);
    }
    await refreshStatus();
  };
  $("#wsOpen").onclick = async () => {
    try { await obDesktop.revealPath("workspace"); } catch { toast("工作区路径不可用", true); }
  };
  // 活动实况控件
  $$("#feedFilters .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $$("#feedFilters .chip").forEach((c) => c.classList.toggle("on", c === chip));
      state.feedFilter = chip.dataset.f;
      rerenderFeed();
    });
  });
  $("#feedSearch").addEventListener("input", debounce(() => {
    state.feedSearch = $("#feedSearch").value;
    rerenderFeed();
  }, 120));
  $("#feedPause").onclick = () => {
    state.feedPaused = !state.feedPaused;
    $("#feedPause").textContent = state.feedPaused ? "继续" : "暂停";
    updateFeedMeta();
  };
  $("#feedClear").onclick = () => {
    state.feedEntries = [];
    state.feedSeen.clear();
    $("#feed").innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "feed-empty";
    empty.textContent = "（视图已清空，新的活动仍会持续进来）";
    $("#feed").appendChild(empty);
    updateFeedMeta();
  };
  // 工具目录控件
  $("#toolSearch").addEventListener("input", debounce(() => {
    state.toolSearch = $("#toolSearch").value;
    renderTools();
  }, 120));
  $("#toolsReload").onclick = () => { void ensureTools(true); };
  // 快捷键：1/2/3 切视图，/ 聚焦搜索，Esc 清空搜索
  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement) {
      if (event.key === "Escape") {
        event.target.value = "";
        event.target.dispatchEvent(new Event("input"));
        event.target.blur();
      }
      return;
    }
    if (event.key === "1") showView("home");
    else if (event.key === "2") showView("feed");
    else if (event.key === "3") showView("tools");
    else if (event.key === "/") {
      event.preventDefault();
      (state.view === "tools" ? $("#toolSearch") : $("#feedSearch")).focus();
    }
    else if (event.key.toLowerCase() === "d" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $("#themeToggle").click();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopFeed();
    else if (state.view === "feed") startFeed();
  });
}

async function boot() {
  console.info(`[ob] boot hash=${window.location.hash}`);
  initTheme();
  initCollapse();
  wire();
  restoreViewFromHash();
  window.addEventListener("hashchange", restoreViewFromHash);
  await refreshStatus();
  setInterval(() => { void refreshStatus(); }, 5000);
}

document.addEventListener("DOMContentLoaded", () => { void boot(); });
