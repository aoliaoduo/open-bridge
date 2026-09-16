/**
 * Open Bridge 工作台渲染层。生命周期：
 * 项目选择（=壳托管桥的工作区，换项目即重启服务）→ 拖会话列表 → 输入 →
 * agent 循环（LLM 流式 → 需要工具时经壳转 MCP 执行 → 汇总回喂，封顶 25 轮）。
 */
"use strict";

const $ = (sel) => document.querySelector(sel);

/** 只读模式下允许的工具（写类一律不出现给模型）。 */
const READ_ONLY_TOOLS = new Set([
  "list_directory", "find_files", "search_files", "read_files", "get_file_info",
  "workspace_brief", "review_changes", "get_todos",
  "read_process_output", "get_process_snapshot",
  "bridge_status", "service_status", "read_service_log",
  "activity_log", "get_config", "get_usage_stats", "list_skills",
  "wait", "connectivity",
]);

const AGENT_STEP_CAP = 25;
const TOOL_RESULT_CAP = 12000;

const state = {
  projects: [],
  conversations: [],
  settings: { baseUrl: "https://api.deepseek.com", apiKey: "", model: "deepseek-chat" },
  permission: "完全访问",
  savedProjectPath: null,
};

let currentConv = null;   // null = 草稿（首个发送才落成会话）
let currentProject = null;
let availableTools = [];  // OpenAI function 格式，按权限过滤后
let allTools = [];
let running = false;

// ---- 持久化 -----------------------------------------------------------------

function persist() {
  const snapshot = {
    projects: state.projects,
    conversations: state.conversations.slice(-50),
    settings: state.settings,
    currentProjectPath: currentProject ? currentProject.path : null,
  };
  void obDesktop.store.save(snapshot);
}

// ---- 侧栏渲染 ----------------------------------------------------------------

function convTitle(conv) {
  return conv.title || "未命名会话";
}

function renderSidebar() {
  const projList = $("#projectList");
  projList.innerHTML = "";
  if (!state.projects.length) {
    const empty = document.createElement("div");
    empty.className = "sb-empty";
    empty.textContent = "还没有项目";
    projList.appendChild(empty);
  }
  for (const proj of state.projects) {
    const head = document.createElement("div");
    head.className = "proj-head";
    head.textContent = "📁 " + proj.name;
    head.title = proj.path;
    head.onclick = () => { void switchProject(proj.path); };
    projList.appendChild(head);
    const convs = state.conversations
      .filter((c) => c.projectPath === proj.path)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8);
    for (const conv of convs) {
      const item = document.createElement("div");
      item.className = "conv-item" + (currentConv && currentConv.id === conv.id ? " active" : "");
      item.textContent = convTitle(conv);
      item.title = convTitle(conv);
      item.onclick = () => openConv(conv.id);
      projList.appendChild(item);
    }
  }
  const recent = $("#recentList");
  recent.innerHTML = "";
  const latest = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  if (!latest.length) {
    const empty = document.createElement("div");
    empty.className = "sb-empty";
    empty.textContent = "最近还没有会话";
    recent.appendChild(empty);
  }
  for (const conv of latest) {
    const item = document.createElement("div");
    item.className = "recent-item";
    item.textContent = convTitle(conv);
    item.title = convTitle(conv);
    item.onclick = () => openConv(conv.id);
    recent.appendChild(item);
  }
  $("#profile").textContent = state.settings.model || "Open Bridge";
  const chip = $("#modelChip");
  chip.textContent = state.settings.apiKey ? `${state.settings.model}` : "未配置模型";
  $("#permChip").textContent = state.permission === "只读" ? "🔒 只读" : "⚠ 完全访问";
  $("#permChip").classList.toggle("warn", state.permission !== "只读");
  $("#projectChip").textContent = currentProject ? `▤ ${currentProject.name}` : "▤ 选择项目";
  $("#noProjectHint").hidden = Boolean(currentProject);
}

// ---- 会话渲染 -----------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function scrollBottom() {
  const box = $("#messages");
  box.scrollTop = box.scrollHeight;
}

function renderMessages(conv) {
  const box = $("#messages");
  box.innerHTML = "";
  for (const m of conv.messages) {
    appendMessageDom(m);
  }
  $("#emptyState").hidden = conv.messages.length > 0;
  box.hidden = conv.messages.length === 0;
  scrollBottom();
}

function appendMessageDom(m) {
  const box = $("#messages");
  const wrap = el("div", `msg ${m.role}`);
  const bubble = el("div", "bubble");
  if (m.role === "tool") {
    const details = el("details");
    const summary = el("summary", null, `🔧 ${m.name || "tool"}`);
    const pre = el("pre", null, typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 2));
    details.appendChild(summary);
    details.appendChild(pre);
    bubble.appendChild(details);
  } else {
    bubble.textContent = typeof m.content === "string" ? m.content : "";
  }
  wrap.appendChild(bubble);
  box.appendChild(wrap);
  return bubble;
}

function openConv(id) {
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return;
  currentConv = conv;
  const proj = state.projects.find((p) => p.path === conv.projectPath);
  if (proj && (!currentProject || currentProject.path !== proj.path)) {
    void switchProject(proj.path);
  }
  renderMessages(conv);
  renderSidebar();
}

function newChat() {
  currentConv = null;
  $("#emptyState").hidden = false;
  $("#messages").hidden = true;
  $("#messages").innerHTML = "";
  renderSidebar();
  $("#input").focus();
}

// ---- 项目选择 -----------------------------------------------------------------

function closePicker() { $("#projectPicker").hidden = true; }

function renderPicker() {
  const picker = $("#projectPicker");
  picker.innerHTML = "";
  for (const proj of state.projects) {
    const item = el("div", "pp-item");
    item.appendChild(el("span", null, "📁 " + proj.name));
    item.appendChild(el("span", "pp-path", proj.path));
    item.onclick = () => { closePicker(); void switchProject(proj.path); };
    picker.appendChild(item);
  }
  const add = el("div", "pp-item pp-add", "＋ 添加项目文件夹…");
  add.onclick = async () => {
    closePicker();
    const picked = await obDesktop.chooseWorkspace();
    if (!picked) return;
    await addProject(picked);
  };
  picker.appendChild(add);
  picker.appendChild(el("div", "pp-note", "项目即桥服务的工作区：切换项目会重启本地服务。"));
}

async function addProject(dirPath) {
  const name = dirPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dirPath;
  if (!state.projects.some((p) => p.path === dirPath)) {
    state.projects.push({ name, path: dirPath });
  }
  persist();
  await switchProject(dirPath);
}

async function switchProject(dirPath) {
  const proj = state.projects.find((p) => p.path === dirPath);
  if (!proj) return;
  if (currentProject && currentProject.path === dirPath) {
    renderSidebar();
    return;
  }
  currentProject = proj;
  renderSidebar();
  $("#projectChip").textContent = "▤ 重启服务中…";
  try {
    await obDesktop.setWorkspace(dirPath);
    allTools = await obDesktop.mcp.tools();
    applyPermission();
  } catch (error) {
    appendMessageDom({ role: "error", content: `切换项目失败：${error.message}` });
  }
  renderSidebar();
  persist();
}

// ---- 权限模式 -----------------------------------------------------------------

function applyPermission() {
  if (state.permission === "只读") {
    availableTools = allTools.filter((t) => READ_ONLY_TOOLS.has(t.function.name));
  } else {
    availableTools = allTools;
  }
}

// ---- 设置对话框 -----------------------------------------------------------------

function openSettings() {
  $("#cfgBase").value = state.settings.baseUrl;
  $("#cfgKey").value = state.settings.apiKey;
  $("#cfgModel").value = state.settings.model;
  $("#cfgStatus").textContent = "";
  $("#settingsDlg").showModal();
}

function collectSettings() {
  return {
    baseUrl: $("#cfgBase").value.trim() || "https://api.deepseek.com",
    apiKey: $("#cfgKey").value.trim(),
    model: $("#cfgModel").value.trim() || "deepseek-chat",
  };
}

function wireSettings() {
  $("#cfgCancel").onclick = () => $("#settingsDlg").close();
  $("#cfgSave").onclick = () => {
    state.settings = collectSettings();
    persist();
    renderSidebar();
    $("#settingsDlg").close();
  };
  $("#cfgTest").onclick = async () => {
    const status = $("#cfgStatus");
    status.className = "dlg-status";
    status.textContent = "测试中…";
    try {
      const result = await obDesktop.llm.test(collectSettings());
      status.className = "dlg-status ok";
      status.textContent = result;
    } catch (error) {
      status.className = "dlg-status bad";
      status.textContent = error.message;
    }
  };
}

// ---- agent 循环 -----------------------------------------------------------------

const SYSTEM_PROMPT = [
  "你是 Open Bridge 桌面工作台里的编码助手，运行在一个真实的本地项目上。",
  "你可以通过工具读写文件、搜索、运行命令、管理进程与服务——动手改代码前先用工具看清现状；",
  "工具返回的细节按需转述，不要整段倾倒；回答用中文，直接、具体、给结论。",
].join("\n");

function apiMessages(conv) {
  const projectLine = currentProject ? `当前项目目录：${currentProject.path}` : "尚未选择项目。";
  const msgs = [{ role: "system", content: `${SYSTEM_PROMPT}\n${projectLine}\n当前权限模式：${state.permission}。` }];
  for (const m of conv.messages) {
    if (m.role === "user" || m.role === "assistant") {
      const entry = { role: m.role, content: m.content || "" };
      if (m.tool_calls) entry.tool_calls = m.tool_calls;
      msgs.push(entry);
    } else if (m.role === "tool") {
      msgs.push({ role: "tool", tool_call_id: m.tool_call_id, content: m.content });
    }
  }
  return msgs;
}

function toolCardDom(name) {
  return appendMessageDom({ role: "tool", name, content: "执行中…" });
}

function fillToolCard(bubble, name, resultText) {
  const pre = bubble.querySelector("pre");
  if (pre) pre.textContent = resultText;
  const summary = bubble.querySelector("summary");
  if (summary) summary.textContent = `🔧 ${name}`;
  scrollBottom();
}

async function runAgent(conv) {
  running = true;
  $("#sendBtn").disabled = true;
  let step = 0;
  try {
    while (step < AGENT_STEP_CAP) {
      step += 1;
      const assistantBubble = appendMessageDom({ role: "assistant", content: "" });
      scrollBottom();
      let result;
      try {
        result = await obDesktop.llm.chat(
          { settings: state.settings, messages: apiMessages(conv), tools: availableTools },
          { delta: (text) => { assistantBubble.textContent += text; scrollBottom(); } },
        );
      } catch (error) {
        assistantBubble.remove();
        throw error;
      }
      const toolCalls = result.toolCalls || [];
      if (!toolCalls.length) {
        conv.messages.push({ role: "assistant", content: result.text });
        break;
      }
      conv.messages.push({ role: "assistant", content: result.text || "", tool_calls: toolCalls });
      if (!result.text) assistantBubble.textContent = "";
      for (const call of toolCalls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
        const card = toolCardDom(call.function.name);
        scrollBottom();
        let outText;
        try {
          const out = await obDesktop.mcp.callTool(call.function.name, args);
          outText = typeof out === "string" ? out : JSON.stringify(out, null, 2);
        } catch (error) {
          outText = `工具执行失败：${error.message}`;
        }
        if (outText.length > TOOL_RESULT_CAP) {
          outText = outText.slice(0, TOOL_RESULT_CAP) + `\n…（截断，共 ${outText.length} 字符）`;
        }
        conv.messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: outText });
        fillToolCard(card, call.function.name, outText);
      }
    }
    if (step >= AGENT_STEP_CAP) {
      appendMessageDom({ role: "error", content: `已达单轮工具调用上限（${AGENT_STEP_CAP} 步），先到这里。` });
    }
  } catch (error) {
    appendMessageDom({ role: "error", content: error.message });
  } finally {
    running = false;
    $("#sendBtn").disabled = false;
    conv.updatedAt = Date.now();
    persist();
    renderSidebar();
    scrollBottom();
  }
}

async function send() {
  const input = $("#input");
  const text = input.value.trim();
  if (!text || running) return;
  if (!state.settings.apiKey) { openSettings(); return; }
  if (!currentProject) { $("#projectPicker").hidden = false; renderPicker(); return; }
  if (!currentConv) {
    currentConv = {
      id: `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      projectPath: currentProject.path,
      title: text.slice(0, 24),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    state.conversations.push(currentConv);
    $("#emptyState").hidden = true;
    $("#messages").hidden = false;
  }
  currentConv.messages.push({ role: "user", content: text });
  currentConv.updatedAt = Date.now();
  appendMessageDom({ role: "user", content: text });
  input.value = "";
  input.style.height = "auto";
  scrollBottom();
  persist();
  renderSidebar();
  await runAgent(currentConv);
}

// ---- 启动 -----------------------------------------------------------------

function autoGrow() {
  const input = $("#input");
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

async function boot() {
  const saved = await obDesktop.store.load();
  if (saved && typeof saved === "object") {
    if (Array.isArray(saved.projects)) state.projects = saved.projects;
    if (Array.isArray(saved.conversations)) state.conversations = saved.conversations;
    if (saved.settings && typeof saved.settings === "object") {
      state.settings = { ...state.settings, ...saved.settings };
    }
    state.savedProjectPath = typeof saved.currentProjectPath === "string" ? saved.currentProjectPath : null;
  }

  const status = await obDesktop.status();
  if (status && status.workspace) {
    const known = state.projects.find((p) => p.path === status.workspace);
    if (known) currentProject = known;
    else {
      const name = status.workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || status.workspace;
      state.projects.push({ name, path: status.workspace });
      currentProject = state.projects[state.projects.length - 1];
    }
  }

  try {
    allTools = await obDesktop.mcp.tools();
    applyPermission();
  } catch { allTools = []; }

  renderSidebar();
  wireSettings();
  $("#sendBtn").onclick = () => { void send(); };
  $("#newChat").onclick = newChat;
  $("#modelChip").onclick = openSettings;
  $("#consoleBtn").onclick = () => { void obDesktop.openConsole(); };
  $("#permChip").onclick = () => {
    state.permission = state.permission === "只读" ? "完全访问" : "只读";
    applyPermission();
    renderSidebar();
  };
  $("#projectChip").onclick = () => {
    const picker = $("#projectPicker");
    picker.hidden = !picker.hidden;
    if (!picker.hidden) renderPicker();
  };
  document.addEventListener("click", (event) => {
    const picker = $("#projectPicker");
    if (!picker.hidden && !picker.contains(event.target) && event.target.id !== "projectChip") {
      closePicker();
    }
  });
  const input = $("#input");
  input.addEventListener("input", autoGrow);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  });
  input.focus();
}

document.addEventListener("DOMContentLoaded", () => { void boot(); });
