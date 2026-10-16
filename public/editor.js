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
};

/** 是否可编辑：草稿 + 模板管理员 */
function canEdit() {
  return state.versionStatus === "draft" && state.isAdmin;
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
  renderCanvas();
  renderSidebar();
  renderStats();
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
  row.appendChild(main);

  const actions = el("div", { className: "q-actions" });
  if (editable) {
    const edit = button("编辑", { className: "btn-ghost btn-sm" });
    edit.addEventListener("click", () => editQuestion(section, q));
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
      text: canEdit()
        ? "拖动左侧的 ⠿ 手柄可以调整分组与题目的顺序；点「编辑」改题目内容。"
        : "当前为只读视图。",
    })
  );

  if (canEdit()) {
    const addTop = button("+ 添加分组", { className: "btn btn-sm" });
    addTop.addEventListener("click", addSection);
    box.appendChild(addTop);
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

async function editQuestion(section, q) {
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

  const publishBtn = $("btn-publish");
  if (publishBtn) {
    publishBtn.hidden = !(state.versionStatus === "draft" && state.isAdmin);
  }
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
