/**
 * 问卷结构编辑器（人工拖拽 + 表单修改）。
 *
 * 依据决策 D3（人工编辑器必须做）与 docs/11-future-capability-plan.md 第 4.11 节。
 *
 * 三种进入方式（用 URL 参数区分）：
 *   editor.html                        空白模板 → 直接编辑
 *   editor.html?templateId=..&versionId=..   打开某个版本（draft 可编辑，其余只读）
 *
 * 为什么不引入拖拽库（SortableJS / X6 等）：
 *   前端是无构建链的原生 ES 模块（AGENT.md 第 7 节），
 *   库只能靠 CDN 引，体积大且风格要重做。
 *   而原生 HTML5 拖拽在**触屏上也是原生支持**的 —— 这一点很多 JS 库反而要额外处理。
 *
 * 与后端的分工（很重要）：
 *   order 一律由后端重算（03 文档第 21 节），前端只提交「期望的 id 顺序」。
 *   因此这里的拖拽逻辑只需要算清「新的 id 数组」，不需要自己维护 1..N 的序号 ——
 *   拖拽最容易写错的就是这个。
 */
import {
  $,
  api,
  button,
  clear,
  countSchema,
  el,
  initUserPicker,
  renderNav,
  toast,
} from "/common.js";
import { createNodeGraph } from "/editor-graph.js";

renderNav("editor");

// ============================================================
// 状态
// ============================================================

const state = {
  templateId: null,
  versionId: null,
  /** 版本状态：draft 可写，published / disabled 只读 */
  versionStatus: "draft",
  versionNo: 1,
  templateName: "",
  /** 结构真相；每次写操作后用后端返回的结构整体替换（后端是权威） */
  schema: null,
  /** 当前用户是否模板管理员（写操作需要） */
  isAdmin: false,
  /** 拖拽中的元素描述 */
  dragging: null,
  /** 乐观锁：模板草稿用 versionNo（见 questionnaire.service.ts） */
  revision: 1,
  /**
   * 预览接口返回的权威题目清单（含分组、题型、选项、分支摘要）。
   *
   * 为什么不自己从 state.schema 里算：分支编辑要拿「题型与选项」来决定
   * value 输入框长什么样，还要拿「不可达题目」做告警。
   * 这些判断与后端求值必须一致，能读权威数据就不要在前端再推导一遍。
   */
  questions: [],
  unreachable: [],
  /**
   * 视图模式：list = 列表（逐题检查）/ graph = 节点画布（看跳转关系）。
   *
   * 两种视图操作同一份数据（都落到后端的结构接口），
   * 因此不存在「两边不一致」的问题 —— 只是同一份结构的两种呈现。
   */
  viewMode: "list",
};

/** 节点画布实例（首次切到节点视图时才创建） */
let graphView = null;

/** 是否可编辑：草稿 + 模板管理员 */
function canEdit() {
  return state.versionStatus === "draft" && state.isAdmin;
}

/**
 * 载入「结构诊断」：权威题目清单 + 不可达题目 + 分支摘要。
 *
 * 失败不影响编辑主体（分支 UI 会退化为「不可用」而不是整页报错）——
 * 结构与分支是两件事，读不到分支信息也应能继续改题目。
 */
async function loadStructureDiagnostics() {
  if (!state.templateId || !state.versionId) return;
  try {
    const data = await api(
      "GET",
      `/api/v1/questionnaire-templates/${state.templateId}/versions/${state.versionId}/flow/structure`
    );
    state.questions = data.questions ?? [];
    state.unreachable = data.unreachable ?? [];
  } catch {
    state.questions = [];
    state.unreachable = [];
  }
}

/** questionId → 题目（含题型与选项，来自预览接口的权威清单） */
function questionById(id) {
  return state.questions.find((q) => q.id === id);
}

/**
 * 从结构里取出题目对象（含 branches / defaultNext 等完整字段）。
 *
 * 为什么不用 questionById：预览接口返回的清单是「摘要」，
 * 不含 branches 明细；而配置分支时必须读到完整规则。
 */
function findQuestion(id) {
  for (const section of state.schema?.sections ?? []) {
    const q = section.questions.find((x) => x.id === id);
    if (q) return q;
  }
  return null;
}

/** 题目标题（找不到时退回 id，便于排查） */
function questionTitle(id) {
  return questionById(id)?.title ?? `（已删除的题目 ${id}）`;
}

const QUESTION_TYPE_LABEL = {
  text: "单行文本",
  textarea: "多行文本",
  number: "数字",
  single_choice: "单选",
  multiple_choice: "多选",
  date: "日期",
  datetime: "日期时间",
  boolean: "是/否",
};

const CHOICE_TYPES = ["single_choice", "multiple_choice"];

/** 编辑器接口前缀（模板草稿版本目标） */
function apiBase() {
  return `/api/v1/questionnaire-templates/${state.templateId}/versions/${state.versionId}`;
}

// ============================================================
// 表单小工具
// ============================================================

/** 「标签 + 控件」的一行 */
function field(labelText, control) {
  const wrap = el("label", { className: "field" });
  wrap.appendChild(el("span", { text: labelText }));
  wrap.appendChild(control);
  return wrap;
}

function textInput(value, placeholder = "") {
  const input = el("input", { attrs: { placeholder } });
  input.value = value ?? "";
  return input;
}

function textArea(value, rows = 3, placeholder = "") {
  const area = el("textarea", { attrs: { rows: String(rows), placeholder } });
  area.value = value ?? "";
  return area;
}

function select(entries, selected) {
  const sel = el("select");
  for (const [value, label] of entries) {
    const opt = el("option", { attrs: { value }, text: label });
    sel.appendChild(opt);
  }
  sel.value = selected;
  return sel;
}

/**
 * 通用表单弹窗，返回字段值的对象（取消返回 null）。
 *
 * spec: [{ key, label, type: "text"|"textarea"|"select"|"checkbox", ... }]
 * 与 common.js 的 askText 保持同一套弹窗结构与键盘行为。
 */
function formModal({ title, spec, initial = {}, okText = "保存" }) {
  return new Promise((resolve) => {
    const backdrop = el("div", { className: "modal-backdrop" });
    const modal = el("div", { className: "modal" });

    const head = el("div", { className: "modal-head" });
    head.appendChild(el("h3", { text: title }));
    modal.appendChild(head);

    const body = el("div", { className: "modal-body" });
    const controls = new Map();

    for (const f of spec) {
      let control;
      if (f.type === "textarea") {
        control = textArea(initial[f.key] ?? "", f.rows ?? 3, f.placeholder);
      } else if (f.type === "select") {
        control = select(f.options, initial[f.key] ?? f.options[0][0]);
      } else if (f.type === "checkbox") {
        control = el("input", { attrs: { type: "checkbox" } });
        control.checked = Boolean(initial[f.key]);
        // 复选框的 label 放在右边更自然
        const wrap = el("label", { className: "field field-inline" });
        wrap.appendChild(el("span", { text: f.label }));
        wrap.appendChild(control);
        body.appendChild(wrap);
        controls.set(f.key, control);
        continue;
      } else {
        control = textInput(initial[f.key] ?? "", f.placeholder);
      }
      body.appendChild(field(f.label, control));
      controls.set(f.key, control);
    }

    if (spec.some((f) => f.type === "select" && f.hint)) {
      const hint = spec.find((f) => f.type === "select" && f.hint);
      body.appendChild(el("p", { className: "hint", text: hint.hint }));
    }

    modal.appendChild(body);

    const footer = el("div", { className: "modal-foot" });
    const cancel = button("取消");
    const ok = button(okText, { className: "btn btn-primary" });
    footer.appendChild(cancel);
    footer.appendChild(ok);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const firstText = spec.find((f) => f.type === "text" || f.type === "textarea");
    const firstControl = firstText ? controls.get(firstText.key) : null;
    if (firstControl) {
      firstControl.focus();
      firstControl.select?.();
    }

    const close = (result) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };

    const readValues = () => {
      const out = {};
      for (const [key, control] of controls) {
        if (control.type === "checkbox") out[key] = control.checked;
        else out[key] = control.value.trim();
      }
      return out;
    };

    // Ctrl/Cmd+Enter 提交（多行文本里 Enter 要留给换行）
    const onKey = (e) => {
      if (e.key === "Escape") close(null);
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        close(readValues());
      }
    };

    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click", () => close(readValues()));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(null);
    });
    document.addEventListener("keydown", onKey);
  });
}

/**
 * 选项编辑器：在一个弹窗里维护「选项列表」。
 *
 * 单独做而不是塞进 formModal：选项是**可变长度的列表**，
 * 每行两个输入框 + 删除按钮，还可能要拖动排序。
 */
function optionsModal({ title, options }) {
  return new Promise((resolve) => {
    const backdrop = el("div", { className: "modal-backdrop" });
    const modal = el("div", { className: "modal" });

    const head = el("div", { className: "modal-head" });
    head.appendChild(el("h3", { text: title }));
    modal.appendChild(head);

    const body = el("div", { className: "modal-body" });
    body.appendChild(
      el("p", {
        className: "hint",
        text: "至少 2 个选项；选项内容不能重复。顺序即展示顺序。",
      })
    );

    const list = el("div", { className: "opt-list" });
    body.appendChild(list);

    // 工作副本：确认前不改动外部数据
    const rows = options.map((o) => ({ label: o.label, value: o.value }));

    function renderRows() {
      clear(list);
      rows.forEach((row, index) => {
        const line = el("div", { className: "opt-row" });

        const labelInput = textInput(row.label, "选项内容");
        labelInput.addEventListener("input", () => {
          row.label = labelInput.value;
        });
        line.appendChild(labelInput);

        const up = button("↑", { className: "btn-ghost btn-sm" });
        up.disabled = index === 0;
        up.addEventListener("click", () => {
          const [moved] = rows.splice(index, 1);
          rows.splice(index - 1, 0, moved);
          renderRows();
        });
        line.appendChild(up);

        const down = button("↓", { className: "btn-ghost btn-sm" });
        down.disabled = index === rows.length - 1;
        down.addEventListener("click", () => {
          const [moved] = rows.splice(index, 1);
          rows.splice(index + 1, 0, moved);
          renderRows();
        });
        line.appendChild(down);

        const del = button("删除", { className: "btn-ghost danger btn-sm" });
        del.addEventListener("click", () => {
          rows.splice(index, 1);
          renderRows();
        });
        line.appendChild(del);

        list.appendChild(line);
      });
    }

    renderRows();

    const add = button("+ 添加选项");
    add.addEventListener("click", () => {
      rows.push({ label: "", value: "" });
      renderRows();
    });
    body.appendChild(add);

    modal.appendChild(body);

    const footer = el("div", { className: "modal-foot" });
    const cancel = button("取消");
    const ok = button("确定", { className: "btn btn-primary" });
    footer.appendChild(cancel);
    footer.appendChild(ok);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = (result) => {
      backdrop.remove();
      resolve(result);
    };

    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click", () => {
      const cleaned = rows
        .map((r) => ({ label: r.label.trim(), value: (r.value || r.label).trim() }))
        .filter((r) => r.label !== "");

      if (cleaned.length < 2) {
        toast("至少需要 2 个非空选项", true);
        return;
      }
      if (new Set(cleaned.map((r) => r.label)).size !== cleaned.length) {
        toast("选项内容不能重复", true);
        return;
      }
      close(cleaned);
    });
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(null);
    });
  });
}

// ============================================================
// 写操作（统一走这里，处理乐观锁与错误提示）
// ============================================================

/**
 * 调一次编辑接口，并用返回的结构整体替换本地状态。
 *
 * 为什么要「整体替换」而不是本地打补丁：
 *   后端会重算 order、生成 id，返回的才是权威结构。
 *   本地补丁一旦与后端不一致，后续拖拽就会算出错误的 id 顺序。
 *
 * 关于 expectedRevision 放在哪里：
 *   普通写操作放在**请求体**；删除分组放在 **query** ——
 *   后端就是这么读的（DELETE 带 body 在部分客户端/代理上会被丢掉，
 *   见 editor.controller.ts 的 removeSectionQuery）。放错位置的后果是
 *   乐观锁**被静默跳过**，不报错，所以这里要按方法区分。
 */
async function callApi(method, path, body, { revisionInQuery = false } = {}) {
  let payload;
  let finalPath = path;

  if (revisionInQuery) {
    finalPath = `${path}?expectedRevision=${encodeURIComponent(state.revision)}`;
  } else if (body !== undefined) {
    payload = { ...body, expectedRevision: state.revision };
  }

  try {
    const data = await api(method, `${apiBase()}${finalPath}`, payload);
    await reloadSchema();
    return data;
  } catch (e) {
    if (e.code === "REVISION_CONFLICT") {
      toast("这个版本刚被别处改过，已重新载入。请确认后重试。", true);
      await reloadSchema();
    } else if (e.code === "PERMISSION_DENIED") {
      toast(
        state.versionStatus !== "draft"
          ? "已发布的版本不能修改。请先新建一个草稿版本。"
          : "修改模板需要「模板管理员」账号，请在右上角切换用户。",
        true
      );
    } else {
      toast(e.message || "操作失败", true);
    }
    return null;
  }
}

// ============================================================
// 渲染：结构画布
// ============================================================

function render() {
  const badge = $("editor-status");
  if (badge) {
    badge.textContent =
      state.versionStatus === "draft"
        ? `草稿 v${state.versionNo}`
        : `v${state.versionNo} · ${
            state.versionStatus === "published" ? "已发布（只读）" : "已停用（只读）"
          }`;
    badge.className =
      state.versionStatus === "draft" ? "badge warn" : "badge ok";
  }

  const title = $("editor-title");
  if (title) title.textContent = state.templateName || "问卷编辑器";

  renderReadonlyHint();
  renderViews();
  renderSidebar();
  renderStats();
}

/**
 * 按当前视图渲染。
 *
 * 两种视图操作的是同一份数据（都走后端结构接口），
 * 所以切换视图不需要重新拉取，只是换一种呈现。
 */
function renderViews() {
  const listBox = $("editor-canvas");
  const graphBox = $("editor-graph");
  const toGraph = state.viewMode === "graph";

  listBox.hidden = toGraph;
  graphBox.hidden = !toGraph;

  const toggle = $("view-toggle");
  if (toggle) {
    for (const btn of toggle.querySelectorAll("button")) {
      btn.classList.toggle("active", btn.dataset.view === state.viewMode);
    }
  }

  if (toGraph) {
    ensureGraph();
    // 画布是懒创建的：第一次切过来时容器刚显示，尺寸才有效
    graphView.render();
    graphView.fit();
  } else {
    renderCanvas();
  }
}

/** 懒创建节点画布实例 */
function ensureGraph() {
  if (graphView) return;

  graphView = createNodeGraph({
    host: $("editor-graph"),
    getSchema: () => state.schema,
    getUnreachable: () => state.unreachable,
    canEdit,
    onEditQuestion: (id) => {
      const q = findQuestion(id);
      if (q) editQuestion(q);
    },
    onBranchEdit: (id, prefillGoTo) => openBranchEditor(id, { prefillGoTo }),
    onToast: toast,
    saveLayout: saveNodeLayout,
  });
}

/**
 * 保存节点坐标。
 *
 * 注意这是**只写 layout 键**的接口（见后端 mergeTemplateVersionLayout），
 * 因此它不会碰结构、不产生审计，也不会与别人正在做的结构编辑互相覆盖。
 */
async function saveNodeLayout(positions) {
  await api(
    "PATCH",
    `/api/v1/questionnaire-templates/${state.templateId}/versions/${state.versionId}/layout`,
    { positions }
  );

  // 同步进本地 schema：否则下一次重绘会从 schema.layout 读旧坐标，
  // 节点看起来「弹回去」（画布内部还有一层本次会话的影子坐标兜底，
  // 但把它写进 schema 才是根本解）。
  state.schema.layout = { ...(state.schema.layout ?? {}), ...positions };
}

/** 切换视图（切换前先把未落盘的坐标存掉） */
async function switchView(next) {
  if (next === state.viewMode) return;

  if (graphView) await graphView.flush();

  state.viewMode = next;
  renderViews();
}

/** 只读原因提示（非草稿 / 非管理员） */
function renderReadonlyHint() {
  const box = $("editor-hint");
  if (!box) return;
  clear(box);

  if (state.versionStatus !== "draft") {
    box.appendChild(
      el("span", {
        text:
          state.versionStatus === "published"
            ? "这是已发布版本，结构不可修改。"
            : "这是已停用版本，结构不可修改。",
      })
    );
    const copy = button("基于它新建草稿版本", { className: "btn btn-sm btn-primary" });
    copy.addEventListener("click", createDraftFromCurrent);
    box.appendChild(copy);
    box.hidden = false;
    return;
  }

  if (!state.isAdmin) {
    box.appendChild(
      el("span", { text: "当前账号不是模板管理员，只能查看。修改请在右上角切换到 admin。" })
    );
    box.hidden = false;
    return;
  }

  box.hidden = true;
}

/** 主画布：分组 + 问题 */
function renderCanvas() {
  const canvas = $("editor-canvas");
  clear(canvas);

  const sections = state.schema?.sections ?? [];
  const editable = canEdit();

  if (sections.length === 0) {
    const empty = el("div", { className: "editor-empty" });
    empty.appendChild(el("p", { text: "这份问卷还是空的。" }));
    if (editable) {
      const add = button("+ 添加第一个分组", { className: "btn btn-primary" });
      add.addEventListener("click", addSection);
      empty.appendChild(add);
    }
    canvas.appendChild(empty);
    return;
  }

  sections.forEach((section, index) => {
    canvas.appendChild(renderSectionCard(section, index, editable));
  });

  if (editable) {
    const add = button("+ 添加分组", { className: "btn btn-sm" });
    add.addEventListener("click", addSection);
    const wrap = el("div", { className: "editor-add-section" });
    wrap.appendChild(add);
    // 允许把分组拖到这根「尾巴」上以放到最后
    wrap.addEventListener("dragover", (e) => {
      if (state.dragging?.kind === "section") e.preventDefault();
    });
    wrap.addEventListener("drop", (e) => {
      if (state.dragging?.kind !== "section") return;
      e.preventDefault();
      moveSectionTo(state.dragging.id, state.schema.sections.length);
    });
    canvas.appendChild(wrap);
  }
}

/** 一个分组卡片 */
function renderSectionCard(section, index, editable) {
  const card = el("div", { className: "sec-card" });
  card.dataset.sectionId = section.id;

  // ---- 头部：拖拽手柄 + 标题 + 操作 ----
  const head = el("div", { className: "sec-head" });

  if (editable) {
    const handle = el("span", { className: "drag-handle", text: "⠿" });
    handle.title = "拖动调整分组顺序";
    handle.draggable = true;
    handle.addEventListener("dragstart", (e) => {
      state.dragging = { kind: "section", id: section.id };
      e.dataTransfer.effectAllowed = "move";
      // Firefox 需要设置数据，否则不触发 drop
      e.dataTransfer.setData("text/plain", section.id);
      card.classList.add("dragging");
    });
    handle.addEventListener("dragend", () => {
      state.dragging = null;
      card.classList.remove("dragging");
      clearDropMarks();
    });
    head.appendChild(handle);
  }

  const titleWrap = el("div", { className: "sec-title" });
  titleWrap.appendChild(
    el("span", { className: "sec-index", text: `${index + 1}` })
  );
  titleWrap.appendChild(el("span", { text: section.title }));
  titleWrap.appendChild(
    el("span", {
      className: "hint",
      text: `${(section.questions ?? []).length} 道题`,
    })
  );
  head.appendChild(titleWrap);

  const actions = el("div", { className: "sec-actions" });
  if (editable) {
    const addQ = button("+ 题目", { className: "btn-ghost btn-sm" });
    addQ.addEventListener("click", () => addQuestion(section.id));
    actions.appendChild(addQ);

    const rename = button("改名", { className: "btn-ghost btn-sm" });
    rename.addEventListener("click", () => renameSection(section));
    actions.appendChild(rename);

    const del = button("删除分组", { className: "btn-ghost danger btn-sm" });
    del.addEventListener("click", () => removeSection(section));
    actions.appendChild(del);
  }
  head.appendChild(actions);
  card.appendChild(head);

  // ---- 分组拖放区（用于分组排序） ----
  if (editable) {
    card.addEventListener("dragover", (e) => {
      if (state.dragging?.kind !== "section") return;
      e.preventDefault();
      const rect = card.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      card.classList.toggle("drop-before", before);
      card.classList.toggle("drop-after", !before);
    });
    card.addEventListener("dragleave", () => {
      card.classList.remove("drop-before", "drop-after");
    });
    card.addEventListener("drop", (e) => {
      if (state.dragging?.kind !== "section") return;
      e.preventDefault();
      const rect = card.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      clearDropMarks();
      moveSectionTo(state.dragging.id, before ? index : index + 1);
    });
  }

  // ---- 问题列表 ----
  const qList = el("div", { className: "q-list" });
  const questions = section.questions ?? [];

  if (questions.length === 0) {
    qList.appendChild(
      el("p", { className: "hint q-empty", text: "这个分组还没有题目。" })
    );
  }

  questions.forEach((q, qi) => {
    qList.appendChild(renderQuestionRow(section, q, qi, editable));
  });

  // 允许把题目拖到分组空白处 → 追加到该组末尾
  if (editable) {
    qList.addEventListener("dragover", (e) => {
      if (state.dragging?.kind === "question") e.preventDefault();
    });
    qList.addEventListener("drop", (e) => {
      if (state.dragging?.kind !== "question") return;
      e.preventDefault();
      // 落到具体题目行时由该行处理（stopPropagation），
      // 能走到这里说明落在空白处 → 追加到末尾
      dropQuestionOnSection(state.dragging.id, section.id, questions.length);
    });
  }

  card.appendChild(qList);
  return card;
}

/** 一道题的卡片 */
function renderQuestionRow(section, q, index, editable) {
  const row = el("div", { className: "q-card" });
  row.dataset.questionId = q.id;

  if (editable) {
    const handle = el("span", { className: "drag-handle", text: "⠿" });
    handle.title = "拖动调整题目顺序（可跨分组）";
    handle.draggable = true;
    handle.addEventListener("dragstart", (e) => {
      state.dragging = {
        kind: "question",
        id: q.id,
        fromSectionId: section.id,
        fromIndex: index,
      };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", q.id);
      row.classList.add("dragging");
    });
    handle.addEventListener("dragend", () => {
      state.dragging = null;
      row.classList.remove("dragging");
      clearDropMarks();
    });
    row.appendChild(handle);
  }

  const main = el("div", { className: "q-main" });
  const line1 = el("div", { className: "q-line1" });
  line1.appendChild(el("span", { className: "q-index", text: `${index + 1}` }));
  line1.appendChild(el("span", { className: "q-title", text: q.title }));
  line1.appendChild(
    el("span", {
      className: "tag",
      text: QUESTION_TYPE_LABEL[q.type] ?? q.type,
    })
  );
  if (q.required) line1.appendChild(el("span", { className: "tag required", text: "必填" }));
  main.appendChild(line1);

  if (q.description) {
    main.appendChild(el("div", { className: "hint", text: q.description }));
  }
  if (CHOICE_TYPES.includes(q.type) && (q.options ?? []).length > 0) {
    main.appendChild(
      el("div", {
        className: "hint",
        text: `选项：${q.options.map((o) => o.label).join(" / ")}`,
      })
    );
  }

  // 分支摘要必须显示在题目上：只靠一个「设分支」按钮的话，
  // 看结构的人不知道这一题会不会跳走、会跳过谁 —— 那恰恰是分支最容易出错的地方。
  const summary = renderBranchSummary(q);
  if (summary) main.appendChild(summary);

  row.appendChild(main);

  const actions = el("div", { className: "q-actions" });
  if (editable) {
    const branchBtn = button(hasBranch(q) ? "改分支" : "设分支", {
      className: "btn-ghost btn-sm",
    });
    branchBtn.addEventListener("click", () => openBranchEditor(q.id));
    actions.appendChild(branchBtn);

    const edit = button("编辑", { className: "btn-ghost btn-sm" });
    edit.addEventListener("click", () => editQuestion(q));
    actions.appendChild(edit);

    const del = button("删除", { className: "btn-ghost danger btn-sm" });
    del.addEventListener("click", () => removeQuestion(q));
    actions.appendChild(del);
  }
  row.appendChild(actions);

  if (editable) {
    row.addEventListener("dragover", (e) => {
      if (state.dragging?.kind !== "question") return;
      // 阻止冒泡，否则会走到分组的「追加到末尾」
      e.stopPropagation();
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      row.classList.toggle("drop-before", before);
      row.classList.toggle("drop-after", !before);
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("drop-before", "drop-after");
    });
    row.addEventListener("drop", (e) => {
      if (state.dragging?.kind !== "question") return;
      e.stopPropagation();
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      clearDropMarks();
      const targetIndex = before ? index : index + 1;
      dropQuestionOnSection(state.dragging.id, section.id, targetIndex);
    });
  }

  return row;
}

function clearDropMarks() {
  for (const node of document.querySelectorAll(
    ".drop-before, .drop-after"
  )) {
    node.classList.remove("drop-before", "drop-after");
  }
}

// ============================================================
// 侧栏与统计
// ============================================================

function renderSidebar() {
  const box = $("editor-side");
  clear(box);

  box.appendChild(
    el("p", {
      className: "hint",
      text:
        state.viewMode === "graph"
          ? canEdit()
            ? "拖动节点调整位置；按住节点下方的圆点拖到另一个节点，即可为它建一条分支；双击节点编辑内容；滚轮缩放、空白处拖动平移。"
            : "当前为只读视图。节点位置、顺序边与分支边都可以看，但不能修改。"
          : canEdit()
            ? "拖动左侧的 ⠿ 手柄可以调整分组与题目的顺序；点「编辑」改内容，点「设分支」配条件跳题。"
            : "当前为只读视图。",
    })
  );

  // ---- 节点视图的画布操作 ----
  if (state.viewMode === "graph") {
    const ops = el("div", { className: "editor-side-block graph-ops" });

    const fitBtn = button("适配视图", { className: "btn btn-sm" });
    fitBtn.addEventListener("click", () => graphView?.fit());
    ops.appendChild(fitBtn);

    if (canEdit()) {
      const autoBtn = button("重新排布", { className: "btn btn-sm" });
      autoBtn.addEventListener("click", async () => {
        if (!window.confirm("按分组与题序重新排列所有节点，会覆盖手动摆的位置。继续？")) {
          return;
        }
        await graphView?.autoLayout();
        await loadStructureDiagnostics();
        render();
      });
      ops.appendChild(autoBtn);
    }

    box.appendChild(ops);

    const legend = el("div", { className: "editor-side-block graph-legend" });
    for (const [cls, label] of [
      ["edge-order", "顺序（按题序走下一题）"],
      ["edge-branch", "分支（命中条件才跳）"],
      ["edge-end", "结束（本题即终点）"],
    ]) {
      const row = el("div", { className: "legend-row" });
      row.appendChild(el("span", { className: `legend-line ${cls}` }));
      row.appendChild(el("span", { text: label, className: "hint" }));
      legend.appendChild(row);
    }
    box.appendChild(legend);
  }

  if (canEdit()) {
    const addTop = button("+ 添加分组", { className: "btn btn-sm" });
    addTop.addEventListener("click", addSection);
    box.appendChild(addTop);
  }

  // ---- 结构诊断：不可达题目 ----
  //
  // 这是「只读 DAG 预览」里最有价值的一项：不可达的题目意味着
  // 有题目永远不会被任何人看到，而这在列表视图里**完全看不出来**。
  // 后端只把它当告警（编辑中间态常见），因此这里也只提示、不阻断。
  if (state.unreachable.length > 0) {
    const warn = el("div", { className: "editor-warn" });
    warn.appendChild(
      el("div", {
        className: "editor-warn-title",
        text: `⚠ ${state.unreachable.length} 道题从第一题出发走不到`,
      })
    );
    warn.appendChild(
      el("p", {
        className: "hint",
        text: "这些题目永远不会被任何人看到。检查一下是不是某条分支把它们整段跳过了。",
      })
    );
    for (const id of state.unreachable) {
      warn.appendChild(el("div", { className: "branch-line", text: `· ${questionTitle(id)}` }));
    }
    // 点一下能定位到该题（滚动过去并高亮）
    warn.addEventListener("click", () => {
      const first = state.unreachable[0];
      if (!first) return;
      const node = document.querySelector(`[data-question-id="${first}"]`);
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.classList.add("q-card-flash");
        setTimeout(() => node.classList.remove("q-card-flash"), 1600);
      }
    });
    box.appendChild(warn);
  }

  // ---- 分支概况 ----
  const branching = state.questions.filter((x) => hasBranch(x));
  if (state.questions.length > 0) {
    const info = el("div", { className: "editor-side-block" });
    const withDefaultEnd = state.questions.filter(
      (x) => x.defaultNext === null
    ).length;
    info.appendChild(
      el("p", {
        className: "hint",
        text:
          branching.length === 0
            ? "这份问卷还没有任何分支，所有人都会答完所有题。"
            : `${branching.length} 道题带分支${withDefaultEnd > 0 ? `，其中 ${withDefaultEnd} 道声明了终点` : ""}。`,
      })
    );
    box.appendChild(info);
  }

  if (state.versionId) {
    const link = el("a", {
      className: "btn btn-sm",
      text: "在模板管理页打开",
      attrs: {
        href: `/templates.html?templateId=${encodeURIComponent(state.templateId)}`,
      },
    });
    box.appendChild(link);
  }
}

function renderStats() {
  const box = $("editor-stats");
  if (!box || !state.schema) return;
  clear(box);

  const { sections, questions } = countSchema(state.schema);
  const rows = [
    ["分组数", String(sections)],
    ["题目数", String(questions)],
    ["版本", `v${state.versionNo}`],
    ["状态", state.versionStatus],
  ];
  for (const [k, v] of rows) {
    box.appendChild(el("div", { className: "meta-key", text: k }));
    box.appendChild(el("div", { className: "meta-val", text: v }));
  }
}

// ============================================================
// 编辑动作
// ============================================================

async function addSection() {
  const values = await formModal({
    title: "添加分组",
    okText: "添加",
    spec: [
      { key: "title", label: "分组名称", type: "text", placeholder: "例如：基本信息" },
      { key: "description", label: "分组说明（可留空）", type: "textarea", rows: 2 },
    ],
  });
  if (!values || !values.title) return;

  await callApi("POST", "/sections", {
    title: values.title,
    ...(values.description ? { description: values.description } : {}),
  });
  toast("已添加分组");
}

async function renameSection(section) {
  const values = await formModal({
    title: "修改分组",
    initial: { title: section.title, description: section.description ?? "" },
    spec: [
      { key: "title", label: "分组名称", type: "text" },
      { key: "description", label: "分组说明（可留空）", type: "textarea", rows: 2 },
    ],
  });
  if (!values || !values.title) return;

  await callApi("PATCH", `/sections/${encodeURIComponent(section.id)}`, {
    title: values.title,
    ...(values.description ? { description: values.description } : {}),
  });
  toast("已保存分组");
}

async function removeSection(section) {
  const count = (section.questions ?? []).length;
  const ok = window.confirm(
    `确定删除分组「${section.title}」？\n\n` +
      (count > 0
        ? `组内 ${count} 道题会一并删除，且无法撤销。`
        : "该分组还没有题目。")
  );
  if (!ok) return;

  await callApi("DELETE", `/sections/${encodeURIComponent(section.id)}`, undefined, {
    revisionInQuery: true,
  });
  toast("已删除分组");
}

async function addQuestion(sectionId) {
  const values = await formModal({
    title: "添加题目",
    okText: "添加",
    spec: [
      { key: "title", label: "题干", type: "text", placeholder: "例如：是否拥有无人机？" },
      {
        key: "type",
        label: "题型",
        type: "select",
        options: Object.entries(QUESTION_TYPE_LABEL),
      },
      { key: "description", label: "题目说明（可留空）", type: "textarea", rows: 2 },
      { key: "required", label: "必填", type: "checkbox" },
    ],
  });
  if (!values || !values.title) return;

  const payload = {
    sectionId,
    type: values.type,
    title: values.title,
    required: values.required,
    ...(values.description ? { description: values.description } : {}),
  };

  // 选择题必须先有选项，否则后端会以 INVALID_OPTIONS 拒绝 ——
  // 这里先让用户填，省掉一次「提交失败再补」的往返
  if (CHOICE_TYPES.includes(values.type)) {
    const options = await optionsModal({
      title: "设置选项",
      options: [
        { label: "", value: "" },
        { label: "", value: "" },
      ],
    });
    if (!options) return;
    payload.options = options;
  }

  await callApi("POST", "/questions", payload);
  toast("已添加题目");
}

async function editQuestion(q) {
  const values = await formModal({
    title: "编辑题目",
    initial: {
      title: q.title,
      type: q.type,
      description: q.description ?? "",
      required: Boolean(q.required),
    },
    spec: [
      { key: "title", label: "题干", type: "text" },
      {
        key: "type",
        label: "题型",
        type: "select",
        options: Object.entries(QUESTION_TYPE_LABEL),
        hint: "换成选择题需要设置选项；从选择题换成其他题型会丢弃现有选项。",
      },
      { key: "description", label: "题目说明（可留空）", type: "textarea", rows: 2 },
      { key: "required", label: "必填", type: "checkbox" },
    ],
  });
  if (!values || !values.title) return;

  const payload = {
    title: values.title,
    type: values.type,
    required: values.required,
    description: values.description || null,
  };

  if (CHOICE_TYPES.includes(values.type)) {
    const existing = (q.options ?? []).map((o) => ({
      label: o.label,
      value: o.value,
    }));
    const options = await optionsModal({
      title: "设置选项",
      options: existing.length >= 2 ? existing : [{ label: "", value: "" }, { label: "", value: "" }],
    });
    if (!options) return;
    payload.options = options;
  }

  await callApi("PATCH", `/questions/${encodeURIComponent(q.id)}`, payload);
  toast("已保存题目");
}

async function removeQuestion(q) {
  const ok = window.confirm(`确定删除题目「${q.title}」？`);
  if (!ok) return;
  await callApi("DELETE", `/questions/${encodeURIComponent(q.id)}`);
  toast("已删除题目");
}

// ============================================================
// 分支配置（决策 D16）
// ============================================================

const OPERATOR_LABEL = {
  eq: "等于",
  ne: "不等于",
  in: "属于（任一）",
  not_in: "不属于（全部都不是）",
  is_answered: "已作答",
  is_empty: "未作答",
};

/** 不需要 value 的操作符 */
const VALUELESS_OPERATORS = ["is_answered", "is_empty"];
/** 需要「集合」形态 value 的操作符 */
const SET_OPERATORS = ["in", "not_in"];

function hasBranch(q) {
  return (q.branches?.length ?? 0) > 0 || q.defaultNext !== undefined;
}

/** 把一条规则的 value 渲染成人话 */
function describeValue(rule) {
  const { op, questionId, value } = rule.when;
  const target = questionById(questionId);

  if (VALUELESS_OPERATORS.includes(op)) return "";

  if (Array.isArray(value)) {
    const labels = value.map((v) => {
      const opt = target?.options?.find((o) => o.id === String(v));
      return opt ? opt.label : String(v);
    });
    return `「${labels.join(" / ")}」`;
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  const opt = target?.options?.find((o) => o.id === String(value));
  return `「${opt ? opt.label : String(value)}」`;
}

/**
 * 题目的分支摘要（显示在题目行内）。
 *
 * 目的：让「读完这份问卷」不必逐题点开 ——
 * 分支跳错是**在数据里很难发现**的那类问题，因此结构视图必须自己讲清楚。
 */
function renderBranchSummary(q) {
  if (!hasBranch(q)) return null;

  const box = el("div", { className: "q-branch-summary" });

  for (const rule of q.branches ?? []) {
    const line = el("div", { className: "branch-line" });
    line.appendChild(el("span", { className: "branch-if", text: "如果" }));
    line.appendChild(
      el("span", { text: `「${questionTitle(rule.when.questionId)}」` })
    );
    line.appendChild(
      el("span", {
        className: "branch-op",
        text: `${OPERATOR_LABEL[rule.when.op] ?? rule.when.op} ${describeValue(rule)}`.trim(),
      })
    );
    line.appendChild(el("span", { className: "branch-arrow", text: "→ 跳到" }));
    line.appendChild(el("span", { text: `「${questionTitle(rule.goTo)}」` }));
    box.appendChild(line);
  }

  const fallback = el("div", { className: "branch-line fallback" });
  if (q.defaultNext === null) {
    fallback.appendChild(el("span", { text: "否则：本题作答后问卷结束" }));
  } else if (typeof q.defaultNext === "string") {
    fallback.appendChild(el("span", { text: "否则：跳到" }));
    fallback.appendChild(el("span", { text: `「${questionTitle(q.defaultNext)}」` }));
  } else {
    fallback.appendChild(el("span", { text: "否则：按题目顺序继续" }));
  }
  box.appendChild(fallback);

  return box;
}

/**
 * 根据被引用题目的题型，构造合适的 value 输入控件。
 *
 * 这一步必须有：比较值的类型必须与题型相容，否则后端会以
 * 「是非题的 value 必须是 true/false」这类错误拒绝。
 * 让用户手输 JSON 是做不到这一点的。
 */
function makeValueControl(question, op, initial) {
  // 不需要 value
  if (VALUELESS_OPERATORS.includes(op)) return null;

  // 多选题 + in/not_in → 多选
  if (question && SET_OPERATORS.includes(op)) {
    const wrap = el("div", { className: "branch-value-set" });
    const chosen = new Set(
      Array.isArray(initial) ? initial.map((v) => String(v)) : []
    );
    for (const opt of question.options ?? []) {
      const id = `val_${opt.id}`;
      const box = el("input", { attrs: { type: "checkbox", id } });
      box.checked = chosen.has(opt.id);
      box.addEventListener("change", () => {
        if (box.checked) chosen.add(opt.id);
        else chosen.delete(opt.id);
      });
      const label = el("label", { className: "inline-check" });
      label.appendChild(box);
      label.appendChild(el("span", { text: opt.label }));
      wrap.appendChild(label);
    }
    return {
      node: wrap,
      read: () => [...chosen],
      hint: "勾选任意一个命中即算命中（属于）；不属于则要求一个都不包含",
    };
  }

  // 是非题 → 是/否
  if (question?.type === "boolean") {
    const sel = select(
      [
        ["true", "是"],
        ["false", "否"],
      ],
      String(initial ?? true)
    );
    return { node: sel, read: () => sel.value === "true" };
  }

  // 单选 → 选项下拉
  if (question?.type === "single_choice" && (question.options ?? []).length > 0) {
    const entries = question.options.map((o) => [o.id, o.label]);
    const sel = select(entries, String(initial ?? entries[0][0]));
    return { node: sel, read: () => sel.value };
  }

  // 数字 → 数字输入
  if (question?.type === "number") {
    const input = el("input", { attrs: { type: "number" } });
    input.value = initial === undefined ? "" : String(initial);
    return { node: input, read: () => Number(input.value) };
  }

  // 其余（文本/日期）→ 文本输入
  const input = textInput(initial === undefined ? "" : String(initial), "比较值");
  return { node: input, read: () => input.value.trim() };
}

/**
 * 分支编辑弹窗：一个题目一个弹窗，整体替换该题的分支。
 *
 * 为什么是「整体替换」的交互而不是增量增删：
 *   后端接口就是整体替换语义（set_question_branch），
 *   这样「用户在界面上看到的规则」与「存进去的规则」严格一致，
 *   不会出现「删了一条但顺序错了」这类问题。
 */
/**
 * 分支配置弹窗。
 *
 * @param {string} questionId 要配置的题目
 * @param {{prefillGoTo?: string}} options
 *   prefillGoTo：从画布拖线到某个节点时传入，弹窗会预置一条指向它的规则。
 *   为什么不直接建一条「默认条件」的规则：条件决定行为，
 *   猜一个（比如 eq 本题 = 第一项）会让用户以为配好了，
 *   实际跳转逻辑是错的。宁可多一步，让人明确选条件。
 */
function openBranchEditor(questionId, options = {}) {
  const q = findQuestion(questionId);
  if (!q) {
    toast("题目已不存在，请刷新后重试", true);
    return;
  }
  const others = state.questions.filter((x) => x.id !== q.id);

  if (others.length === 0) {
    toast("还没有别的题目可以作为跳转目标，先加几道题吧", true);
    return;
  }

  // 工作副本：确认前不动 state
  const rules = (q.branches ?? []).map((r) => ({
    op: r.when.op,
    questionId: r.when.questionId,
    value: r.when.value,
    goTo: r.goTo,
  }));

  // 从画布拖线过来时，预置一条指向目标的规则（条件留空，由用户选）
  if (options.prefillGoTo && !rules.some((r) => r.goTo === options.prefillGoTo)) {
    rules.push({
      op: "eq",
      questionId: q.id,
      value: undefined,
      goTo: options.prefillGoTo,
    });
  }
  let defaultNext = q.defaultNext;

  const backdrop = el("div", { className: "modal-backdrop" });
  const modal = el("div", { className: "modal" });

  const head = el("div", { className: "modal-head" });
  head.appendChild(el("h3", { text: `分支设置：${q.title}` }));
  modal.appendChild(head);

  const body = el("div", { className: "modal-body" });
  body.appendChild(
    el("p", {
      className: "hint",
      text:
        "按顺序取**第一条命中**的规则；都不命中时看下方的「否则」。\n" +
        "条件可以引用本题自己 —— 这正是「按本题答案决定是否跳过本题」的常用写法。",
    })
  );

  const ruleList = el("div", { className: "branch-rule-list" });
  body.appendChild(ruleList);

  /** 重画规则行（每行的控件都随「引用题目 + 操作符」联动） */
  function renderRules() {
    clear(ruleList);

    if (rules.length === 0) {
      ruleList.appendChild(
        el("p", { className: "hint", text: "还没有条件。点下面「添加条件」。" })
      );
    }

    rules.forEach((rule, index) => {
      const row = el("div", { className: "branch-rule-row" });

      row.appendChild(el("span", { className: "branch-rule-index", text: `${index + 1}` }));
      row.appendChild(el("span", { className: "branch-if", text: "如果" }));

      // 引用哪一题（含本题自己）
      const qEntries = [
        [q.id, `${q.title}（本题）`],
        ...others.map((x) => [x.id, `${x.sectionTitle} / ${x.title}`]),
      ];
      const qSel = select(qEntries, rule.questionId || q.id);
      qSel.addEventListener("change", () => {
        rule.questionId = qSel.value;
        rule.value = undefined; // 换了被引用题目，旧值可能不再合法
        renderRules();
      });
      row.appendChild(qSel);

      // 操作符
      const opSel = select(
        Object.entries(OPERATOR_LABEL),
        rule.op
      );
      opSel.addEventListener("change", () => {
        rule.op = opSel.value;
        rule.value = undefined;
        renderRules();
      });
      row.appendChild(opSel);

      // 比较值（随题型与操作符变化）
      const target = questionById(rule.questionId || q.id);
      const control = makeValueControl(target, rule.op, rule.value);
      if (control) row.appendChild(control.node);

      // 跳转目标
      row.appendChild(el("span", { className: "branch-arrow", text: "跳到" }));
      const goSel = select(
        others.map((x) => [x.id, `${x.sectionTitle} / ${x.title}`]),
        rule.goTo || others[0].id
      );
      row.appendChild(goSel);

      const del = button("删除", { className: "btn-ghost danger btn-sm" });
      del.addEventListener("click", () => {
        rules.splice(index, 1);
        renderRules();
      });
      row.appendChild(del);

      // 读取控件值时把「当前选择」定格到 rule 上，供保存时使用
      rule.__read = () => {
        const next = {
          op: opSel.value,
          questionId: qSel.value,
          goTo: goSel.value,
        };
        if (control) next.value = control.read();
        return next;
      };

      ruleList.appendChild(row);
    });

    // 「否则」——三种语义显式可选，避免用户以为只有「跳走」一种
    const fallbackRow = el("div", { className: "branch-fallback-row" });
    fallbackRow.appendChild(el("span", { className: "branch-if", text: "否则" }));
    const modeSel = select(
      [
        ["order", "按题目顺序继续（默认）"],
        ["end", "本题作答后问卷结束"],
        ["goto", "跳到指定题目"],
      ],
      defaultNext === null ? "end" : typeof defaultNext === "string" ? "goto" : "order"
    );
    fallbackRow.appendChild(modeSel);

    const gotoHolder = el("div", { className: "branch-goto-holder" });
    const gotoEntries = others.map((x) => [x.id, `${x.sectionTitle} / ${x.title}`]);
    const gotoSel = select(
      gotoEntries,
      typeof defaultNext === "string" ? defaultNext : gotoEntries[0][0]
    );
    gotoHolder.appendChild(gotoSel);
    gotoHolder.hidden = modeSel.value !== "goto";
    modeSel.addEventListener("change", () => {
      gotoHolder.hidden = modeSel.value !== "goto";
    });
    fallbackRow.appendChild(gotoHolder);

    fallbackRow.__read = () => {
      if (modeSel.value === "order") return undefined;
      if (modeSel.value === "end") return null;
      return gotoSel.value;
    };

    body.appendChild(
      el("p", {
        className: "hint",
        text:
          "「按题目顺序继续」= 不设置 defaultNext，走下一题；" +
          "「结束」= 显式声明本题是终点。",
      })
    );

    ruleList.appendChild(fallbackRow);
  }

  renderRules();

  const addRule = button("+ 添加条件", { className: "btn-sm" });
  addRule.addEventListener("click", () => {
    rules.push({ op: "eq", questionId: q.id, value: undefined, goTo: others[0].id });
    renderRules();
  });
  body.appendChild(addRule);

  // ---- 只读预览：让「跳过了谁」可见 ----
  const previewBox = el("div", { className: "branch-preview" });
  body.appendChild(previewBox);

  async function refreshPreview() {
    clear(previewBox);
    previewBox.appendChild(
      el("p", { className: "hint", text: "预览中…（基于已保存的结构）" })
    );
    try {
      const data = await api(
        "POST",
        `/api/v1/questionnaire-templates/${state.templateId}/versions/${state.versionId}/flow/cases`,
        {
          cases: [
            { label: "按顺序（无命中）", answers: {} },
            { label: "本题选「是」", answers: { [q.id]: true } },
            { label: "本题选「否」", answers: { [q.id]: false } },
          ],
        }
      );
      clear(previewBox);
      previewBox.appendChild(
        el("p", {
          className: "hint",
          text: "预览基于**已保存**的结构；改动要先保存才反映在这里。",
        })
      );
      for (const r of data.results ?? []) {
        const line = el("div", { className: "branch-line" });
        line.appendChild(
          el("span", { className: "branch-op", text: r.label ?? "情形" })
        );
        if (r.error) {
          line.appendChild(
            el("span", { className: "branch-error", text: `⚠ ${r.error}` })
          );
        } else {
          line.appendChild(
            el("span", {
              text: r.questionIds.map((id) => questionTitle(id)).join(" → "),
            })
          );
        }
        previewBox.appendChild(line);
      }
    } catch (e) {
      clear(previewBox);
      previewBox.appendChild(
        el("p", { className: "hint", text: `预览失败：${e.message}` })
      );
    }
  }

  modal.appendChild(body);

  const footer = el("div", { className: "modal-foot" });
  const cancel = button("取消");
  const clearBtn = button("清除分支");
  const save = button("保存", { className: "btn btn-primary" });
  footer.appendChild(clearBtn);
  footer.appendChild(cancel);
  footer.appendChild(save);
  modal.appendChild(footer);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();

  cancel.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  clearBtn.addEventListener("click", async () => {
    if (!window.confirm(`清除「${q.title}」的全部分支设置？`)) return;
    const ok = await callApi(
      "PATCH",
      `/questions/${encodeURIComponent(q.id)}/branch`,
      { branches: [] }
    );
    if (ok !== null) {
      toast("已清除分支");
      close();
    }
  });

  save.addEventListener("click", async () => {
    // 从控件读回最终值（用户在行内改过的都定格在 __read 上）
    const branches = rules.map((r) => {
      const read = r.__read ? r.__read() : r;
      return {
        when: {
          op: read.op,
          questionId: read.questionId,
          ...(read.value !== undefined ? { value: read.value } : {}),
        },
        goTo: read.goTo,
      };
    });
    const fallback = ruleList.querySelector(".branch-fallback-row");
    const nextDefault = fallback && fallback.__read ? fallback.__read() : undefined;

    // 无 value 的操作符不该带 value；有 value 的必须带 —— 这里做一次本地拦截，
    // 省掉一次「提交后才知道」的往返
    for (const b of branches) {
      const needsValue = !VALUELESS_OPERATORS.includes(b.when.op);
      if (needsValue && b.when.value === undefined) {
        toast(
          `条件「${OPERATOR_LABEL[b.when.op]}」需要填写比较值`,
          true
        );
        return;
      }
      if (
        Array.isArray(b.when.value) &&
        b.when.value.length === 0 &&
        SET_OPERATORS.includes(b.when.op)
      ) {
        toast("「属于/不属于」至少勾选一个选项", true);
        return;
      }
    }

    const payload = { branches };
    if (nextDefault !== undefined) payload.defaultNext = nextDefault;

    const ok = await callApi(
      "PATCH",
      `/questions/${encodeURIComponent(q.id)}/branch`,
      payload
    );
    if (ok !== null) {
      toast("分支已保存");
      close();
    }
  });

  refreshPreview();
}

// ============================================================
// 拖拽落点计算
// ============================================================

/** 把分组移到目标位置（newIndex 是「插入后它的下标」） */
async function moveSectionTo(sectionId, newIndex) {
  const ids = state.schema.sections.map((s) => s.id);
  const from = ids.indexOf(sectionId);
  if (from < 0) return;

  const without = ids.filter((id) => id !== sectionId);
  // 原位置在目标之前时，摘除后下标要减 1
  const target = from < newIndex ? newIndex - 1 : newIndex;
  const clamped = Math.max(0, Math.min(target, without.length));
  without.splice(clamped, 0, sectionId);

  if (without.join(",") === ids.join(",")) return; // 没变
  await callApi("PATCH", "/sections/reorder", { sectionIds: without });
}

/**
 * 把题目拖到某个分组的指定位置。
 *
 * 同组内移动用 reorder_questions（一次原子写，前端不必推算跨过的项）；
 * 跨组移动用 move_question（后端支持 targetSectionId + targetOrder）。
 */
async function dropQuestionOnSection(questionId, targetSectionId, targetIndex) {
  const source = state.schema.sections.find((s) =>
    (s.questions ?? []).some((q) => q.id === questionId)
  );
  if (!source) return;

  const fromIndex = source.questions.findIndex((q) => q.id === questionId);
  const sameSection = source.id === targetSectionId;

  if (sameSection) {
    const ids = source.questions.map((q) => q.id);
    const without = ids.filter((id) => id !== questionId);
    const target = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
    const clamped = Math.max(0, Math.min(target, without.length));
    without.splice(clamped, 0, questionId);

    if (without.join(",") === ids.join(",")) return;
    await callApi("PATCH", "/questions/reorder", {
      sectionId: targetSectionId,
      questionIds: without,
    });
    return;
  }

  // 跨分组：targetOrder 是 1 起的位置（追加到末尾则省略）
  const targetSection = state.schema.sections.find((s) => s.id === targetSectionId);
  if (!targetSection) return;
  const isAppend = targetIndex >= targetSection.questions.length;

  await callApi(
    "PATCH",
    `/questions/${encodeURIComponent(questionId)}/move`,
    {
      targetSectionId,
      ...(isAppend ? {} : { targetOrder: targetIndex + 1 }),
    }
  );
}

// ============================================================
// 发布 / 新建草稿版本
// ============================================================

/** 把当前已发布版本复制成一个新草稿版本，然后跳过去编辑 */
async function createDraftFromCurrent() {
  const ok = window.confirm(
    "把当前版本的结构复制成一个新的草稿版本？\n\n" +
      "原版本不会被改动，新版本编号 +1，之后可以继续修改并发布。"
  );
  if (!ok) return;

  try {
    const created = await api(
      "POST",
      `/api/v1/questionnaire-templates/${state.templateId}/versions`,
      {
        schema: state.schema,
        changeNote: `基于 v${state.versionNo} 新建草稿`,
      }
    );
    toast("已新建草稿版本");
    location.href =
      `/editor.html?templateId=${encodeURIComponent(state.templateId)}` +
      `&versionId=${encodeURIComponent(created.id)}`;
  } catch (e) {
    toast(`新建草稿失败：${e.message}`, true);
  }
}

/** 发布当前草稿版本 */
async function publishCurrent() {
  const ok = window.confirm(
    "发布后这个版本就不能再修改了，且新案件可以直接选用。\n\n确定发布吗？"
  );
  if (!ok) return;

  try {
    await api(
      "POST",
      `/api/v1/questionnaire-templates/${state.templateId}/versions/${state.versionId}/publish`,
      {}
    );
    toast("已发布");
    await loadAll();
  } catch (e) {
    toast(`发布失败：${e.message}`, true);
  }
}

// ============================================================
// 载入
// ============================================================

/** 重新拉一次结构（写操作后调用） */
async function reloadSchema() {
  if (!state.versionId) return;
  const v = await api(
    "GET",
    `/api/v1/questionnaire-templates/${state.templateId}/versions/${state.versionId}`
  );
  state.schema = v.schema;
  state.versionStatus = v.status;
  state.versionNo = v.versionNo;
  state.revision = v.versionNo;
  render();
}

async function loadAll() {
  await reloadSchema();
  // 结构诊断要在 schema 之后：它带的是权威题目清单与分支摘要
  await loadStructureDiagnostics();

  const publishBtn = $("btn-publish");
  if (publishBtn) {
    publishBtn.hidden = !(state.versionStatus === "draft" && state.isAdmin);
  }

  render();
}

/** 空白模板：建模板 + 建空草稿版本，然后进入编辑 */
async function createBlankTemplate() {
  const name = await new Promise((resolve) => {
    const backdrop = el("div", { className: "modal-backdrop" });
    const modal = el("div", { className: "modal modal-sm" });
    const head = el("div", { className: "modal-head" });
    head.appendChild(el("h3", { text: "新建空白问卷模板" }));
    modal.appendChild(head);

    const body = el("div", { className: "modal-body" });
    const input = textInput("", "例如：无人机黑飞核查问卷");
    body.appendChild(field("模板名称", input));
    body.appendChild(
      el("p", {
        className: "hint",
        text: "会先建一个「草稿」版本，之后可以在编辑器里手工搭结构，改完再发布。",
      })
    );
    modal.appendChild(body);

    const footer = el("div", { className: "modal-foot" });
    const cancel = button("取消");
    const ok = button("创建并编辑", { className: "btn btn-primary" });
    footer.appendChild(cancel);
    footer.appendChild(ok);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    input.focus();

    const close = (v) => {
      backdrop.remove();
      resolve(v);
    };
    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click", () => close(input.value.trim() || null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") close(input.value.trim() || null);
      if (e.key === "Escape") close(null);
    });
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(null);
    });
  });

  if (!name) return;

  try {
    const t = await api("POST", "/api/v1/questionnaire-templates", { name });
    const v = await api(
      "POST",
      `/api/v1/questionnaire-templates/${t.id}/versions`,
      {}
    );
    location.href =
      `/editor.html?templateId=${encodeURIComponent(t.id)}` +
      `&versionId=${encodeURIComponent(v.id)}`;
  } catch (e) {
    toast(
      e.code === "PERMISSION_DENIED"
        ? "新建模板需要「模板管理员」账号，请在右上角切换用户。"
        : `新建失败：${e.message}`,
      true
    );
  }
}

// ============================================================
// 初始化
// ============================================================

async function init() {
  const params = new URLSearchParams(location.search);
  state.templateId = params.get("templateId");
  state.versionId = params.get("versionId");

  const picker = await initUserPicker("admin");
  state.isAdmin = picker.hasRole("template_admin");
  picker.onChange(async () => {
    state.isAdmin = picker.hasRole("template_admin");
    render();
  });

  const publishBtn = $("btn-publish");
  if (publishBtn) publishBtn.addEventListener("click", publishCurrent);

  const newBlankBtn = $("btn-blank");
  if (newBlankBtn) newBlankBtn.addEventListener("click", createBlankTemplate);

  // 视图切换：列表 / 节点
  const toggle = $("view-toggle");
  if (toggle) {
    toggle.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-view]");
      if (!btn) return;
      void switchView(btn.dataset.view);
    });
  }

  // 离开页面前把没落盘的坐标存掉（防抖可能还没到）
  window.addEventListener("beforeunload", () => {
    void graphView?.flush();
  });

  // 没有任何版本 → 提示并引导建空白模板
  if (!state.templateId || !state.versionId) {
    const canvas = $("editor-canvas");
    clear(canvas);
    const empty = el("div", { className: "editor-empty" });
    empty.appendChild(
      el("p", {
        text:
          "还没有打开任何问卷。可以新建一份空白模板，或从「模板管理」页选一个版本进来。",
      })
    );
    if (state.isAdmin) {
      const go = button("+ 新建空白模板", { className: "btn btn-primary" });
      go.addEventListener("click", createBlankTemplate);
      empty.appendChild(go);
    } else {
      empty.appendChild(
        el("p", {
          className: "hint",
          text: "新建模板需要「模板管理员」账号，请在右上角切换用户。",
        })
      );
    }
    canvas.appendChild(empty);
    renderSidebar();
    return;
  }

  try {
    const t = await api("GET", `/api/v1/questionnaire-templates/${state.templateId}`);
    state.templateName = t.name;
  } catch {
    state.templateName = "";
  }

  await loadAll();
}

init();
