/**
 * 下发问卷页（首页）。
 *
 * 用户的日常最高频动作：**选一个模板 → 建一个案件 → 交给 AI 改**。
 *
 * 之前的实现是「列模板、取第一个有已发布版本的模板」，
 * 模板多于一个时行为不可预期。现在改成显式搜索选择。
 */

import {
  $,
  api,
  button,
  countSchema,
  el,
  fmtTime,
  initUserPicker,
  renderNav,
  toast,
} from "/common.js";

renderNav("dispatch");

const state = {
  keyword: "",
  page: 1,
  pageSize: 8,
  total: 0,
  items: [],
  /** 选中的模板版本 */
  picked: null,
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

  const box = $("pick-list");
  box.textContent = "";

  try {
    const data = await api(
      "GET",
      `/api/v1/questionnaire-templates/published-versions?${params}`
    );
    state.items = data.items ?? [];
    state.total = data.total ?? 0;
    $("count-badge").textContent = `共 ${state.total} 个可用模板`;

    if (state.items.length === 0) {
      box.appendChild(
        el("p", {
          className: "hint",
          text: state.keyword
            ? `没有匹配「${state.keyword}」的已发布模板`
            : "还没有已发布的模板。可以先去「从零创建」做一份，或到「模板管理」发布已有模板。",
        })
      );
    } else {
      for (const t of state.items) box.appendChild(renderItem(t));
    }

    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    $("page-info").textContent = `第 ${state.page} / ${pages} 页`;
    $("btn-prev").disabled = state.page <= 1;
    $("btn-next").disabled = state.page >= pages;
  } catch (e) {
    box.appendChild(
      el("p", { className: "hint", text: `载入失败：${e.message}` })
    );
  }
}

function renderItem(t) {
  const item = el("div", {
    className: "pick-item" + (state.picked?.versionId === t.versionId ? " selected" : ""),
  });

  const title = el("div", { className: "pick-title" });
  title.appendChild(el("span", { text: t.templateName }));
  title.appendChild(el("span", { className: "tag", text: `v${t.versionNo}` }));
  item.appendChild(title);

  // 结构规模：只看名字没法判断该选哪个模板
  const meta = el("div", { className: "pick-meta" });
  meta.appendChild(
    el("span", { text: `${t.sectionCount} 个分组 / ${t.questionCount} 道题` })
  );
  meta.appendChild(el("span", { text: `发布于 ${fmtTime(t.publishedAt)}` }));
  item.appendChild(meta);

  if (t.templateDescription) {
    item.appendChild(el("div", { className: "pick-desc", text: t.templateDescription }));
  }

  item.addEventListener("click", () => pick(t));
  return item;
}

// ============================================================
// 选中
// ============================================================

function pick(t) {
  state.picked = t;

  // 重画列表以更新选中态
  const box = $("pick-list");
  box.textContent = "";
  for (const x of state.items) box.appendChild(renderItem(x));

  const badge = $("picked-badge");
  badge.textContent = `${t.templateName} v${t.versionNo}`;
  badge.className = "badge ok";

  // 预填案件标题，减少输入
  const titleInput = $("title-input");
  if (!titleInput.value.trim()) {
    titleInput.value = `${t.templateName} - ${new Date().toLocaleDateString("zh-CN")}`;
  }

  $("btn-create").disabled = false;
  renderDetail();
}

function renderDetail() {
  const t = state.picked;
  const box = $("detail-body");
  box.textContent = "";

  if (!t) {
    box.appendChild(
      el("p", { className: "hint", text: "从左侧选一个模板，然后填案件标题即可创建。" })
    );
    return;
  }

  const card = el("div", { className: "result-card" });
  card.appendChild(el("div", { className: "result-name", text: t.templateName }));

  const meta = el("div", { className: "pick-meta" });
  meta.appendChild(el("span", { className: "tag", text: `v${t.versionNo}` }));
  meta.appendChild(
    el("span", { text: `${t.sectionCount} 个分组 / ${t.questionCount} 道题` })
  );
  meta.appendChild(el("span", { text: `发布于 ${fmtTime(t.publishedAt)}` }));
  card.appendChild(meta);

  if (t.templateDescription) {
    card.appendChild(
      el("div", { className: "pick-desc", text: t.templateDescription })
    );
  }

  box.appendChild(card);
  box.appendChild(
    el("p", {
      className: "hint",
      text:
        "创建后的案件会复制这份模板的结构。之后可以用 AI 继续改结构，" +
        "个案上的临时改动不会影响模板本身。",
    })
  );
}

// ============================================================
// 创建案件
// ============================================================

async function createInstance() {
  const t = state.picked;
  if (!t) {
    toast("请先选择一个模板", true);
    return;
  }

  const title = $("title-input").value.trim();
  if (!title) {
    toast("请填写案件标题", true);
    return;
  }

  const btn = $("btn-create");
  btn.disabled = true;
  btn.textContent = "创建中…";

  try {
    const inst = await api("POST", "/api/v1/questionnaire-instances", {
      templateVersionId: t.versionId,
      title,
    });
    const { sections, questions } = countSchema(inst.currentSchema);
    toast(`已创建案件「${inst.title}」（${sections} 个分组 / ${questions} 道题）`);

    renderCreated(inst, sections, questions);
    $("title-input").value = "";
  } catch (e) {
    if (e.code === "PERMISSION_DENIED") {
      toast("创建案件需要「下发人员」或「模板管理员」账号，请在右上角切换用户。", true);
    } else if (e.code === "INVALID_STATUS_TRANSITION") {
      toast(`该模板版本当前不可用：${e.message}`, true);
      await loadList();
    } else {
      toast(`创建失败：${e.message}`, true);
    }
  } finally {
    btn.disabled = !state.picked;
    btn.textContent = "创建案件";
  }
}

/**
 * 创建成功后的结果展示。
 *
 * 这一步是补上一个断点：原先点完创建只弹一个 toast，
 * 用户不知道案件 id 是多少、下一步该去哪。现在把 id 摆在眼前，
 * 并直接给出「用 AI 改这个案件」的入口。
 */
function renderCreated(inst, sections, questions) {
  const box = $("detail-body");
  box.textContent = "";

  const card = el("div", { className: "result-card" });
  card.appendChild(el("div", { className: "result-name", text: `✅ ${inst.title}` }));

  const meta = el("div", { className: "pick-meta" });
  meta.appendChild(el("span", { className: "tag", text: inst.status }));
  meta.appendChild(
    el("span", { text: `${sections} 个分组 / ${questions} 道题` })
  );
  meta.appendChild(el("span", { text: `revision ${inst.currentRevision}` }));
  card.appendChild(meta);

  // 案件 id 用等宽字体、可选中，方便复制
  const idRow = el("div", { className: "pick-desc" });
  idRow.appendChild(el("span", { text: "案件 ID：" }));
  idRow.appendChild(
    el("code", { className: "mono", text: inst.id })
  );
  card.appendChild(idRow);

  const actions = el("div", { className: "result-actions" });

  const copy = button("复制案件 ID");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inst.id);
      toast("已复制案件 ID");
    } catch {
      // 非 https / 无剪贴板权限时退化成提示用户手动选中
      toast("浏览器不允许自动复制，请手动选中上面的 ID", true);
    }
  });
  actions.appendChild(copy);

  const again = button("继续创建下一个");
  again.addEventListener("click", () => {
    state.picked = null;
    $("picked-badge").textContent = "未选择模板";
    $("picked-badge").className = "badge";
    $("btn-create").disabled = true;
    $("detail-body").textContent = "";
    $("detail-body").appendChild(
      el("p", { className: "hint", text: "从左侧选一个模板，然后填案件标题即可创建。" })
    );
  });
  actions.appendChild(again);

  card.appendChild(actions);
  box.appendChild(card);

  box.appendChild(
    el("p", {
      className: "hint",
      text:
        "接下来：到「模板管理」看模板，或直接用这个案件 ID 在 AI 里改结构 —— " +
        "个案上的临时改动不会影响模板本身。",
    })
  );
}

// ============================================================
// 初始化
// ============================================================

async function init() {
  const picker = await initUserPicker("dispatcher1");
  picker.onChange(() => {
    // 换用户后权限可能变了，重新拉一次
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

  $("btn-create").addEventListener("click", createInstance);

  $("title-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      createInstance();
    }
  });

  await loadList();
}

init();
