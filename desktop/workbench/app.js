/**
 * Open Bridge 桌面客户端渲染层（总览 / 活动实况）。
 * 定位：MCP 上桌面 —— 服务状态可视、连接器 URL 一键复制、桥的活动日志直播；
 * 不含本地 agent 循环，网页 AI 才是真正的驾驶员。
 */
"use strict";

const $ = (sel) => document.querySelector(sel);

let latestStatus = null;
let activityTimer = null;
let paused = false;
const seenKeys = new Set();
const STATUS_ICON = { running: "●", completed: "✓", error: "✗", warning: "▲", progress: "◌" };

// ---- 视图切换 -----------------------------------------------------------------

function showView(name) {
  $("#viewHome").hidden = name !== "home";
  $("#viewActivity").hidden = name !== "activity";
  $("#navHome").classList.toggle("active", name === "home");
  $("#navActivity").classList.toggle("active", name === "activity");
  if (name === "activity") startFeed();
  else stopFeed();
}

// ---- 总览 -----------------------------------------------------------------

function maskUrl(raw) {
  if (!raw) return "—";
  const cut = raw.lastIndexOf("/mcp/");
  const head = cut > 0 ? raw.slice(0, cut + 5) : raw;
  return `${head}••••••••••••••••`;
}

let masked = true;

function renderHome() {
  const s = latestStatus;
  if (!s) return;
  const running = Boolean(s.port);
  const stateEl = $("#svcState");
  stateEl.textContent = running ? "运行中" : "未运行";
  stateEl.className = "v " + (running ? "dot-ok" : "dot-bad");
  $("#svcPort").textContent = s.port || "—";
  $("#svcWs").textContent = s.workspace || "—";
  $("#wsPath").textContent = s.workspace || "（未选择）";
  $("#svcMode").textContent = s.attached ? "附着到已运行实例" : "本壳自管";
  $("#svcLog").textContent = s.logFile || "—";
  const pub = s.publicMcpUrl || "";
  const loop = s.loopbackMcpUrl || "";
  $("#urlPublic").textContent = masked ? maskUrl(pub) : (pub || "—");
  $("#urlLoop").textContent = masked ? maskUrl(loop) : (loop || "—");
  $("#rowPublic").hidden = !pub;
  $("#tunnelNote").hidden = Boolean(pub);
  $("#maskToggle").textContent = masked ? "显示" : "隐藏";
}

async function refreshStatus() {
  try {
    latestStatus = await obDesktop.status();
    renderHome();
  } catch { /* 壳还没起好时静候下一轮 */ }
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    try { await obDesktop.copyText(text); } catch { /* 剪贴板不可达时用户手选 */ }
  }
}

// ---- 活动实况 -----------------------------------------------------------------

function feedKey(entry, index) {
  return `${entry.ts || 0}:${entry.tool || ""}:${index}`;
}

function timeLabel(entry) {
  if (entry.ts) {
    const d = new Date(entry.ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  return typeof entry.at === "string" ? entry.at : "";
}

function renderEntry(entry, index) {
  const item = document.createElement("div");
  item.className = "feed-item";
  const row1 = document.createElement("div");
  row1.className = "row1";
  const time = document.createElement("span");
  time.className = "feed-time";
  time.textContent = timeLabel(entry);
  const chip = document.createElement("span");
  chip.className = "tool-chip";
  chip.textContent = entry.tool || "?";
  const status = document.createElement("span");
  status.className = `feed-status ${entry.status || ""}`;
  status.textContent = STATUS_ICON[entry.status] || "·";
  row1.append(time, chip, status);
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
      .map((c) => `${c.path}  +${c.additions}/-${c.deletions}`)
      .join("  ·  ");
    item.appendChild(changes);
  }
  return { node: item, key: feedKey(entry, index) };
}

function trimFeed(max) {
  const feed = $("#feed");
  while (feed.children.length > max) feed.removeChild(feed.lastChild);
}

async function pollFeed() {
  if (paused) return;
  let activity = [];
  try {
    activity = await obDesktop.activity();
  } catch {
    return; // 桥未起/不可达：保留下一轮
  }
  if (!Array.isArray(activity)) return;
  const feed = $("#feed");
  const isEmpty = feed.querySelector(".feed-empty");
  if (isEmpty && activity.length) isEmpty.remove();
  // 桥的活动列表是最新在前的滚动窗（上限 40 条）；逐条对照，新的从顶部插入。
  activity.forEach((entry, index) => {
    const { node, key } = renderEntry(entry, index);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    feed.insertBefore(node, feed.firstChild);
  });
  trimFeed(120);
  $("#feedCount").textContent = `已显示 ${feed.children.length} 条`;
  if ($("#autoScroll").checked && $("#main").scrollTo) {
    // 列表新条目在顶部，自动滚动锚定顶部即可。
    $("#main").scrollTo({ top: 0 });
  }
}

function startFeed() {
  stopFeed();
  void pollFeed();
  activityTimer = setInterval(() => { void pollFeed(); }, 2000);
}

function stopFeed() {
  if (activityTimer) clearInterval(activityTimer);
  activityTimer = null;
}

// ---- 启动 -----------------------------------------------------------------

function wire() {
  $("#navHome").onclick = () => showView("home");
  $("#navActivity").onclick = () => showView("activity");
  $("#navConsole").onclick = () => { void obDesktop.openConsole(); };
  $("#openConsoleFromNote").onclick = () => { void obDesktop.openConsole(); };
  $("#maskToggle").onclick = () => {
    masked = !masked;
    renderHome();
  };
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".copy-btn");
    if (!button) return;
    const target = document.getElementById(button.getAttribute("data-target"));
    if (!target) return;
    const raw = target.getAttribute("data-raw") || target.textContent;
    void copyText(raw.replace(/•/g, "").trim() === "" ? "" : raw);
    button.textContent = "已复制";
    setTimeout(() => { button.textContent = "复制"; }, 1200);
  });
  $("#wsChange").onclick = async () => {
    const picked = await obDesktop.chooseWorkspace();
    if (!picked) return;
    $("#svcState").textContent = "重启中…";
    try {
      await obDesktop.setWorkspace(picked);
    } catch (error) {
      $("#svcState").textContent = `切换失败：${error.message}`;
    }
    await refreshStatus();
  };
  $("#feedPause").onclick = () => {
    paused = !paused;
    $("#feedPause").textContent = paused ? "继续" : "暂停";
  };
  $("#feedClear").onclick = () => {
    $("#feed").innerHTML = "";
    seenKeys.clear();
    const empty = document.createElement("div");
    empty.className = "feed-empty";
    empty.textContent = "（视图已清空，新的活动仍会持续进来）";
    $("#feed").appendChild(empty);
    $("#feedCount").textContent = "";
  };
}

async function boot() {
  wire();
  // URL 原文放进 data-raw，复制按钮永远拿到完整值，遮罩只影响观感。
  const publishRaw = () => {
    const pubEl = $("#urlPublic");
    const loopEl = $("#urlLoop");
    if (latestStatus) {
      pubEl.setAttribute("data-raw", latestStatus.publicMcpUrl || "");
      loopEl.setAttribute("data-raw", latestStatus.loopbackMcpUrl || "");
    }
  };
  await refreshStatus();
  publishRaw();
  setInterval(async () => { await refreshStatus(); publishRaw(); }, 5000);
  const empty = document.createElement("div");
  empty.className = "feed-empty";
  empty.textContent = "暂无活动：网页 AI 经 MCP 调用工具时，这里会滚动直播。";
  $("#feed").appendChild(empty);
}

document.addEventListener("DOMContentLoaded", () => { void boot(); });
