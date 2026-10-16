/**
 * 模板管理页。
 *
 * 职责：管理**已有的**模板 —— 搜索、查看结构、改名称/描述、发布/停用、删除。
 *
 * 与另两页的分工：
 *   /（下发问卷）    选模板建案件
 *   /create.html    用 AI 从零创建模板
 *   /templates.html 管理已有模板（本页）
 *
 * 共用工具（api / toast / 用户选择器 / 顶栏）都在 common.js，
 * 避免三个页面各写一份导致行为漂移。
 */

import {
  $,
  TEMPLATE_STATUS_CLASS,
  TEMPLATE_STATUS_LABEL,
  api,
  button,
  countSchema,
  el,
  fmtTime,
  initUserPicker,
  renderNav,
  toast,
} from "/common.js";

renderNav("templates");

const state = {
  keyword: "",
  status: "",
  /** 分类筛选（空串 = 全部） */
  categoryId: "",
  /** 全部分类，供筛选下拉与编辑时的选择框共用 */
  categories: [],
  page: 1,
  pageSize: 10,
  total: 0,
  items: [],
  selected: null,
  versions: [],
  /** 当前用户是否模板管理员（决定写操作是否可用） */
  isAdmin: false,
};

/** 分类名查找（列表要显示名字而不是 uuid） */
function categoryName(categoryId) {
  if (!categoryId) return "—";
  const hit = state.categories.find((c) => c.id === categoryId);
  return hit ? hit.name : "—";
}

/**
 * 载入分类列表并填充筛选下拉。
 *
 * 失败不影响主列表：分类只是组织维度，
 * 接口挂了也应该能继续看模板（下拉保持「全部」）。
 */
async function loadCategories() {
  try {
    const data = await api("GET", "/api/v1/questionnaire-template-categories");
    state.categories = data.items ?? [];
  } catch {
    state.categories = [];
  }

  const sel = $("category-filter");
  if (!sel) return;
  const current = sel.value;
  sel.textContent = "";
  sel.appendChild(el("option", { attrs: { value: "" }, text: "全部" }));
  for (const c of state.categories) {
    const opt = el("option", { attrs: { value: c.id }, text: c.name });
    sel.appendChild(opt);
  }
  sel.value = current;
}

// ============================================================
// 列表
// ============================================================

async function loadList() {
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  if (state.keyword) params.set("keyword", state.keyword);
  if (state.status) params.set("status", state.status);
  if (state.categoryId) params.set("categoryId", state.categoryId);

  const tbody = $("template-rows");
  tbody.textContent = "";

  try {
    const data = await api(
      "GET",
      `/api/v1/questionnaire-templates?${params}`
    );
    state.items = data.items ?? [];
    state.total = data.total ?? 0;
    $("count-badge").textContent = `共 ${state.total} 个`;

    if (state.items.length === 0) {
      const tr = el("tr");
      tr.appendChild(
        el("td", {
          className: "empty",
          text: state.keyword
            ? `没有匹配「${state.keyword}」的模板`
            : "还没有模板。可以到「从零创建」用 AI 做一份。",
          attrs: { colspan: "7" },
        })
      );
      tbody.appendChild(tr);
    } else {
      for (const t of state.items) tbody.appendChild(renderRow(t));
    }

    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    $("page-info").textContent = `第 ${state.page} / ${pages} 页`;
    $("btn-prev").disabled = state.page <= 1;
    $("btn-next").disabled = state.page >= pages;
  } catch (e) {
    const tr = el("tr");
    tr.appendChild(
      el("td", {
        className: "empty",
        text: `载入失败：${e.message}`,
        attrs: { colspan: "7" },
      })
    );
    tbody.appendChild(tr);
  }
}

function renderRow(t) {
  const tr = el("tr");
  tr.appendChild(el("td", { text: t.name }));

  // 分类：存量模板没有分类，显示「—」
  tr.appendChild(el("td", { className: "hint", text: categoryName(t.categoryId) }));

  const statusTd = el("td");
  statusTd.appendChild(
    el("span", {
      className: `tag ${TEMPLATE_STATUS_CLASS[t.status] ?? ""}`,
      text: TEMPLATE_STATUS_LABEL[t.status] ?? t.status,
    })
  );
  tr.appendChild(statusTd);

  tr.appendChild(el("td", { text: String(t.versionCount ?? "-") }));
  tr.appendChild(
    el("td", { text: t.currentVersionId ? t.currentVersionId.slice(0, 8) : "—" })
  );
  tr.appendChild(el("td", { text: fmtTime(t.createdAt) }));

  const actions = el("td", { className: "col-actions" });

  const view = button("查看", { className: "btn-ghost" });
  view.addEventListener("click", () => selectTemplate(t.id));
  actions.appendChild(view);

  const del = button("删除", { className: "btn-ghost danger" });
  del.addEventListener("click", () => removeTemplate(t));
  actions.appendChild(del);

  tr.appendChild(actions);
  return tr;
}

// ============================================================
// 详情 / 编辑
// ============================================================

async function selectTemplate(templateId) {
  try {
    const [t, vs] = await Promise.all([
      api("GET", `/api/v1/questionnaire-templates/${templateId}`),
      api("GET", `/api/v1/questionnaire-templates/${templateId}/versions`),
    ]);
    state.selected = t;
    state.versions = vs.items ?? [];
    renderDetail();
  } catch (e) {
    toast(`载入详情失败：${e.message}`, true);
  }
}

function renderDetail() {
  const t = state.selected;
  const box = $("detail-body");
  box.textContent = "";

  const badge = $("detail-status");

  if (!t) {
    box.appendChild(
      el("p", { className: "hint", text: "从左侧列表点一个模板查看详情。" })
    );
    $("detail-title").textContent = "模板详情";
    badge.textContent = "未选择";
    badge.className = "badge";
    return;
  }

  $("detail-title").textContent = "模板详情";
  badge.textContent = TEMPLATE_STATUS_LABEL[t.status] ?? t.status;
  badge.className = "badge " + (TEMPLATE_STATUS_CLASS[t.status] ?? "");

  // ---- 可编辑字段 ----
  const form = el("div", { className: "form" });

  const nameField = el("label", { className: "field" });
  nameField.appendChild(el("span", { text: "模板名称" }));
  const nameInput = el("input", { attrs: { id: "edit-name", value: t.name } });
  nameInput.value = t.name;
  nameField.appendChild(nameInput);
  form.appendChild(nameField);

  const descField = el("label", { className: "field" });
  descField.appendChild(el("span", { text: "描述" }));
  const descInput = el("textarea", {
    attrs: { id: "edit-desc", rows: "3", placeholder: "（可留空）" },
  });
  descInput.value = t.description ?? "";
  descField.appendChild(descInput);
  form.appendChild(descField);

  // 分类：可留空。选项来自 /questionnaire-template-categories；
  // 存量模板的 categoryId 为 null，对应「（未分类）」。
  const catField = el("label", { className: "field" });
  catField.appendChild(el("span", { text: "分类" }));
  const catSelect = el("select", { attrs: { id: "edit-category" } });
  catSelect.appendChild(
    el("option", { attrs: { value: "" }, text: "（未分类）" })
  );
  for (const c of state.categories) {
    catSelect.appendChild(
      el("option", { attrs: { value: c.id }, text: `${c.name}（${c.code}）` })
    );
  }
  catSelect.value = t.categoryId ?? "";
  catField.appendChild(catSelect);
  form.appendChild(catField);

  const btnRow = el("div", { className: "form-actions" });
  const save = button("保存", { className: "btn btn-primary" });
  save.addEventListener("click", saveTemplate);
  btnRow.appendChild(save);

  const reset = button("重置");
  reset.addEventListener("click", renderDetail);
  btnRow.appendChild(reset);

  const manageCats = button("管理分类");
  manageCats.addEventListener("click", openCategoryManager);
  btnRow.appendChild(manageCats);
  form.appendChild(btnRow);

  if (!state.isAdmin) {
    form.appendChild(
      el("p", {
        className: "hint",
        text: "提示：保存与删除需要「模板管理员」账号，当前账号只能查看。",
      })
    );
  }

  // 分类现在可以在弹窗里管理；这里只说明入口与「引用中不能删」这条规则
  form.appendChild(
    el("p", {
      className: "hint",
      text:
        state.categories.length === 0
          ? "还没有任何分类。点「管理分类」新建（需要模板管理员账号）。"
          : "点「管理分类」可新建/改名/删除分类；仍被模板引用的分类不能删除。",
    })
  );
  box.appendChild(form);

  // ---- 元信息 ----
  const meta = el("div", { className: "meta-grid" });
  const rows = [
    ["模板 ID", t.id],
    ["分类", categoryName(t.categoryId)],
    ["版本数", String(state.versions.length)],
    ["当前版本", t.currentVersionId ? t.currentVersionId.slice(0, 8) : "（未发布）"],
    ["创建时间", fmtTime(t.createdAt)],
  ];
  for (const [k, v] of rows) {
    meta.appendChild(el("div", { className: "meta-key", text: k }));
    meta.appendChild(el("div", { className: "meta-val", text: v }));
  }
  box.appendChild(meta);

  // ---- 版本列表 ----
  box.appendChild(el("h3", { className: "sub-title", text: "版本" }));

  const vlist = el("div", { className: "version-list" });
  if (state.versions.length === 0) {
    vlist.appendChild(el("p", { className: "hint", text: "该模板还没有版本。" }));
  }

  for (const v of state.versions) {
    const row = el("div", { className: "version-row" });

    const left = el("div", { className: "version-main" });
    left.appendChild(el("span", { className: "version-no", text: `v${v.versionNo}` }));
    left.appendChild(
      el("span", {
        className: `tag ${TEMPLATE_STATUS_CLASS[v.status] ?? ""}`,
        text: TEMPLATE_STATUS_LABEL[v.status] ?? v.status,
      })
    );
    if (v.changeNote) {
      left.appendChild(el("span", { className: "hint", text: v.changeNote }));
    }
    row.appendChild(left);

    const right = el("div", { className: "version-actions" });

    const view = button("看结构", { className: "btn-ghost" });
    view.addEventListener("click", () => showVersionSchema(v.id));
    right.appendChild(view);

    if (v.status === "draft") {
      const pub = button("发布", { className: "btn-ghost" });
      pub.addEventListener("click", () => publishVersion(v));
      right.appendChild(pub);
    }
    if (v.status === "published") {
      const dis = button("停用", { className: "btn-ghost danger" });
      dis.addEventListener("click", () => disableVersion(v));
      right.appendChild(dis);
    }

    row.appendChild(right);
    vlist.appendChild(row);
  }
  box.appendChild(vlist);
}

/** 看某个版本的结构（只读弹窗） */
async function showVersionSchema(versionId) {
  const t = state.selected;
  if (!t) return;
  try {
    const v = await api(
      "GET",
      `/api/v1/questionnaire-templates/${t.id}/versions/${versionId}`
    );
    const { sections: sectionCount, questions: questionCount } = countSchema(
      v.schema
    );
    const sections = v.schema?.sections ?? [];

    const backdrop = el("div", { className: "modal-backdrop" });
    const modal = el("div", { className: "modal" });

    const head = el("div", { className: "modal-head" });
    head.appendChild(
      el("h3", {
        text: `v${v.versionNo} 结构（${sectionCount} 个分组 / ${questionCount} 道题）`,
      })
    );
    const close = button("关闭", { className: "btn btn-sm" });
    close.addEventListener("click", () => backdrop.remove());
    head.appendChild(close);
    modal.appendChild(head);

    const body = el("div", { className: "modal-body" });
    if (sections.length === 0) {
      body.appendChild(
        el("p", { className: "hint", text: "这个版本还没有内容。" })
      );
    }
    for (const s of sections) {
      const secBox = el("div", { className: "schema-section" });
      secBox.appendChild(el("div", { className: "schema-title", text: s.title }));
      const ul = el("ul", { className: "schema-questions" });
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
      body.appendChild(secBox);
    }
    modal.appendChild(body);
    backdrop.appendChild(modal);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
    document.body.appendChild(backdrop);
  } catch (e) {
    toast(`载入版本失败：${e.message}`, true);
  }
}

// ============================================================
// 分类管理（弹窗内的增 / 改 / 删）
// ============================================================

const CATEGORIES_PATH = "/api/v1/questionnaire-template-categories";

/**
 * 打开「管理分类」弹窗。
 *
 * 为什么做成弹窗而不是独立页面：分类是模板的附属组织维度，
 * 用户是在「给模板选分类」时才发现缺分类，就地能建最顺手。
 *
 * 平台限制：这里的输入框都是受控的简单表单，不依赖任何 UI 库
 * （前端无构建链，见 AGENT.md 第 7 节）。
 */
function openCategoryManager() {
  const backdrop = el("div", { className: "modal-backdrop" });
  const modal = el("div", { className: "modal" });

  // ---- 头部 ----
  const head = el("div", { className: "modal-head" });
  head.appendChild(el("h3", { text: "管理模板分类" }));
  const close = button("关闭", { className: "btn btn-sm" });
  close.addEventListener("click", async () => {
    backdrop.remove();
    // 关闭时刷新：分类可能被改过，模板列表与下拉都要跟着更新
    await loadCategories();
    await loadList();
    renderDetail();
  });
  head.appendChild(close);
  modal.appendChild(head);

  const body = el("div", { className: "modal-body" });

  // ---- 新建表单 ----
  const createBox = el("div", { className: "cat-create" });
  createBox.appendChild(el("h4", { text: "新增分类" }));

  const formRow = el("div", { className: "cat-form-row" });

  const nameInput = el("input", {
    attrs: { placeholder: "分类名称，如 无人机核查", maxlength: "100" },
  });
  const codeInput = el("input", {
    attrs: { placeholder: "编码，如 drone_check", maxlength: "64" },
  });
  formRow.appendChild(labelled("名称", nameInput));
  formRow.appendChild(labelled("编码", codeInput));
  createBox.appendChild(formRow);

  const descInput = el("input", {
    attrs: { placeholder: "描述（可留空）", maxlength: "2000" },
  });
  createBox.appendChild(labelled("描述", descInput));

  createBox.appendChild(
    el("p", {
      className: "hint",
      text:
        "编码是程序引用的稳定标识：只能用小写字母、数字、下划线，以字母开头，" +
        "创建后不可修改。",
    })
  );

  const createBtn = button("新增", { className: "btn btn-primary" });
  createBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const code = codeInput.value.trim();
    if (!name || !code) {
      toast("名称与编码都要填", true);
      return;
    }
    try {
      await api("POST", CATEGORIES_PATH, {
        name,
        code,
        ...(descInput.value.trim() ? { description: descInput.value.trim() } : {}),
      });
      toast(`已新增分类「${name}」`);
      await refresh();
    } catch (e) {
      toast(
        e.code === "PERMISSION_DENIED"
          ? "新增分类需要「模板管理员」账号，请在右上角切换用户。"
          : `新增失败：${e.message}`,
        true
      );
    }
  });
  createBox.appendChild(createBtn);
  body.appendChild(createBox);

  // ---- 列表 ----
  const listBox = el("div", { className: "cat-list" });
  body.appendChild(listBox);

  /** 重画弹窗内的列表（并同步外层下拉） */
  async function refresh() {
    await loadCategories();
    listBox.textContent = "";

    if (state.categories.length === 0) {
      listBox.appendChild(
        el("p", { className: "hint", text: "还没有任何分类。" })
      );
    }

    for (const c of state.categories) {
      listBox.appendChild(renderCategoryRow(c, refresh));
    }

    nameInput.value = "";
    codeInput.value = "";
    descInput.value = "";
    nameInput.focus();
  }

  modal.appendChild(body);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close.click();
  });
  document.body.appendChild(backdrop);

  refresh();
}

/** 「标签 + 输入框」的小组合 */
function labelled(labelText, input) {
  const wrap = el("label", { className: "field" });
  wrap.appendChild(el("span", { text: labelText }));
  wrap.appendChild(input);
  return wrap;
}

/** 分类列表的一行：展示态与编辑态共用一个 DOM 槽 */
function renderCategoryRow(c, refresh) {
  const row = el("div", { className: "cat-row" });

  const main = el("div", { className: "cat-main" });
  main.appendChild(el("span", { className: "cat-name", text: c.name }));
  main.appendChild(el("span", { className: "tag", text: c.code }));

  const used = c.templateCount ?? 0;
  main.appendChild(
    el("span", {
      className: used > 0 ? "tag ok" : "hint",
      text: used > 0 ? `${used} 个模板在用` : "未被使用",
    })
  );
  if (c.description) {
    main.appendChild(el("span", { className: "hint", text: c.description }));
  }
  row.appendChild(main);

  const actions = el("div", { className: "cat-actions" });

  const edit = button("改名", { className: "btn-ghost" });
  edit.addEventListener("click", () => {
    actions.textContent = "";
    const nameInput = el("input", { attrs: { value: c.name, maxlength: "100" } });
    nameInput.value = c.name;
    const descInput = el("input", {
      attrs: { value: c.description ?? "", maxlength: "2000" },
    });
    descInput.value = c.description ?? "";
    main.textContent = "";
    main.appendChild(labelled("名称", nameInput));
    main.appendChild(labelled("描述", descInput));

    const save = button("保存", { className: "btn-primary btn-sm" });
    save.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        toast("分类名称不能为空", true);
        return;
      }
      try {
        await api("PATCH", `${CATEGORIES_PATH}/${c.id}`, {
          name,
          description: descInput.value.trim() === "" ? null : descInput.value.trim(),
        });
        toast("已保存");
        await refresh();
      } catch (e) {
        toast(`保存失败：${e.message}`, true);
      }
    });
    actions.appendChild(save);

    const cancel = button("取消", { className: "btn-sm" });
    cancel.addEventListener("click", () => refresh());
    actions.appendChild(cancel);
  });
  actions.appendChild(edit);

  const del = button("删除", { className: "btn-ghost danger" });
  if (used > 0) {
    // 后端也会拦（外键 RESTRICT），这里提前禁用并说明原因，
    // 避免用户点一次才知道删不掉
    del.disabled = true;
    del.title = `还有 ${used} 个模板在用这个分类，先把它们改到别的分类`;
  } else {
    del.addEventListener("click", async () => {
      if (!window.confirm(`确定删除分类「${c.name}」？`)) return;
      try {
        await api("DELETE", `${CATEGORIES_PATH}/${c.id}`);
        toast(`已删除分类「${c.name}」`);
        await refresh();
      } catch (e) {
        toast(
          e.code === "PERMISSION_DENIED"
            ? "删除分类需要「模板管理员」账号。"
            : `删除失败：${e.message}`,
          true
        );
      }
    });
  }
  actions.appendChild(del);

  row.appendChild(actions);
  return row;
}

// ============================================================
// 写操作
// ============================================================

async function saveTemplate() {
  const t = state.selected;
  if (!t) return;

  const name = $("edit-name").value.trim();
  const descRaw = $("edit-desc").value.trim();

  if (!name) {
    toast("模板名称不能为空", true);
    return;
  }

  // 描述原本有内容、现在清空了 → 传 null 表示「清空」
  const description = descRaw === "" ? null : descRaw;

  // 分类同理：选「（未分类）」→ 传 null 清空
  const catRaw = $("edit-category").value;
  const categoryId = catRaw === "" ? null : catRaw;

  try {
    const updated = await api(
      "PATCH",
      `/api/v1/questionnaire-templates/${t.id}`,
      { name, description, categoryId }
    );
    state.selected = updated;
    toast("已保存");
    await loadList();
    renderDetail();
  } catch (e) {
    if (e.code === "PERMISSION_DENIED") {
      toast("保存需要「模板管理员」账号，请在右上角切换用户。", true);
    } else {
      toast(`保存失败：${e.message}`, true);
    }
  }
}

async function removeTemplate(t) {
  const ok = window.confirm(
    `确定删除模板「${t.name}」？\n\n` +
      "· 它的所有版本会一并删除\n" +
      "· 若已有案件使用过它的版本，会被拒绝（避免案件失去来源依据）"
  );
  if (!ok) return;

  try {
    const data = await api("DELETE", `/api/v1/questionnaire-templates/${t.id}`);
    toast(`已删除（连带 ${data.deletedVersions} 个版本）`);
    if (state.selected?.id === t.id) {
      state.selected = null;
      state.versions = [];
      renderDetail();
    }
    await loadList();
  } catch (e) {
    if (e.code === "INVALID_STATUS_TRANSITION") {
      // 后端把「为什么不能删」讲清楚了，直接透传
      toast(e.message, true);
    } else if (e.code === "PERMISSION_DENIED") {
      toast("删除需要「模板管理员」账号，请在右上角切换用户。", true);
    } else {
      toast(`删除失败：${e.message}`, true);
    }
  }
}

async function publishVersion(v) {
  const t = state.selected;
  if (!t) return;

  const ok = window.confirm(
    `把 v${v.versionNo} 发布为正式模板？\n\n` +
      "· 发布后模板状态变为「已发布」，新案件可以直接选用\n" +
      "· 该版本不能再修改（要改得新建版本）"
  );
  if (!ok) return;

  try {
    await api(
      "POST",
      `/api/v1/questionnaire-templates/${t.id}/versions/${v.id}/publish`
    );
    toast("已发布");
    await loadList();
    await selectTemplate(t.id);
  } catch (e) {
    toast(`发布失败：${e.message}`, true);
  }
}

async function disableVersion(v) {
  const t = state.selected;
  if (!t) return;

  const ok = window.confirm(
    `停用 v${v.versionNo}？停用后不能再用于新建案件。\n` +
      "（若这是唯一的已发布版本，模板状态会同步变为「已停用」）"
  );
  if (!ok) return;

  try {
    await api(
      "POST",
      `/api/v1/questionnaire-templates/${t.id}/versions/${v.id}/disable`
    );
    toast("已停用");
    await loadList();
    await selectTemplate(t.id);
  } catch (e) {
    toast(`停用失败：${e.message}`, true);
  }
}

// ============================================================
// 初始化
// ============================================================

async function init() {
  // 模板管理默认用模板管理员，省得每次手动切
  const picker = await initUserPicker("admin");
  state.isAdmin = picker.hasRole("template_admin");

  picker.onChange(async () => {
    state.isAdmin = picker.hasRole("template_admin");
    await loadList();
    renderDetail();
  });

  $("btn-search").addEventListener("click", () => {
    state.keyword = $("search-input").value.trim();
    state.page = 1;
    loadList();
  });

  $("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("btn-search").click();
    }
  });

  $("status-filter").addEventListener("change", () => {
    state.status = $("status-filter").value;
    state.page = 1;
    loadList();
  });

  $("category-filter").addEventListener("change", () => {
    state.categoryId = $("category-filter").value;
    state.page = 1;
    loadList();
  });

  $("btn-prev").addEventListener("click", () => {
    if (state.page > 1) {
      state.page -= 1;
      loadList();
    }
  });

  $("btn-next").addEventListener("click", () => {
    state.page += 1;
    loadList();
  });

  await loadCategories();
  await loadList();
}

init();
