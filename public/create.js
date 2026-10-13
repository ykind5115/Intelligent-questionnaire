/**
 * 「从零创建问卷」页。
 *
 * 流程（按用户试用反馈调整后的顺序）：
 *   1. 点「开始创建新问卷」→ **先给问卷起名字**
 *      （原先名字要等定稿才写进去，同一时刻多次创建会分不清哪个是自己的）
 *   2. 与 AI 对话，一轮轮把结构建出来
 *   3. 右侧实时显示生成结果：名称、分组/题目数、完整结构
 *   4. 「保存为模板草稿」定稿 → 「发布为正式模板」发布
 *   5. 发布后给「立即建案件」入口，不用再切页面
 */

import {
  $,
  api,
  askText,
  button,
  countSchema,
  el,
  getUserId,
  initUserPicker,
  renderNav,
  toast,
} from "/common.js";

renderNav("create");

const TOOL_LABELS = {
  add_section: "新增分组",
  add_question: "新增题目",
  update_section: "修改分组",
  update_question: "修改题目",
  remove_question: "删除题目",
  move_question: "移动题目",
  get_questionnaire: "读取问卷",
};

const state = {
  conversationId: null,
  templateId: null,
  templateVersionId: null,
  templateName: null,
  schema: null,
  status: null,
  committed: false,
  published: false,
  streaming: false,
};

// ============================================================
// 开始创建：先取名
// ============================================================

async function startNew() {
  if (state.conversationId) {
    const ok = await askText({
      title: "当前已有一份正在编辑的问卷",
      label: "要放弃它、重新开始吗？输入「重来」确认",
      placeholder: "重来",
      okText: "重新开始",
    });
    if (ok !== "重来") {
      // 用户没确认，保留现状
      return;
    }
  }

  const name = await askText({
    title: "给这份问卷起个名字",
    label: "问卷名称",
    placeholder: "例如：无人机黑飞核查问卷",
    okText: "开始生成",
  });
  if (!name) return;

  setStatus("创建中…", "warn");
  $("btn-start").disabled = true;

  try {
    const conv = await api("POST", "/api/v1/ai/conversations", {
      scene: "create_template",
      targetType: "template",
      // 关键：名字在创建的那一刻就确定
      templateName: name,
    });

    state.conversationId = conv.conversationId;
    state.templateId = conv.templateId;
    state.templateVersionId = conv.templateVersionId;
    state.templateName = name;
    state.schema = null;
    state.status = "draft";
    state.committed = false;
    state.published = false;

    $("chat-log").textContent = "";
    addMessage(
      "assistant",
      `好，这份问卷就叫「${name}」。\n\n` +
        "现在直接描述你要调查什么 —— 我会一轮轮把分组和题目建出来，" +
        "右侧会实时显示结果。"
    );

    setStatus("编辑中", "warn");
    applyButtons();
    renderResult();
    $("chat-input").focus();
  } catch (e) {
    setStatus("未开始");
    if (e.code === "PERMISSION_DENIED") {
      toast(
        "从零创建问卷属于模板治理动作，需要「模板管理员」账号。\n" +
          "请在右上角把用户切换成模板管理员再试。",
        true
      );
    } else {
      toast(`创建失败：${e.message}`, true);
    }
  } finally {
    $("btn-start").disabled = false;
  }
}

function setStatus(text, kind) {
  const node = $("chat-status");
  node.textContent = text;
  node.className = "badge" + (kind ? ` ${kind}` : "");
}

/** 按当前状态启用/禁用两个动作按钮 */
function applyButtons() {
  const started = Boolean(state.conversationId);
  const hasContent =
    state.schema && countSchema(state.schema).questions > 0;

  // 定稿：已开始、还没定稿、且确实有题目
  $("btn-commit").disabled = !started || state.committed || !hasContent;

  // 发布：必须已定稿且未发布（顺序不能乱：
  // 草稿没定稿就发布会让版本内容与模板名不一致）
  $("btn-publish").disabled = !state.committed || state.published;

  const badge = $("result-status");
  if (!started) {
    badge.textContent = "尚未开始";
    badge.className = "badge";
  } else if (state.published) {
    badge.textContent = "已发布";
    badge.className = "badge ok";
  } else if (state.committed) {
    badge.textContent = "已保存为草稿";
    badge.className = "badge ok";
  } else {
    badge.textContent = "编辑中";
    badge.className = "badge warn";
  }
}

// ============================================================
// 生成结果展示
// ============================================================

function renderResult() {
  const box = $("result-body");
  box.textContent = "";

  if (!state.conversationId) return;

  const { sections, questions } = countSchema(state.schema);

  const card = el("div", { className: "result-card" });
  card.appendChild(el("div", { className: "result-name", text: state.templateName }));

  const meta = el("div", { className: "pick-meta" });
  meta.appendChild(el("span", { className: "tag", text: "模板" }));
  meta.appendChild(
    el("span", { text: `${sections} 个分组 / ${questions} 道题` })
  );
  meta.appendChild(
    el("span", {
      className: `tag ${state.published ? "ok" : state.committed ? "ok" : "warn"}`,
      text: state.published ? "已发布" : state.committed ? "草稿已定稿" : "草稿",
    })
  );
  card.appendChild(meta);

  const idRow = el("div", { className: "pick-desc" });
  idRow.appendChild(el("span", { text: "模板 ID：" }));
  idRow.appendChild(el("code", { className: "mono", text: state.templateId }));
  card.appendChild(idRow);

  box.appendChild(card);

  // 结构预览：生成完能直接看到结果，不用跑去模板管理页
  if (sections === 0) {
    box.appendChild(
      el("p", {
        className: "hint",
        text: "还没有内容。在左边描述你要调查什么，我建好之后这里会显示结构。",
      })
    );
    return;
  }

  const preview = el("div", { className: "structure-preview" });
  for (const s of state.schema.sections) {
    const secBox = el("div", { className: "pv-section" });
    secBox.appendChild(el("div", { className: "pv-title", text: s.title }));

    const ul = el("ul", { className: "pv-questions" });
    if ((s.questions ?? []).length === 0) {
      ul.appendChild(el("li", { className: "hint", text: "（尚未加题）" }));
    }
    for (const q of s.questions ?? []) {
      const li = el("li");
      li.appendChild(el("span", { text: q.title }));
      li.appendChild(el("span", { className: "tag", text: q.type }));
      if (q.required) {
        li.appendChild(el("span", { className: "tag required", text: "必填" }));
      }
      ul.appendChild(li);
    }
    secBox.appendChild(ul);
    preview.appendChild(secBox);
  }
  box.appendChild(preview);

  // 发布后给下一步入口
  if (state.published) {
    const actions = el("div", { className: "result-actions" });

    const createCase = button("立即建案件", { className: "btn btn-primary" });
    createCase.addEventListener("click", goCreateCase);
    actions.appendChild(createCase);

    const goTemplates = button("去模板管理");
    goTemplates.addEventListener("click", () => {
      window.location.href = "/templates.html";
    });
    actions.appendChild(goTemplates);

    box.appendChild(actions);
  }
}

/** 用刚发布的模板建一个案件（不切页面） */
async function goCreateCase() {
  const title = await askText({
    title: "新建案件",
    label: "案件标题",
    value: `${state.templateName} - ${new Date().toLocaleDateString("zh-CN")}`,
    okText: "创建",
  });
  if (!title) return;

  try {
    const inst = await api("POST", "/api/v1/questionnaire-instances", {
      templateVersionId: state.templateVersionId,
      title,
    });
    const { sections, questions } = countSchema(inst.currentSchema);
    toast(
      `已用该模板创建案件「${inst.title}」（${sections} 个分组 / ${questions} 道题）\n` +
        `案件 ID：${inst.id}`
    );
  } catch (e) {
    toast(`创建案件失败：${e.message}`, true);
  }
}

/** 重新拉一次模板草稿的结构 */
async function refreshResult() {
  if (!state.templateId || !state.templateVersionId) return;
  try {
    const v = await api(
      "GET",
      `/api/v1/questionnaire-templates/${state.templateId}/versions/${state.templateVersionId}`
    );
    state.schema = v.schema;
    state.status = v.status;
    renderResult();
    applyButtons();
  } catch (e) {
    toast(`刷新失败：${e.message}`, true);
  }
}

// ============================================================
// 定稿 / 发布
// ============================================================

async function commitDraft() {
  if (!state.conversationId) return;
  $("btn-commit").disabled = true;
  try {
    const data = await api(
      "POST",
      `/api/v1/ai/conversations/${state.conversationId}/commit`,
      // 名字在创建时就定了，这里不再重复问
      {}
    );
    state.committed = true;
    toast(`已定稿为模板草稿 v${data.versionNo}。下一步可以「发布为正式模板」。`);
    await refreshResult();
  } catch (e) {
    if (e.code === "VALIDATION_ERROR") {
      toast(
        "这份问卷还没有内容（至少要有 1 个分组和 1 道题）才能定稿。\n" +
          "请先在左边让 AI 把结构建出来。",
        true
      );
    } else {
      toast(`定稿失败：${e.message}`, true);
    }
  } finally {
    applyButtons();
  }
}

async function publish() {
  if (!state.templateId || !state.templateVersionId) return;

  const ok = await askText({
    title: "发布为正式模板",
    label: "发布后新案件可直接选用，且该版本不能再改。输入「发布」确认",
    placeholder: "发布",
    okText: "发布",
  });
  if (ok !== "发布") return;

  $("btn-publish").disabled = true;
  try {
    await api(
      "POST",
      `/api/v1/questionnaire-templates/${state.templateId}/versions/${state.templateVersionId}/publish`
    );
    state.published = true;
    toast("已发布为正式模板。现在可以在「下发问卷」里用它建案件了。");
    await refreshResult();
  } catch (e) {
    toast(`发布失败：${e.message}`, true);
  } finally {
    applyButtons();
  }
}

// ============================================================
// 对话（SSE 流式）
// ============================================================

function addMessage(role, text) {
  const node = el("div", { className: `msg ${role}`, text });
  $("chat-log").appendChild(node);
  node.scrollIntoView({ block: "end" });
  return node;
}

function addToolLine(toolName) {
  const line = el("div", { className: "tool running" });
  line.appendChild(el("span", { className: "dot" }));
  line.appendChild(
    el("code", { text: TOOL_LABELS[toolName] ?? toolName })
  );
  const label = el("span", { text: "执行中…" });
  line.appendChild(label);
  $("chat-log").appendChild(line);
  line.scrollIntoView({ block: "end" });
  return { line, label };
}

async function sendMessage(content) {
  if (state.streaming) return;
  if (!state.conversationId) {
    toast("请先点「开始创建新问卷」", true);
    return;
  }

  state.streaming = true;
  $("chat-send").disabled = true;
  addMessage("user", content);

  const bubble = addMessage("assistant", "");
  const tools = new Map();
  let sawUpdate = false;

  try {
    const res = await fetch(
      `/api/v1/ai/conversations/${state.conversationId}/messages/stream`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // 与 common.js 的 api() 保持一致：有用户才带该头
          ...(getUserId() ? { "x-user-id": getUserId() } : {}),
        },
        body: JSON.stringify({ content }),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      let message = `HTTP ${res.status}`;
      try {
        message = JSON.parse(text).error?.message || message;
      } catch {
        /* 保持默认 */
      }
      bubble.remove();
      addMessage("error", `发送失败：${message}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handle = (raw) => {
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
          tools.set(payload.operationId, addToolLine(payload.toolName));
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
          sawUpdate = true;
          refreshResult();
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
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        handle(raw);
      }
    }
    if (buffer.trim()) handle(buffer);

    if (sawUpdate) await refreshResult();
  } catch (e) {
    addMessage("error", `连接中断：${e.message}`);
  } finally {
    state.streaming = false;
    $("chat-send").disabled = false;
    $("chat-input").focus();
    applyButtons();
  }
}

// ============================================================
// 初始化
// ============================================================

async function init() {
  await initUserPicker("admin");

  $("btn-start").addEventListener("click", startNew);
  $("btn-refresh").addEventListener("click", refreshResult);
  $("btn-commit").addEventListener("click", commitDraft);
  $("btn-publish").addEventListener("click", publish);

  $("chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("chat-input");
    const content = input.value.trim();
    if (!content) return;
    input.value = "";
    await sendMessage(content);
  });

  $("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("chat-form").requestSubmit();
    }
  });

  applyButtons();
}

init();
