/**
 * 模板管理页。
 *
 * 与工作台（app.js）的关系：
 *   工作台负责「用模板做案件」与「从零创建模板」；
 *   本页负责「管理已有的模板」—— 搜索、查看、改名称/描述、删除、发布新版本。
 *
 * 刻意不引入框架：内网部署无构建链。
 * 所有状态以服务端为准，改完一律重新拉列表，避免前端副本与库不一致。
 */

// ============================================================
// 状态
// ============================================================

const state = {
  userId: null,
  /** 当前搜索条件 */
  keyword: "",
  status: "",
  page: 1,
  pageSize: 10,
  total: 0,
  items: [],
  /** 当前选中的模板详情 */
  selected: null,
  /** 选中模板的版本列表 */
  versions: [],
};

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

function el(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.attrs) {
    for (const [k, v] of Object.entries(options.attrs)) node.setAttribute(k, v);
  }
  return node;
}

/** 统一的 API 调用（与 app.js 同样的鉴权方式） */
async function api(method, path, body) {
  const headers = {};
  if (state.userId) headers["x-user-id"] = state.userId;
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!res.ok) {
    const err = payload?.error ?? {};
    const e = new Error(err.message || `HTTP ${res.status}`);
    e.code = err.code;
    e.status = res.status;
    throw e;
  }
  return payload ? payload.data : null;
}

const STATUS_LABEL = {
  draft: "草稿",
  published: "已发布",
  disabled: "已停用",
};

const STATUS_CLASS = {
  draft: "warn",
  published: "ok",
  disabled: "",
};

function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/** 当前用户是否有模板管理权限（用于提前提示，而不是等 403） */
function isTemplateAdmin() {
  const sel = $("user-select");
  const text = sel.options[sel.selectedIndex]?.textContent ?? "";
  return text.includes("template_admin");
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

  const tbody = $("template-rows");
  tbody.textContent = "";

  try {
    const data = await api(
      "GET",
      `/api/v1/questionnaire-templates?${params.toString()}`
    );
    state.items = data.items ?? [];
    state.total = data.total ?? 0;

    $("count-badge").textContent = `共 ${state.total} 个`;

    if (state.items.length === 0) {
      const tr = el("tr");
      const td = el("td", {
        className: "empty",
        text: state.keyword ? `没有匹配「${state.keyword}」的模板` : "还没有模板",
        attrs: { colspan: "6" },
      });
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const t of state.items) tbody.appendChild(renderRow(t));
    }

    // 分页
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
      className: `tag ${STATUS_CLASS[t.status] ?? ""}`,
      text: STATUS_LABEL[t.status] ?? t.status,
    })
  );
  tr.appendChild(statusTd);

  tr.appendChild(el("td", { text: String(t.versionCount ?? "-") }));
  tr.appendChild(
    el("td", { text: t.currentVersionId ? t.currentVersionId.slice(0, 8) : "—" })
  );
  tr.appendChild(el("td", { text: fmtTime(t.createdAt) }));

  const actions = el("td", { className: "col-actions" });
  const view = el("button", { className: "btn-ghost", text: "查看" });
  view.type = "button";
  view.addEventListener("click", () => selectTemplate(t.id));
  actions.appendChild(view);

  const del = el("button", { className: "btn-ghost danger", text: "删除" });
  del.type = "button";
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

  if (!t) {
    box.appendChild(el("p", { className: "hint", text: "从左侧列表点一个模板查看详情。" }));
    $("detail-title").textContent = "模板详情";
    $("detail-status").textContent = "未选择";
    $("detail-status").className = "badge";
    return;
  }

  $("detail-title").textContent = "模板详情";
  const badge = $("detail-status");
  badge.textContent = STATUS_LABEL[t.status] ?? t.status;
  badge.className = "badge " + (STATUS_CLASS[t.status] ?? "");

  // ---- 可编辑字段 ----
  const form = el("div", { className: "form" });

  const nameField = el("label", { className: "field" });
  nameField.appendChild(el("span", { text: "模板名称" }));
  const nameInput = el("input", { attrs: { id: "edit-name", value: t.name } });
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
  const save = el("button", { className: "btn btn-primary", text: "保存" });
  save.type = "button";
  save.addEventListener("click", saveTemplate);
  btnRow.appendChild(save);

  const reset = el("button", { className: "btn", text: "重置" });
  reset.type = "button";
  reset.addEventListener("click", renderDetail);
  btnRow.appendChild(reset);
  form.appendChild(btnRow);

  if (!isTemplateAdmin()) {
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

  // ---- 版本列表（含发布入口）----
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
        className: `tag ${STATUS_CLASS[v.status] ?? ""}`,
        text: STATUS_LABEL[v.status] ?? v.status,
      })
    );
    if (v.changeNote) {
      left.appendChild(el("span", { className: "hint", text: v.changeNote }));
    }
    row.appendChild(left);

    const right = el("div", { className: "version-actions" });

    const view = el("button", { className: "btn-ghost", text: "看结构" });
    view.type = "button";
    view.addEventListener("click", () => showVersionSchema(v.id));
    right.appendChild(view);

    if (v.status === "draft") {
      const pub = el("button", { className: "btn-ghost", text: "发布" });
      pub.type = "button";
      pub.addEventListener("click", () => publishVersion(v));
      right.appendChild(pub);
    }
    if (v.status === "published") {
      const dis = el("button", { className: "btn-ghost danger", text: "停用" });
      dis.type = "button";
      dis.addEventListener("click", () => disableVersion(v));
      right.appendChild(dis);
    }

    row.appendChild(right);
    vlist.appendChild(row);
  }
  box.appendChild(vlist);
}

/** 看某个版本的结构（只读展示） */
async function showVersionSchema(versionId) {
  const t = state.selected;
  if (!t) return;
  try {
    const v = await api(
      "GET",
      `/api/v1/questionnaire-templates/${t.id}/versions/${versionId}`
    );
    const sections = v.schema?.sections ?? [];

    const box = el("div", { className: "modal-backdrop" });
    const modal = el("div", { className: "modal" });

    const head = el("div", { className: "modal-head" });
    head.appendChild(
      el("h3", { text: `v${v.versionNo} 结构（${sections.length} 个分组）` })
    );
    const close = el("button", { className: "btn btn-sm", text: "关闭" });
    close.type = "button";
    close.addEventListener("click", () => box.remove());
    head.appendChild(close);
    modal.appendChild(head);

    const body = el("div", { className: "modal-body" });
    if (sections.length === 0) {
      body.appendChild(el("p", { className: "hint", text: "这个版本还没有内容。" }));
    }
    for (const s of sections) {
      const secBox = el("div", { className: "schema-section" });
      secBox.appendChild(el("div", { className: "schema-title", text: s.title }));
      const ul = el("ul", { className: "schema-questions" });
      for (const q of s.questions ?? []) {
        const li = el("li");
        li.appendChild(el("span", { text: q.title }));
        li.appendChild(el("span", { className: "tag", text: q.type }));
        if (q.required) li.appendChild(el("span", { className: "tag required", text: "必填" }));
        ul.appendChild(li);
      }
      secBox.appendChild(ul);
      body.appendChild(secBox);
    }
    modal.appendChild(body);
    box.appendChild(modal);
    box.addEventListener("click", (e) => {
      if (e.target === box) box.remove();
    });
    document.body.appendChild(box);
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
      toast("保存需要「模板管理员」账号，请先在左上角切换用户。", true);
    } else {
      toast(`保存失败：${e.message}`, true);
    }
  }
}

async function removeTemplate(t) {
  if (
    !confirm(
      `确定删除模板「${t.name}」？\n\n` +
        "· 它的所有版本会一并删除\n" +
        "· 若已有案件使用过它的版本，会被拒绝（避免案件失去来源依据）"
    )
  ) {
    return;
  }

  try {
    const data = await api(
      "DELETE",
      `/api/v1/questionnaire-templates/${t.id}`
    );
    toast(`已删除（连带 ${data.deletedVersions} 个版本）`);
    if (state.selected?.id === t.id) {
      state.selected = null;
      state.versions = [];
      renderDetail();
    }
    await loadList();
  } catch (e) {
    if (e.code === "INVALID_STATUS_TRANSITION") {
      // 后端把「为什么不能删」讲清楚了，直接透传给用户
      toast(e.message, true);
    } else if (e.code === "PERMISSION_DENIED") {
      toast("删除需要「模板管理员」账号，请先在左上角切换用户。", true);
    } else {
      toast(`删除失败：${e.message}`, true);
    }
  }
}

async function publishVersion(v) {
  const t = state.selected;
  if (!t) return;

  if (
    !confirm(
      `把 v${v.versionNo} 发布为正式模板？\n\n` +
        "· 发布后模板状态变为「已发布」，新案件可以直接选用\n" +
        "· 该版本不能再修改（要改得新建版本）"
    )
  ) {
    return;
  }

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

  if (!confirm(`停用 v${v.versionNo}？停用后不能再用于新建案件。`)) return;

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
    select.appendChild(
      el("option", {
        text: `${u.displayName}（${u.roles.join("/")}）`,
        attrs: { value: u.id },
      })
    );
  }

  // 模板管理默认用模板管理员，省得每次手动切
  const preferred =
    users.find((u) => u.username === "admin") ?? users[0];
  if (preferred) {
    select.value = preferred.id;
    state.userId = preferred.id;
  }

  select.addEventListener("change", async () => {
    state.userId = select.value;
    await loadList();
    renderDetail();
  });

  $("btn-search").addEventListener("click", () => {
    state.keyword = $("search-input").value.trim();
    state.page = 1;
    loadList();
  });

  // 回车即搜
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

  $("btn-reload").addEventListener("click", () => loadList());

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
