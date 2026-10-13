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
  page: 1,
  pageSize: 10,
  total: 0,
  items: [],
  selected: null,
  versions: [],
  /** 当前用户是否模板管理员（决定写操作是否可用） */
  isAdmin: false,
};

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
          attrs: { colspan: "6" },
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
        attrs: { colspan: "6" },
      })
    );
    tbody.appendChild(tr);
  }
}

function renderRow(t) {
  const tr = el("tr");
  tr.appendChild(el("td", { text: t.name }));

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

  const btnRow = el("div", { className: "form-actions" });
  const save = button("保存", { className: "btn btn-primary" });
  save.addEventListener("click", saveTemplate);
  btnRow.appendChild(save);

  const reset = button("重置");
  reset.addEventListener("click", renderDetail);
  btnRow.appendChild(reset);
  form.appendChild(btnRow);

  if (!state.isAdmin) {
    form.appendChild(
      el("p", {
        className: "hint",
        text: "提示：保存与删除需要「模板管理员」账号，当前账号只能查看。",
      })
    );
  }
  box.appendChild(form);

  // ---- 元信息 ----
  const meta = el("div", { className: "meta-grid" });
  const rows = [
    ["模板 ID", t.id],
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

  try {
    const updated = await api(
      "PATCH",
      `/api/v1/questionnaire-templates/${t.id}`,
      { name, description }
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

  await loadList();
}

init();
