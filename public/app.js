/**
 * 智能问卷工作台前端。
 *
 * 设计取舍（决策 D6：后端优先、前端最小可用）：
 *   - 原生 JS + 无构建链：内网部署时直接由 Express 托管静态文件，
 *     不需要 Node 构建环境，也不需要 CDN（内网常常没有外网）。
 *   - 只有两个面板：左边跟 AI 对话改问卷，右边看结构并手工微调。
 *     这正好对应决策 D3 —— AI 是主路径，人工编辑器是兜底。
 *   - 所有状态以**服务端返回为准**：每次结构变更后重新 GET 结构，
 *     不在前端维护一份「可能与数据库不一致」的副本。
 */

// ============================================================
// 状态
// ============================================================

const state = {
  /** 当前扮演的用户 id（决策 D11：开发态用 x-user-id 头） */
  userId: null,
  /** 当前载入的问卷实例 */
  instanceId: null,
  /** 服务端的 current_revision，用于乐观锁与「结构是否变了」判断 */
  revision: null,
  status: null,
  /** 最近一次读取的结构 */
  schema: null,
  /** 正在流式对话时禁用发送 */
  streaming: false,
};

// ============================================================
// 小工具
// ============================================================

const $ = (id) => document.getElementById(id);

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = isError ? "toast error" : "toast";
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, isError ? 6000 : 3000);
}

/**
 * 统一的 API 调用。
 *
 * 关键：带 x-user-id（开发态鉴权，决策 D11），后端据此做纵向 + 横向授权，
 * 前端不做任何权限假设。
 *
 * 注意：**只在选定了用户之后**才带这个头。页面加载时需要先取账号列表，
 * 那时还没有用户；若无条件带上，会发出字面量字符串 "null" 而被 401 拒绝。
 */
async function api(method, path, body) {
  const headers = {};
  // 注意：只在真的选定了用户之后才带 x-user-id。
  // 之前是无条件带上，页面刚加载时 state.userId 还是 null，
  // 于是发出去的是**字面量字符串 "null"**，后端按 UUID 校验直接 401，
  // 导致账号列表取不到、用户下拉永远是空的（看起来像「登录不上」）。
  if (state.userId) headers["x-user-id"] = state.userId;
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!res.ok) {
    const err = payload && payload.error ? payload.error : {};
    const message = err.message || `HTTP ${res.status}`;
    const e = new Error(message);
    e.code = err.code;
    e.status = res.status;
    throw e;
  }

  return payload ? payload.data : null;
}

/** 创建元素（带可选的 class / 文本 / 属性） */
function el(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.attrs) {
    for (const [k, v] of Object.entries(options.attrs)) {
      node.setAttribute(k, v);
    }
  }
  return node;
}

/** 一个小按钮 */
function btn(text, { title, danger, onClick } = {}) {
  const node = el("button", {
    className: "btn-ghost" + (danger ? " danger" : ""),
    text,
    ...(title ? { attrs: { title } } : {}),
  });
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

// ============================================================
// 载入实例
// ============================================================

async function loadInstance(instanceId) {
  if (!instanceId) {
    toast("请先填写问卷实例 ID", true);
    return;
  }

  try {
    const data = await api(
      "GET",
      `/api/v1/questionnaire-instances/${instanceId}`
    );
    state.instanceId = instanceId;
    state.revision = data.currentRevision;
    state.status = data.status;
    state.schema = data.currentSchema;

    $("instance-input").value = instanceId;
    renderStructure();
    renderBadges();

    // 会话跟着实例走：载入实例就建一个新会话
    await ensureConversation();

    toast("已载入实例");
  } catch (e) {
    toast(`载入失败：${e.message}`, true);
  }
}

/**
 * 取当前实例的 AI 会话。
 *
 * 简化处理：每次载入实例就新建一个会话。
 * 真实产品应当复用未关闭的会话，但这里是「最小可用」的工作台。
 */
let conversationId = null;

async function ensureConversation() {
  conversationId = null;
  setChatStatus("连接中…");

  try {
    const conv = await api("POST", "/api/v1/ai/conversations", {
      scene: "modify_questionnaire",
      targetType: "questionnaire_instance",
      targetId: state.instanceId,
    });
    conversationId = conv.conversationId;
    setChatStatus("已就绪");
  } catch (e) {
    // 已下发的实例不允许建会话（决策 D1），这是正常业务分支
    setChatStatus("不可用", "warn");
    addMessage(
      "assistant",
      `当前实例状态为 ${state.status}，无法与 AI 对话修改。\n` +
        (e.code === "QUESTIONNAIRE_LOCKED"
          ? "如果需要修改结构，请先「撤回」。"
          : `原因：${e.message}`)
    );
  }
}

function setChatStatus(text, kind) {
  const node = $("chat-status");
  node.textContent = text;
  node.className = "badge" + (kind ? ` ${kind}` : "");
}

// ============================================================
// 结构渲染（含内联编辑）
// ============================================================

function renderBadges() {
  $("revision-badge").textContent = `revision ${state.revision ?? "-"}`;
  const badge = $("instance-badge");
  badge.textContent = state.status ?? "未载入";
  badge.className =
    "badge" +
    (state.status === "draft"
      ? ""
      : state.status === "completed"
        ? " ok"
        : state.status === "dispatched" || state.status === "submitted"
          ? " warn"
          : "");
}

/** 结构是否可编辑：draft 与 confirmed 可改，其余冻结（与后端 assertInstanceWritable 一致） */
function structureEditable() {
  return state.status === "draft" || state.status === "confirmed";
}

function renderStructure() {
  const root = $("structure");
  root.textContent = "";

  if (!state.schema) {
    root.appendChild(el("p", { className: "hint", text: "尚未载入问卷。" }));
    return;
  }

  const sections = state.schema.sections ?? [];
  if (sections.length === 0) {
    root.appendChild(
      el("p", { className: "hint", text: "这份问卷还没有任何分组。" })
    );
    return;
  }

  for (const section of sections) {
    root.appendChild(renderSection(section, sections));
  }
}

function renderSection(section, allSections) {
  const wrap = el("div", { className: "section" });

  // ---- 分组头 ----
  const head = el("div", { className: "section-head" });
  const title = el("span", {
    className: "section-title",
    text: section.title,
  });

  if (structureEditable()) {
    title.setAttribute("contenteditable", "true");
    title.addEventListener("blur", async () => {
      const next = title.textContent.trim();
      if (!next || next === section.title) {
        title.textContent = section.title;
        return;
      }
      await edit(
        "PATCH",
        `/api/v1/questionnaire-instances/${state.instanceId}/sections/${section.id}`,
        { title: next }
      );
    });
  }
  head.appendChild(title);

  if (structureEditable()) {
    head.appendChild(
      btn("＋题目", {
        title: "在该分组新增一道题",
        onClick: () => addQuestion(section.id),
      })
    );
  }
  wrap.appendChild(head);

  // ---- 题目列表 ----
  const list = el("ul", { className: "q-list" });
  const questions = section.questions ?? [];

  if (questions.length === 0) {
    list.appendChild(
      el("li", {
        className: "empty",
        text: structureEditable() ? "（空分组）" : "（空分组）",
      })
    );
  }

  questions.forEach((q, index) => {
    list.appendChild(renderQuestion(q, section, index, questions, allSections));
  });

  wrap.appendChild(list);
  return wrap;
}

function renderQuestion(q, section, index, siblings, allSections) {
  const item = el("li", { className: "q-item" });

  item.appendChild(
    el("span", { className: "q-order", text: `${index + 1}.` })
  );

  const body = el("div", { className: "q-body" });
  const title = el("div", { className: "q-title", text: q.title });

  if (structureEditable()) {
    title.setAttribute("contenteditable", "true");
    title.addEventListener("blur", async () => {
      const next = title.textContent.trim();
      if (!next || next === q.title) {
        title.textContent = q.title;
        return;
      }
      await edit(
        "PATCH",
        `/api/v1/questionnaire-instances/${state.instanceId}/questions/${q.id}`,
        { title: next }
      );
    });
  }
  body.appendChild(title);

  // ---- 元信息标签 ----
  const meta = el("div", { className: "q-meta" });
  meta.appendChild(el("span", { className: "tag", text: q.type }));
  if (q.required) {
    meta.appendChild(el("span", { className: "tag required", text: "必填" }));
  }
  if (q.options && q.options.length > 0) {
    meta.appendChild(
      el("span", {
        className: "tag",
        text: `${q.options.length} 个选项`,
      })
    );
  }
  body.appendChild(meta);
  item.appendChild(body);

  // ---- 行内操作 ----
  if (structureEditable()) {
    const actions = el("div", { className: "q-actions" });

    // 上移 / 下移（用 move_question 的 targetOrder 实现）
    if (index > 0) {
      actions.appendChild(
        btn("↑", {
          title: "上移",
          onClick: () =>
            moveQuestion(q.id, section.id, siblings[index - 1].order),
        })
      );
    }
    if (index < siblings.length - 1) {
      actions.appendChild(
        btn("↓", {
          title: "下移",
          onClick: () =>
            moveQuestion(q.id, section.id, siblings[index + 1].order + 1),
        })
      );
    }

    // 移到其它分组
    const others = allSections.filter((s) => s.id !== section.id);
    if (others.length > 0) {
      actions.appendChild(
        btn("→", {
          title: `移动到：${others.map((s) => s.title).join(" / ")}`,
          onClick: () => moveQuestion(q.id, others[0].id),
        })
      );
    }

    actions.appendChild(
      btn("✕", {
        title: "删除该题",
        danger: true,
        onClick: () => removeQuestion(q.id),
      })
    );

    item.appendChild(actions);
  }

  return item;
}

// ============================================================
// 编辑动作（统一处理乐观锁与刷新）
// ============================================================

/**
 * 所有写操作的统一入口。
 *
 * 三个关键点：
 *   1. 带上 expectedRevision 做乐观锁 —— 若别人（或另一个标签页、
 *      或 AI 会话）刚改过，服务端会返回 409，而不是静默覆盖；
 *   2. 成功后用服务端返回的 revision 更新本地状态；
 *   3. 失败时重新拉一次结构，保证界面与数据库一致（不做乐观更新）。
 */
async function edit(method, path, body) {
  try {
    const data = await api(method, path, {
      ...body,
      expectedRevision: state.revision,
    });
    if (data && typeof data.revision === "number") {
      state.revision = data.revision;
    }
    await refreshStructure();
    toast("已保存");
  } catch (e) {
    if (e.code === "REVISION_CONFLICT") {
      toast("这份问卷已被其他人（或 AI）修改，已为你刷新到最新版本，请重试。", true);
    } else {
      toast(`保存失败：${e.message}`, true);
    }
    await refreshStructure();
  }
}

async function refreshStructure() {
  if (!state.instanceId) return;
  const data = await api(
    "GET",
    `/api/v1/questionnaire-instances/${state.instanceId}`
  );
  state.revision = data.currentRevision;
  state.status = data.status;
  state.schema = data.currentSchema;
  renderStructure();
  renderBadges();
}

async function addSection() {
  const title = prompt("新分组的标题？");
  if (!title || !title.trim()) return;
  await edit("POST", `/api/v1/questionnaire-instances/${state.instanceId}/sections`, {
    title: title.trim(),
  });
}

async function addQuestion(sectionId) {
  const title = prompt("题目内容？");
  if (!title || !title.trim()) return;

  const type = prompt(
    "题型？（text / textarea / number / single_choice / multiple_choice / date / datetime / boolean）",
    "text"
  );
  if (!type) return;

  const needOptions =
    type === "single_choice" || type === "multiple_choice";
  let options;
  if (needOptions) {
    const raw = prompt("选项，用逗号分隔：", "是,否");
    if (!raw) return;
    options = raw
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((label) => ({ label }));
    if (options.length < 2) {
      toast("选择题至少要有 2 个选项", true);
      return;
    }
  }

  const required = confirm("这道题是必填吗？\n（确定 = 必填，取消 = 选填）");

  await edit(
    "POST",
    `/api/v1/questionnaire-instances/${state.instanceId}/questions`,
    {
      sectionId,
      type,
      title: title.trim(),
      required,
      ...(options ? { options } : {}),
    }
  );
}

async function removeQuestion(questionId) {
  if (!confirm("确定删除这道题？")) return;
  await edit(
    "DELETE",
    `/api/v1/questionnaire-instances/${state.instanceId}/questions/${questionId}`
  );
}

async function moveQuestion(questionId, targetSectionId, targetOrder) {
  await edit(
    "PATCH",
    `/api/v1/questionnaire-instances/${state.instanceId}/questions/${questionId}/move`,
    {
      targetSectionId,
      ...(targetOrder !== undefined ? { targetOrder } : {}),
    }
  );
}

// ============================================================
// AI 对话（SSE 流式）
// ============================================================

function addMessage(role, text) {
  const node = el("div", { className: `msg ${role}`, text });
  $("chat-log").appendChild(node);
  node.scrollIntoView({ block: "end" });
  return node;
}

/** 工具调用进度条（先显示「进行中」，结果到了再改成成功/失败） */
function addToolLine(toolName, operationId) {
  const line = el("div", { className: "tool running" });
  line.appendChild(el("span", { className: "dot" }));
  line.appendChild(el("code", { text: toolName }));
  const label = el("span", { text: "执行中…" });
  line.appendChild(label);
  $("chat-log").appendChild(line);
  line.scrollIntoView({ block: "end" });
  return { line, label };
}

const TOOL_LABELS = {
  add_section: "新增分组",
  add_question: "新增题目",
  update_section: "修改分组",
  update_question: "修改题目",
  remove_question: "删除题目",
  move_question: "移动题目",
  get_questionnaire: "读取问卷",
};

/**
 * 发送一条消息并读取 SSE 流。
 *
 * 为什么用 fetch + ReadableStream 而不是 EventSource：
 *   EventSource 只支持 GET，无法携带请求体，也无法自定义
 *   x-user-id 头；这里需要 POST + 头，所以手工解析 SSE。
 */
async function sendMessage(content) {
  if (state.streaming) return;
  if (!conversationId) {
    toast("当前没有可用的 AI 会话", true);
    return;
  }

  state.streaming = true;
  $("chat-send").disabled = true;

  addMessage("user", content);

  // 流式回复：先建一个空气泡，text_delta 往里面追加
  const bubble = addMessage("assistant", "");

  /** 工具进度条：operationId → { line, label } */
  const tools = new Map();

  try {
    const res = await fetch(
      `/api/v1/ai/conversations/${conversationId}/messages/stream`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // 与 api() 同理：没有用户时不要发字面量 "null"
          ...(state.userId ? { "x-user-id": state.userId } : {}),
        },
        body: JSON.stringify({ content }),
      }
    );

    if (!res.ok) {
      // 调用前就能判定的错误走正常状态码（422/403/404…）
      const text = await res.text();
      let message = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        message = parsed.error?.message || message;
      } catch {
        /* 保持默认消息 */
      }
      bubble.remove();
      addMessage("error", `发送失败：${message}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawToolChange = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        handleSseEvent(raw);
      }
    }
    if (buffer.trim()) handleSseEvent(buffer);

    function handleSseEvent(raw) {
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) return;

      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        return;
      }

      switch (event) {
        case "text_delta":
          bubble.textContent += payload.text;
          bubble.scrollIntoView({ block: "end" });
          break;

        case "tool_call_start": {
          const entry = addToolLine(payload.toolName, payload.operationId);
          tools.set(payload.operationId, entry);
          break;
        }

        case "tool_call_result": {
          const entry = tools.get(payload.operationId);
          if (entry) {
            entry.line.className = `tool ${payload.success ? "ok" : "fail"}`;
            entry.label.textContent = payload.success
              ? "✓ 完成"
              : `✗ ${payload.errorCode || "失败"}`;
          }
          break;
        }

        case "questionnaire_updated":
          // 结构变了：立刻刷新右侧结构树，用户能马上看到效果
          sawToolChange = true;
          refreshStructure().catch(() => {});
          break;

        case "done":
          if (!bubble.textContent.trim()) {
            bubble.textContent = payload.content || "（已完成）";
          }
          if (payload.truncated) {
            addMessage(
              "error",
              "这次改动较多，已达到单轮工具调用上限。请再发一条消息继续。"
            );
          }
          break;

        case "error":
          addMessage("error", `执行失败：${payload.message}`);
          break;

        default:
          break;
      }
    }

    if (sawToolChange) await refreshStructure();
  } catch (e) {
    addMessage("error", `连接中断：${e.message}`);
  } finally {
    state.streaming = false;
    $("chat-send").disabled = false;
    $("chat-input").focus();
  }
}

// ============================================================
// 生命周期动作
// ============================================================

async function doConfirm() {
  if (!state.instanceId) return;
  if (!confirm("确认这份问卷？确认后仍可修改，但只能撤回后重新下发。")) return;
  try {
    await api(
      "POST",
      `/api/v1/questionnaire-instances/${state.instanceId}/confirm`,
      { revision: state.revision }
    );
    await refreshStructure();
    toast("已确认");
  } catch (e) {
    toast(`确认失败：${e.message}`, true);
  }
}

async function doPromote() {
  if (!state.instanceId) return;
  const name = prompt("扶正后的模板版本名称？");
  if (!name || !name.trim()) return;
  try {
    await api(
      "POST",
      `/api/v1/questionnaire-instances/${state.instanceId}/promote`,
      { versionName: name.trim() }
    );
    toast("已扶正为模板草稿版本");
  } catch (e) {
    toast(`扶正失败：${e.message}`, true);
  }
}

async function doWithdraw() {
  if (!state.instanceId) return;
  const reason = prompt("撤回原因？（可留空）") ?? "";
  try {
    // 撤回会把既有答卷与下发任务一并作废（05 文档 13A.4），因此要二次确认
    if (
      !confirm(
        "撤回会作废既有答卷与下发任务，实例回到 draft。\n确定撤回？"
      )
    ) {
      return;
    }
    await api(
      "POST",
      `/api/v1/questionnaire-instances/${state.instanceId}/withdraw`,
      { reason }
    );
    await refreshStructure();
    await ensureConversation();
    toast("已撤回，可以重新修改结构了");
  } catch (e) {
    toast(`撤回失败：${e.message}`, true);
  }
}

/**
 * 新建实例：找一个已发布的模板版本并据此创建。
 *
 * 后端没有「跨模板列出所有已发布版本」的端点（版本挂在模板下），
 * 因此要两步：先列模板，再逐个查它的版本。
 */
async function doNewInstance() {
  try {
    const templates = await api(
      "GET",
      "/api/v1/questionnaire-templates?page=1&pageSize=50"
    );

    let versionId = null;
    let templateName = null;

    for (const t of templates.items ?? []) {
      const versions = await api(
        "GET",
        `/api/v1/questionnaire-templates/${t.id}/versions?page=1&pageSize=20`
      );
      const published = (versions.items ?? []).find(
        (v) => v.status === "published"
      );
      if (published) {
        versionId = published.id;
        templateName = t.name;
        break;
      }
    }

    if (!versionId) {
      toast("找不到已发布的模板版本，请先执行 pnpm db:seed", true);
      return;
    }

    const inst = await api("POST", "/api/v1/questionnaire-instances", {
      templateVersionId: versionId,
      title: `新案件 - ${new Date().toLocaleString("zh-CN")}`,
    });

    await loadInstance(inst.id);
    toast(`已基于「${templateName}」新建实例，可以开始用 AI 改问卷了`);
  } catch (e) {
    toast(`新建失败：${e.message}`, true);
  }
}

// ============================================================
// 初始化
// ============================================================

async function init() {
  // 账号列表来自 /api/v1/dev/users（仅非生产环境提供）。
  // x-user-id 必须是真实 UUID，因此前端不能自己编造。
  let users = [];
  try {
    const data = await api("GET", "/api/v1/dev/users");
    users = data.items ?? [];
  } catch (e) {
    toast(`无法获取可用账号：${e.message}`, true);
  }

  const select = $("user-select");
  select.textContent = "";
  for (const u of users) {
    const option = el("option", {
      text: `${u.displayName}（${u.roles.join("/")}）`,
      attrs: { value: u.id },
    });
    select.appendChild(option);
  }

  // 默认用下发人员：它既能建实例、又能改结构
  const preferred = users.find((u) => u.username === "dispatcher1") ?? users[0];
  if (preferred) {
    select.value = preferred.id;
    state.userId = preferred.id;
  }

  select.addEventListener("change", async () => {
    state.userId = select.value;
    const current = users.find((u) => u.id === select.value);
    toast(`已切换为 ${current ? current.displayName : select.value}`);
    if (state.instanceId) {
      try {
        await refreshStructure();
      } catch (e) {
        toast(`切换后刷新失败：${e.message}`, true);
      }
    }
  });

  $("btn-load").addEventListener("click", () =>
    loadInstance($("instance-input").value.trim())
  );

  $("btn-new").addEventListener("click", doNewInstance);
  $("btn-refresh").addEventListener("click", () =>
    refreshStructure().catch((e) => toast(e.message, true))
  );
  $("btn-add-section").addEventListener("click", addSection);
  $("btn-confirm").addEventListener("click", doConfirm);
  $("btn-promote").addEventListener("click", doPromote);
  $("btn-withdraw").addEventListener("click", doWithdraw);

  $("chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("chat-input");
    const content = input.value.trim();
    if (!content) return;
    input.value = "";
    await sendMessage(content);
  });

  // Enter 发送，Shift+Enter 换行
  $("chat-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("chat-form").requestSubmit();
    }
  });
}

init();
