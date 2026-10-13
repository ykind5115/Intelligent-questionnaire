/**
 * 案件（问卷实例）管理页。
 *
 * 目的：一屏看清「已下发的问卷现在都在什么状态、在谁手上、到哪一步了」。
 *
 * 权限说明：列表由后端按**行**过滤（dispatcher 只看自己创建的、
 * investigator 只看被指派给自己的、reviewer 只看有提交待审的、
 * template_admin 看全部），前端不做权限假设 ——
 * 因此同一个页面在不同账号下看到的集合本来就不同。
 */

import {
  $,
  api,
  askText,
  button,
  countSchema,
  el,
  fmtTime,
  initUserPicker,
  renderNav,
  toast,
} from "/common.js";

renderNav("instances");

const state = {
  keyword: "",
  status: "",
  onlyMine: false,
  page: 1,
  pageSize: 10,
  total: 0,
  items: [],
  /** id → 显示名 */
  users: {},
  selectedId: null,
};

/** 实例状态的中文名与配色 */
const INSTANCE_STATUS_LABEL = {
  draft: "草稿",
  confirmed: "已确认",
  dispatched: "已下发",
  in_progress: "调查中",
  submitted: "已提交待审",
  under_review: "审核中",
  returned: "已退回",
  completed: "已完成",
  withdrawn: "已撤回",
};

const INSTANCE_STATUS_CLASS = {
  draft: "warn",
  confirmed: "warn",
  dispatched: "",
  in_progress: "",
  submitted: "warn",
  under_review: "warn",
  returned: "warn",
  completed: "ok",
  withdrawn: "",
};

/** 答卷状态的中文名 */
const RESPONSE_STATUS_LABEL = {
  draft: "填写中",
  submitted: "已提交",
  reviewed: "已通过",
  withdrawn: "已作废",
};

const userName = (id) => (id ? state.users[id] ?? id.slice(0, 8) : "—");

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
  if (state.onlyMine) params.set("assignedToMe", "true");

  const tbody = $("instance-rows");
  tbody.textContent = "";

  try {
    const data = await api(
      "GET",
      `/api/v1/questionnaire-instances?${params}`
    );
    state.items = data.items ?? [];
    state.users = data.users ?? {};
    state.total = data.total ?? 0;
    $("count-badge").textContent = `共 ${state.total} 个`;

    if (state.items.length === 0) {
      const tr = el("tr");
      tr.appendChild(
        el("td", {
          className: "empty",
          text: hasFilter()
            ? "没有符合条件的案件"
            : "还没有案件。可以到「下发问卷」用模板创建一个。",
          attrs: { colspan: "7" },
        })
      );
      tbody.appendChild(tr);
    } else {
      for (const it of state.items) tbody.appendChild(renderRow(it));
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
        text:
          e.code === "PERMISSION_DENIED"
            ? "当前账号没有查看案件的权限。试试切换到「下发人员」或「模板管理员」。"
            : `载入失败：${e.message}`,
        attrs: { colspan: "7" },
      })
    );
    tbody.appendChild(tr);
  }
}

function hasFilter() {
  return Boolean(state.keyword || state.status || state.onlyMine);
}

function renderRow(it) {
  const tr = el("tr", {
    className: it.id === state.selectedId ? "row-selected" : "",
  });

  tr.appendChild(el("td", { text: it.title }));

  const statusTd = el("td");
  statusTd.appendChild(
    el("span", {
      className: `tag ${INSTANCE_STATUS_CLASS[it.status] ?? ""}`,
      text: INSTANCE_STATUS_LABEL[it.status] ?? it.status,
    })
  );
  tr.appendChild(statusTd);

  // 下发给谁 —— 这是「已下发实例管理」最关键的一列
  tr.appendChild(
    el("td", {
      text: it.dispatch ? userName(it.dispatch.assignedTo) : "—",
    })
  );
  tr.appendChild(
    el("td", { text: it.dispatch?.dueAt ? fmtTime(it.dispatch.dueAt) : "—" })
  );

  const respTd = el("td");
  if (it.response) {
    respTd.appendChild(
      el("span", {
        className: `tag ${it.response.status === "reviewed" ? "ok" : it.response.status === "submitted" ? "warn" : ""}`,
        text: RESPONSE_STATUS_LABEL[it.response.status] ?? it.response.status,
      })
    );
  } else {
    respTd.appendChild(el("span", { className: "hint", text: "—" }));
  }
  tr.appendChild(respTd);

  tr.appendChild(el("td", { text: String(it.currentRevision) }));

  const actions = el("td", { className: "col-actions" });
  const view = button("查看", { className: "btn-ghost" });
  view.addEventListener("click", () => selectInstance(it.id));
  actions.appendChild(view);
  tr.appendChild(actions);

  return tr;
}

// ============================================================
// 详情
// ============================================================

async function selectInstance(instanceId) {
  state.selectedId = instanceId;
  // 刷新列表以更新选中行高亮
  const tbody = $("instance-rows");
  tbody.textContent = "";
  for (const it of state.items) tbody.appendChild(renderRow(it));

  const box = $("detail-body");
  box.textContent = "";
  box.appendChild(el("p", { className: "hint", text: "载入中…" }));

  try {
    const [detail, revs] = await Promise.all([
      api("GET", `/api/v1/questionnaire-instances/${instanceId}`),
      api("GET", `/api/v1/questionnaire-instances/${instanceId}/revisions`),
    ]);
    renderDetail(detail, revs.items ?? []);
  } catch (e) {
    box.textContent = "";
    box.appendChild(
      el("p", {
        className: "hint",
        text:
          e.code === "PERMISSION_DENIED"
            ? "无权查看这个案件（它不属于你，或你没有被指派）。"
            : `载入失败：${e.message}`,
      })
    );
  }
}

function renderDetail(detail, revisions) {
  const box = $("detail-body");
  box.textContent = "";

  const badge = $("detail-status");
  badge.textContent = INSTANCE_STATUS_LABEL[detail.status] ?? detail.status;
  badge.className = "badge " + (INSTANCE_STATUS_CLASS[detail.status] ?? "");
  $("detail-title").textContent = detail.title;

  const listRow = state.items.find((x) => x.id === detail.id);

  // ---- 概要 ----
  const { sections, questions } = countSchema(detail.currentSchema);
  const meta = el("div", { className: "meta-grid" });
  const rows = [
    ["案件 ID", detail.id],
    ["状态", INSTANCE_STATUS_LABEL[detail.status] ?? detail.status],
    ["结构规模", `${sections} 个分组 / ${questions} 道题`],
    ["当前修订", `revision ${detail.currentRevision}（共 ${revisions.length} 次变更）`],
    ["创建人", userName(detail.createdBy)],
    ["创建时间", fmtTime(detail.createdAt)],
    ["最后更新", fmtTime(detail.updatedAt)],
  ];
  if (listRow?.dispatch) {
    rows.push(
      ["下发给", userName(listRow.dispatch.assignedTo)],
      ["下发人", userName(listRow.dispatch.dispatchedBy)],
      ["下发任务", `${listRow.dispatch.status}${listRow.dispatch.withdrawnAt ? "（已撤回）" : ""}`],
      ["下发时间", fmtTime(listRow.dispatch.dispatchedAt)],
      ["截止时间", listRow.dispatch.dueAt ? fmtTime(listRow.dispatch.dueAt) : "（未设置）"]
    );
  }
  if (listRow?.response) {
    rows.push(
      [
        "答卷",
        `${RESPONSE_STATUS_LABEL[listRow.response.status] ?? listRow.response.status}` +
          `（填写人 ${userName(listRow.response.respondentId)}）`,
      ],
      [
        "提交时间",
        listRow.response.submittedAt ? fmtTime(listRow.response.submittedAt) : "（未提交）",
      ]
    );
  }
  for (const [k, v] of rows) {
    meta.appendChild(el("div", { className: "meta-key", text: k }));
    meta.appendChild(el("div", { className: "meta-val", text: String(v) }));
  }
  box.appendChild(meta);

  // ---- 结构预览 ----
  box.appendChild(el("h3", { className: "sub-title", text: "当前结构" }));
  const preview = el("div", { className: "structure-preview" });
  for (const s of detail.currentSchema.sections ?? []) {
    const secBox = el("div", { className: "pv-section" });
    secBox.appendChild(el("div", { className: "pv-title", text: s.title }));
    const ul = el("ul", { className: "pv-questions" });
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

  // ---- 变更历史 ----
  box.appendChild(el("h3", { className: "sub-title", text: "结构变更历史" }));
  const vlist = el("div", { className: "version-list" });
  for (const r of revisions) {
    const row = el("div", { className: "version-row" });
    const left = el("div", { className: "version-main" });
    left.appendChild(el("span", { className: "version-no", text: `rev ${r.revisionNo}` }));
    left.appendChild(
      el("span", { className: "tag", text: r.operationType ?? "（未知操作）" })
    );
    left.appendChild(el("span", { className: "hint", text: fmtTime(r.createdAt) }));
    row.appendChild(left);

    const right = el("div", { className: "version-actions" });
    const view = button("看快照", { className: "btn-ghost" });
    view.addEventListener("click", () => showSnapshot(detail.id, r.revisionNo));
    right.appendChild(view);
    row.appendChild(right);

    vlist.appendChild(row);
  }
  box.appendChild(vlist);

  applyActionButtons(detail, listRow);
}

/** 按当前状态决定三个动作是否可用（与后端的状态校验一致） */
function applyActionButtons(detail, listRow) {
  const canConfirm = detail.status === "draft";
  // 可撤回状态与后端 WITHDRAWABLE 常量一致
  const canWithdraw =
    detail.status === "dispatched" ||
    detail.status === "in_progress" ||
    detail.status === "submitted" ||
    detail.status === "under_review";
  // 扶正：未下发（没有已生效的下发任务）才允许
  const canPromote =
    detail.status === "draft" || detail.status === "confirmed";

  $("btn-confirm").disabled = !canConfirm;
  $("btn-withdraw").disabled = !canWithdraw;
  $("btn-promote").disabled = !canPromote;

  $("btn-confirm").title = canConfirm ? "" : `当前状态 ${detail.status} 不能确认`;
  $("btn-withdraw").title = canWithdraw
    ? ""
    : `当前状态 ${detail.status} 不能撤回`;
  $("btn-promote").title = canPromote
    ? ""
    : `当前状态 ${detail.status} 不能扶正`;

  void listRow;
}

/** 看某个 revision 的结构快照 */
async function showSnapshot(instanceId, revisionNo) {
  try {
    const snap = await api(
      "GET",
      `/api/v1/questionnaire-instances/${instanceId}/revisions/${revisionNo}`
    );
    const sections = snap.schema?.sections ?? [];
    const { questions } = countSchema(snap.schema);

    const backdrop = el("div", { className: "modal-backdrop" });
    const modal = el("div", { className: "modal" });

    const head = el("div", { className: "modal-head" });
    head.appendChild(
      el("h3", {
        text: `revision ${revisionNo} 的结构（${sections.length} 个分组 / ${questions} 道题）`,
      })
    );
    const close = button("关闭", { className: "btn btn-sm" });
    close.addEventListener("click", () => backdrop.remove());
    head.appendChild(close);
    modal.appendChild(head);

    const body = el("div", { className: "modal-body" });
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
    toast(`载入快照失败：${e.message}`, true);
  }
}

// ============================================================
// 生命周期动作
// ============================================================

async function doConfirm() {
  const id = state.selectedId;
  if (!id) return;

  const ok = await askText({
    title: "确认问卷",
    label: "确认后结构仍可修改，但只能撤回后重新下发。输入「确认」继续",
    placeholder: "确认",
    okText: "确认",
  });
  if (ok !== "确认") return;

  try {
    await api("POST", `/api/v1/questionnaire-instances/${id}/confirm`, {});
    toast("已确认");
    await loadList();
    await selectInstance(id);
  } catch (e) {
    toast(`确认失败：${e.message}`, true);
  }
}

async function doWithdraw() {
  const id = state.selectedId;
  if (!id) return;

  const reason = await askText({
    title: "撤回下发",
    label:
      "撤回会把既有答卷与下发任务一并作废（决策 D1），实例回到草稿。\n" +
      "输入「撤回」确认，可选填原因（用分号分隔，例如：撤回;原因）",
    placeholder: "撤回",
    okText: "撤回",
  });
  if (!reason || !reason.startsWith("撤回")) return;

  const actualReason = reason.includes(";") ? reason.split(";").slice(1).join(";").trim() : "";

  try {
    await api("POST", `/api/v1/questionnaire-instances/${id}/withdraw`, {
      ...(actualReason ? { reason: actualReason } : {}),
    });
    toast("已撤回，答卷与下发任务已作废");
    await loadList();
    await selectInstance(id);
  } catch (e) {
    if (e.code === "WITHDRAW_NOT_ALLOWED" || e.code === "INVALID_STATUS_TRANSITION") {
      toast(e.message, true);
    } else {
      toast(`撤回失败：${e.message}`, true);
    }
  }
}

async function doPromote() {
  const id = state.selectedId;
  if (!id) return;

  const note = await askText({
    title: "扶正为模板版本",
    label: "把当前案件的结构保存为一个模板草稿版本（决策 D2）。可填变更说明",
    placeholder: "例如：无人机核查新增活动轨迹分组",
    okText: "扶正",
  });
  // 允许留空（取消返回 null）
  if (note === null) return;

  try {
    const result = await api(
      "POST",
      `/api/v1/questionnaire-instances/${id}/promote`,
      { ...(note ? { changeNote: note } : {}) }
    );
    toast(
      `已扶正为模板草稿版本 v${result.versionNo ?? "?"}。\n` +
        "到「模板管理」可以查看并发布它。"
    );
  } catch (e) {
    if (e.code === "PROMOTE_NOT_ALLOWED" || e.code === "INVALID_STATUS_TRANSITION") {
      toast(e.message, true);
    } else {
      toast(`扶正失败：${e.message}`, true);
    }
  }
}

// ============================================================
// 初始化
// ============================================================

async function init() {
  const picker = await initUserPicker("dispatcher1");
  picker.onChange(() => {
    state.selectedId = null;
    $("detail-body").textContent = "";
    $("detail-body").appendChild(
      el("p", { className: "hint", text: "从左侧列表点一个案件查看详情。" })
    );
    $("detail-title").textContent = "案件详情";
    $("detail-status").textContent = "未选择";
    $("detail-status").className = "badge";
    loadList();
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

  $("only-mine").addEventListener("change", () => {
    state.onlyMine = $("only-mine").checked;
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

  $("btn-confirm").addEventListener("click", doConfirm);
  $("btn-withdraw").addEventListener("click", doWithdraw);
  $("btn-promote").addEventListener("click", doPromote);

  await loadList();
}

init();
