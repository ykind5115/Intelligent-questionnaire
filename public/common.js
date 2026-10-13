/**
 * 三个页面共用的工具。
 *
 * 为什么要抽出来：工作台、从零创建、模板管理三个页面都需要
 * 「带开发态鉴权的请求」「toast」「用户选择器」「顶栏 tab」。
 * 各写一份会**行为漂移** —— 之前已经出现过一次
 * （ai-api 测试里手搭的 app 与真实 app 不一致，掩盖了问题）。
 */

// ============================================================
// 环境与状态
// ============================================================

/**
 * 当前用户 id。
 *
 * 用模块级变量而不是挂在 window 上，避免多个页面脚本互相覆盖。
 */
let currentUserId = null;

export function getUserId() {
  return currentUserId;
}

export function setUserId(id) {
  currentUserId = id;
}

// ============================================================
// 请求
// ============================================================

/**
 * 统一的 API 调用。
 *
 * 两个要点：
 *   1. 只在**选定了用户之后**才带 x-user-id。
 *      页面刚加载时还没有用户，无条件带会发出字面量字符串 "null" 而被 401
 *      （这曾导致「登录不上」的故障）。
 *   2. 失败时抛出的 Error 上带 `code` 与 `status`，
 *      调用方据此区分权限 / 校验 / 冲突，而不是靠匹配文案。
 */
export async function api(method, path, body) {
  const headers = {};
  if (currentUserId) headers["x-user-id"] = currentUserId;
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
    e.detail = err.detail;
    throw e;
  }
  return payload ? payload.data : null;
}

// ============================================================
// DOM 小工具
// ============================================================

export const $ = (id) => document.getElementById(id);

export function el(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.attrs) {
    for (const [k, v] of Object.entries(options.attrs)) node.setAttribute(k, v);
  }
  return node;
}

/** 一个按钮（返回元素但未绑定事件，调用方自己绑） */
export function button(text, { className = "btn" } = {}) {
  const b = el("button", { className, text });
  b.type = "button";
  return b;
}

let toastTimer = null;

export function toast(message, isError = false) {
  const node = $("toast");
  if (!node) {
    // 页面没放 toast 容器时退化成 alert，避免静默吞掉错误
    if (isError) alert(message);
    return;
  }
  node.textContent = message;
  node.className = isError ? "toast error" : "toast";
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, isError ? 6000 : 3200);
}

/** 等待用户输入的单行文本（替代原生 prompt，样式统一且不会被浏览器拦截） */
export function askText({ title, label, value = "", placeholder = "", okText = "确定" }) {
  return new Promise((resolve) => {
    const backdrop = el("div", { className: "modal-backdrop" });
    const modal = el("div", { className: "modal modal-sm" });

    const head = el("div", { className: "modal-head" });
    head.appendChild(el("h3", { text: title }));
    modal.appendChild(head);

    const body = el("div", { className: "modal-body" });
    const field = el("label", { className: "field" });
    field.appendChild(el("span", { text: label }));
    const input = el("input", { attrs: { value, placeholder } });
    input.value = value;
    field.appendChild(input);
    body.appendChild(field);
    modal.appendChild(body);

    const footer = el("div", { className: "modal-foot" });
    const cancel = button("取消");
    const ok = button(okText, { className: "btn btn-primary" });
    footer.appendChild(cancel);
    footer.appendChild(ok);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    input.focus();
    input.select();

    const close = (result) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(null);
      if (e.key === "Enter" && document.activeElement === input) {
        close(input.value.trim() || null);
      }
    };

    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click", () => close(input.value.trim() || null));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(null);
    });
    document.addEventListener("keydown", onKey);
  });
}

// ============================================================
// 格式化
// ============================================================

export function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

export const TEMPLATE_STATUS_LABEL = {
  draft: "草稿",
  published: "已发布",
  disabled: "已停用",
};

export const TEMPLATE_STATUS_CLASS = {
  draft: "warn",
  published: "ok",
  disabled: "",
};

// ============================================================
// 用户选择器（开发态鉴权）
// ============================================================

/**
 * 填充顶栏的用户下拉，并返回选中的用户。
 *
 * 账号列表来自 /api/v1/dev/users（仅非生产环境）。
 * x-user-id 必须是真实 UUID，所以前端不能自己编造。
 *
 * @param preferredUsername 优先选中的用户名（如模板管理页用 admin）
 */
export async function initUserPicker(preferredUsername) {
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

  const preferred =
    (preferredUsername && users.find((u) => u.username === preferredUsername)) ||
    users.find((u) => u.username === "dispatcher1") ||
    users[0];

  if (preferred) {
    select.value = preferred.id;
    currentUserId = preferred.id;
  }

  /** 当前选中用户是否具备某角色 */
  const hasRole = (role) => {
    const opt = select.options[select.selectedIndex];
    return (opt?.textContent ?? "").includes(role);
  };

  const onChange = (handler) => {
    select.addEventListener("change", () => {
      currentUserId = select.value;
      const opt = select.options[select.selectedIndex];
      toast(`已切换为 ${opt ? opt.textContent : select.value}`);
      if (handler) handler();
    });
  };

  return { users, select, hasRole, onChange };
}

// ============================================================
// 顶栏导航
// ============================================================

/**
 * 四个页面共用的顶栏 tab。
 *
 * 顺序按使用频率排：日常最常用的「下发问卷」在最左。
 */
export const NAV_ITEMS = [
  { href: "/", label: "下发问卷", key: "dispatch" },
  { href: "/instances.html", label: "案件管理", key: "instances" },
  { href: "/create.html", label: "从零创建", key: "create" },
  { href: "/templates.html", label: "模板管理", key: "templates" },
];

/** 渲染顶栏导航并高亮当前页 */
export function renderNav(activeKey) {
  const box = $("nav");
  if (!box) return;
  box.textContent = "";
  for (const item of NAV_ITEMS) {
    const a = el("a", {
      className: "nav-item" + (item.key === activeKey ? " active" : ""),
      text: item.label,
      attrs: { href: item.href },
    });
    box.appendChild(a);
  }
}

// ============================================================
// 结构摘要
// ============================================================

/** 从 QuestionnaireSchema 里数出分组与题目总数 */
export function countSchema(schema) {
  const sections = schema?.sections ?? [];
  return {
    sections: sections.length,
    questions: sections.reduce((n, s) => n + (s.questions?.length ?? 0), 0),
  };
}
