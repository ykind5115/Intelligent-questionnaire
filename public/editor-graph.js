/**
 * 节点画布（Node-based Graph Editor）—— 自研 SVG，零依赖。
 *
 * 依据 docs/12-node-graph-editor-research.md 与 docs/11 §4.12。
 *
 * 为什么自研而不是引 AntV X6：
 *   前端是无构建链的原生 ES 模块（AGENT.md 第 7 节），X6 只能自托管约 570KB 的
 *   UMD 产物并挂到 window 上，与这里的 ESM 风格不一致，样式也要重做。
 *   而问卷的图结构很受限 —— 边只有三种（顺序 / 分支 / 终点），
 *   节点数量在几十的量级，自己画 SVG 完全够用，还能和现有页面风格保持一致。
 *
 * 边只有三种，这是理解本文件的关键：
 *   1. **顺序边**（灰实线）：没配 defaultNext 时，按 order 走下一题；
 *   2. **分支边**（彩色虚线 + 条件标签）：branches 里命中的那条；
 *   3. **终点边**（灰虚线到 END）：defaultNext === null 时本题即终点。
 *
 * 坐标与结构的分离：
 *   坐标存在 schema.layout 里，写入走**只更新 layout 键**的接口
 *   （见 questionnaire.repository.mergeTemplateVersionLayout），
 *   因此拖节点永远不会改动结构，也不会产生审计。
 */
const NS = "http://www.w3.org/2000/svg";

/** 节点尺寸与间距（逻辑坐标，不随缩放变化） */
const NODE_W = 232;
const NODE_H = 88;
const COL_GAP = 96;
const ROW_GAP = 48;
const PAD = 64;

/** 分支边的配色（按规则序号循环） */
const EDGE_COLORS = [
  "#2f6fdb",
  "#c2410c",
  "#7c3aed",
  "#0f766e",
  "#b91c1c",
  "#0369a1",
];

const TYPE_LABEL = {
  text: "文本",
  textarea: "长文本",
  number: "数字",
  single_choice: "单选",
  multiple_choice: "多选",
  date: "日期",
  datetime: "日期时间",
  boolean: "是非",
};

const OP_LABEL = {
  eq: "=",
  ne: "≠",
  in: "∈",
  not_in: "∉",
  is_answered: "已答",
  is_empty: "未答",
};

// ============================================================
// 小工具
// ============================================================

function s(tag, attrs = {}, children = []) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    node.setAttribute(k, String(v));
  }
  for (const child of children) {
    if (child) node.appendChild(child);
  }
  return node;
}

function text(content, attrs = {}) {
  const node = s("text", attrs);
  node.textContent = content;
  return node;
}

/**
 * 按估算宽度截断文本。
 *
 * SVG 没有 CSS 的 text-overflow，只能自己算。中日韩字符约 1 个字宽、
 * ASCII 约 0.55 个字宽 —— 这是估算，目的只是别让长题干溢出节点。
 */
function truncate(str, maxPx, fontSize) {
  const cjk = fontSize;
  const ascii = fontSize * 0.55;
  let width = 0;
  let out = "";
  for (const ch of String(str ?? "")) {
    const w = /[\u2E80-\uFFFF]/.test(ch) ? cjk : ascii;
    if (width + w > maxPx) return `${out}…`;
    width += w;
    out += ch;
  }
  return out;
}

function describeRule(rule, byId) {
  const op = OP_LABEL[rule.when.op] ?? rule.when.op;
  if (rule.when.op === "is_answered" || rule.when.op === "is_empty") return op;

  const target = byId.get(rule.when.questionId);
  const options = target?.options ?? [];
  const raw = rule.when.value;

  let shown;
  if (Array.isArray(raw)) {
    shown = raw
      .map((v) => {
        const opt = options.find((o) => o.id === String(v));
        return opt ? opt.label : String(v);
      })
      .join("/");
  } else if (typeof raw === "boolean") {
    shown = raw ? "是" : "否";
  } else {
    const opt = options.find((o) => o.id === String(raw));
    shown = opt ? opt.label : String(raw ?? "");
  }
  return `${op} ${shown}`;
}

// ============================================================
// 图模型
// ============================================================

/**
 * 把 schema 变成节点与边。
 *
 * @param {object} schema 问卷结构
 * @param {Map<string, {x:number,y:number}>} live 本次会话里拖过、可能还没落库的坐标
 */
function buildModel(schema, live) {
  const sections = [...(schema.sections ?? [])].sort((a, b) => a.order - b.order);
  const savedLayout = schema.layout ?? {};

  const nodes = [];
  const order = [];

  sections.forEach((section, colIndex) => {
    const questions = [...(section.questions ?? [])].sort(
      (a, b) => a.order - b.order
    );
    questions.forEach((q, rowIndex) => {
      order.push(q.id);

      // 坐标优先级：本次拖动过的 > 库里存过的 > 自动布局
      const pos = live.get(q.id) ?? savedLayout[q.id];
      const fallback = {
        x: PAD + colIndex * (NODE_W + COL_GAP),
        y: PAD + rowIndex * (NODE_H + ROW_GAP),
      };

      nodes.push({
        id: q.id,
        title: q.title,
        type: q.type,
        options: q.options ?? [],
        required: Boolean(q.required),
        sectionId: section.id,
        sectionTitle: section.title,
        branches: q.branches ?? [],
        defaultNext: q.defaultNext,
        x: pos ? pos.x : fallback.x,
        y: pos ? pos.y : fallback.y,
      });
    });
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));

  const edges = [];
  const nextOf = (id) => {
    const i = order.indexOf(id);
    return i >= 0 && i + 1 < order.length ? order[i + 1] : null;
  };

  for (const node of nodes) {
    // 1) 分支边
    node.branches.forEach((rule, i) => {
      if (!byId.has(rule.goTo)) return; // 悬空引用由后端拦截，这里防御性跳过
      edges.push({
        kind: "branch",
        from: node.id,
        to: rule.goTo,
        // 第几条规则：删除/改目标时要定位到具体一条
        index: i,
        color: EDGE_COLORS[i % EDGE_COLORS.length],
        label: describeRule(rule, byId),
      });
    });

    // 2) 默认去向
    if (node.defaultNext === null) {
      edges.push({ kind: "end", from: node.id, to: null, index: 0 });
    } else if (typeof node.defaultNext === "string") {
      if (byId.has(node.defaultNext)) {
        edges.push({
          kind: "default",
          from: node.id,
          to: node.defaultNext,
          index: 0,
        });
      }
    } else {
      const next = nextOf(node.id);
      edges.push(
        next
          ? { kind: "order", from: node.id, to: next, index: 0 }
          : { kind: "end", from: node.id, to: null, index: 0 }
      );
    }
  }

  // 起点 / 终点位置
  const first = nodes[0];
  const start = first
    ? { x: first.x + NODE_W / 2 - 44, y: first.y - 84 }
    : { x: PAD, y: PAD };

  let endY = PAD;
  for (const n of nodes) endY = Math.max(endY, n.y + NODE_H + 96);
  for (const e of edges) {
    if (e.kind !== "end") continue;
    const from = byId.get(e.from);
    if (from) endY = Math.max(endY, from.y + NODE_H + 72);
  }
  const end = {
    x:
      PAD +
      Math.max(0, sections.length - 1) * (NODE_W + COL_GAP) +
      NODE_W / 2 -
      48,
    y: endY,
  };

  return { nodes, edges, start, end, byId, order };
}

/** 从源节点下边中点到目标节点上边中点的曲线 */
function edgePath(from, to) {
  const sx = from.x + NODE_W / 2;
  const sy = from.y + NODE_H;
  const dx = to.x + NODE_W / 2;
  const dy = to.y;

  // 目标在下方：竖直控制点，读起来像「往下流」
  if (dy >= sy + 20) {
    const k = Math.max(28, (dy - sy) / 2);
    return `M ${sx} ${sy} C ${sx} ${sy + k}, ${dx} ${dy - k}, ${dx} ${dy}`;
  }
  // 目标在上方（回跳 / 跨列）：向右鼓出去，避免压住中间节点
  const bulge = 110;
  return `M ${sx} ${sy} C ${sx + bulge} ${sy + 40}, ${dx + bulge} ${dy - 40}, ${dx} ${dy}`;
}

function edgeMid(from, to) {
  const sx = from.x + NODE_W / 2;
  const sy = from.y + NODE_H;
  const dx = to.x + NODE_W / 2;
  const dy = to.y;
  return { x: (sx + dx) / 2 + 18, y: (sy + dy) / 2 };
}

// ============================================================
// 画布
// ============================================================

/**
 * @param {{
 *   host: HTMLElement,
 *   getSchema: () => object | null,
 *   getUnreachable?: () => string[],
 *   canEdit: () => boolean,
 *   onEditQuestion: (id: string) => void,
 *   onBranchEdit: (id: string, prefillGoTo?: string) => void,\n *   onEdgeClick?: (edge: {kind: string, from: string, to: string|null, index: number, label: string|null}) => void,
 *   onToast: (msg: string, isError?: boolean) => void,
 *   saveLayout: (positions: Record<string, {x:number,y:number}>) => Promise<void>,
 * }} opts
 */
export function createNodeGraph(opts) {
  const host = opts.host;

  /** 视图变换，跨重绘保留 */
  const view = { tx: 24, ty: 8, k: 0.9 };

  /**
   * 本次会话里被拖动过的坐标。
   *
   * 为什么必须有这个「影子层」：坐标保存是防抖的（600ms），
   * 而拖完节点后紧接着的点击会触发重绘。
   * 如果重绘只认 schema.layout，节点会**跳回拖动之前的位置** ——
   * 用户会以为拖动没生效，然后再拖一次，非常难受。
   */
  const live = new Map();

  let selectedId = null;
  let drag = null;
  let connect = null;

  let pendingSave = new Map();
  let saveTimer = null;

  let svg = null;
  let viewport = null;
  let cleanupWindowHandlers = null;

  // ---------- 坐标保存 ----------

  function queueSave(id, x, y) {
    pendingSave.set(id, { x, y });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), 600);
  }

  async function flushSave() {
    saveTimer = null;
    if (pendingSave.size === 0) return;
    const payload = Object.fromEntries(pendingSave);
    pendingSave = new Map();
    try {
      await opts.saveLayout(payload);
    } catch (e) {
      opts.onToast(`坐标保存失败：${e.message}`, true);
    }
  }

  // ---------- 渲染 ----------

  function render() {
    const schema = opts.getSchema();
    if (!schema) return;

    // 关键：先拆掉上一轮挂在 window 上的监听，否则每次点击都会叠加一份
    cleanup();
    host.replaceChildren();

    const model = buildModel(schema, live);

    svg = s("svg", { class: "node-graph", xmlns: NS });
    svg.appendChild(buildDefs());

    viewport = s("g", { class: "graph-viewport" });
    viewport.appendChild(renderStart(model));

    const edgeLayer = s("g", { class: "graph-edges" });
    for (const edge of model.edges) {
      const el = renderEdge(edge, model);
      if (el) edgeLayer.appendChild(el);
    }
    viewport.appendChild(edgeLayer);

    const nodeLayer = s("g", { class: "graph-nodes" });
    for (const node of model.nodes) nodeLayer.appendChild(renderNode(node, model));
    viewport.appendChild(nodeLayer);

    viewport.appendChild(renderEnd(model));

    if (connect) {
      viewport.appendChild(
        s("line", {
          class: "graph-temp-link",
          x1: connect.sx,
          y1: connect.sy,
          x2: connect.cx,
          y2: connect.cy,
        })
      );
    }

    svg.appendChild(viewport);
    applyView();
    host.appendChild(svg);

    if (model.nodes.length === 0) {
      const empty = document.createElement("p");
      empty.className = "hint graph-empty";
      empty.textContent =
        "这份问卷还没有题目。先「+ 添加分组」，再往分组里加题。";
      host.appendChild(empty);
    }

    // 第一次进入（一个坐标都没存过）自动适配视野
    if (!model.nodes.some((n) => live.has(n.id) || schema.layout?.[n.id])) {
      fitTo(model, { silent: true });
    }

    bindEvents(model);
  }

  function buildDefs() {
    const defs = s("defs");
    for (const [id, color] of [
      ["arrow-solid", "#94a3b8"],
      ["arrow-branch", "#2f6fdb"],
    ]) {
      const marker = s("marker", {
        id,
        viewBox: "0 0 10 10",
        refX: 9,
        refY: 5,
        markerWidth: 7,
        markerHeight: 7,
        orient: "auto-start-reverse",
      });
      marker.appendChild(s("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: color }));
      defs.appendChild(marker);
    }
    return defs;
  }

  function applyView() {
    if (!viewport) return;
    viewport.setAttribute(
      "transform",
      `translate(${view.tx} ${view.ty}) scale(${view.k})`
    );
  }

  function fitTo(model, { silent } = {}) {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) {
      // 视图被隐藏（在列表视图下）时拿不到尺寸，静默跳过
      if (!silent) opts.onToast("画布还没布局完成，稍后再试");
      return;
    }

    const xs = model.nodes.map((n) => n.x);
    const ys = model.nodes.map((n) => n.y);
    const minX = Math.min(model.start.x, ...xs);
    const maxX = Math.max(model.end.x + 96, ...xs.map((x) => x + NODE_W));
    const minY = Math.min(model.start.y, ...ys);
    const maxY = Math.max(model.end.y + 34, ...ys.map((y) => y + NODE_H));

    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);

    view.k = Math.min(
      1.1,
      Math.max(
        0.25,
        Math.min((w / contentW) * 0.92, (h / contentH) * 0.92)
      )
    );
    view.tx = (w - contentW * view.k) / 2 - minX * view.k;
    view.ty = (h - contentH * view.k) / 2 - minY * view.k;
    applyView();
  }

  function renderStart(model) {
    const g = s("g", { class: "graph-terminal graph-start" });
    g.appendChild(
      s("rect", {
        x: model.start.x,
        y: model.start.y,
        width: 88,
        height: 34,
        rx: 17,
      })
    );
    g.appendChild(
      text("开始", {
        x: model.start.x + 44,
        y: model.start.y + 22,
        "text-anchor": "middle",
      })
    );

    const first = model.nodes[0];
    if (first) {
      g.appendChild(
        s("path", {
          class: "graph-edge edge-order",
          d: `M ${model.start.x + 44} ${model.start.y + 34} C ${
            model.start.x + 44
          } ${model.start.y + 62}, ${first.x + NODE_W / 2} ${first.y - 30}, ${
            first.x + NODE_W / 2
          } ${first.y}`,
          "marker-end": "url(#arrow-solid)",
        })
      );
    }
    return g;
  }

  function renderEnd(model) {
    const g = s("g", { class: "graph-terminal graph-end" });
    g.appendChild(
      s("rect", {
        x: model.end.x,
        y: model.end.y,
        width: 96,
        height: 34,
        rx: 17,
      })
    );
    g.appendChild(
      text("结束", {
        x: model.end.x + 48,
        y: model.end.y + 22,
        "text-anchor": "middle",
      })
    );
    return g;
  }

  function renderEdge(edge, model) {
    const from = model.byId.get(edge.from);
    if (!from) return null;

    const g = s("g", { class: `graph-edge-group edge-${edge.kind}` });

    if (edge.kind === "end") {
      const sx = from.x + NODE_W / 2;
      const sy = from.y + NODE_H;
      const dx = model.end.x + 48;
      const dy = model.end.y;
      const d = `M ${sx} ${sy} C ${sx} ${sy + 54}, ${dx} ${dy - 54}, ${dx} ${dy}`;

      g.appendChild(
        s("path", {
          class: "graph-edge edge-end",
          d,
          "marker-end": "url(#arrow-solid)",
        })
      );
      g.appendChild(makeEdgeHit(d, edge));
      return g;
    }

    const to = model.byId.get(edge.to);
    if (!to) return null;

    const d = edgePath(from, to);

    g.appendChild(
      s("path", {
        class: `graph-edge edge-${edge.kind}`,
        d,
        ...(edge.color ? { stroke: edge.color } : {}),
        "marker-end":
          edge.kind === "branch" ? "url(#arrow-branch)" : "url(#arrow-solid)",
      })
    );

    // 命中区：细线很难点中，盖一条透明的宽线专门接收点击
    g.appendChild(makeEdgeHit(d, edge));

    if (edge.label) {
      const mid = edgeMid(from, to);
      const w = edge.label.length * 7 + 16;
      const label = s("g", { class: "graph-edge-label" });
      label.appendChild(
        s("rect", {
          x: mid.x - w / 2,
          y: mid.y - 20,
          width: w,
          height: 20,
          rx: 5,
          fill: "#ffffff",
          stroke: edge.color,
        })
      );
      label.appendChild(
        text(edge.label, {
          x: mid.x,
          y: mid.y - 5,
          "text-anchor": "middle",
          fill: edge.color,
        })
      );
      g.appendChild(label);
    }

    return g;
  }

  /**
   * 边的点击命中区。
   *
   * 为什么需要单独一条「透明宽线」：SVG 的线只有 1.6px 宽，
   * 鼠标很难点中；而把可见线加粗又会破坏视觉。所以盖一条
   * stroke-width 较大的透明线，专门接收点击与悬停。
   *
   * 为什么要 stopPropagation：画布的 pointerdown 会把「在空白处按下」
   * 当成平移起点。点在边上时若继续冒泡，画布会开始平移 —— 手感很怪。
   */
  function makeEdgeHit(d, edge) {
    const hit = s("path", { class: "graph-edge-hit", d });

    hit.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });

    hit.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!opts.canEdit()) {
        opts.onToast?.("当前为只读视图，不能修改连接", true);
        return;
      }
      opts.onEdgeClick?.({
        kind: edge.kind,
        from: edge.from,
        to: edge.to ?? null,
        index: edge.index ?? 0,
        label: edge.label ?? null,
      });
    });

    return hit;
  }

  function renderNode(node, model) {
    const isSelected = node.id === selectedId;
    const unreachable = (opts.getUnreachable?.() ?? []).includes(node.id);

    const g = s("g", {
      class: "graph-node",
      "data-id": node.id,
      transform: `translate(${node.x} ${node.y})`,
    });

    g.appendChild(
      s("rect", {
        class: "node-box",
        width: NODE_W,
        height: NODE_H,
        rx: 10,
        ...(isSelected ? { "stroke-width": 2.5 } : {}),
        ...(unreachable ? { "stroke-dasharray": "5 4" } : {}),
      })
    );

    const idx = model.order.indexOf(node.id) + 1;
    g.appendChild(
      s("rect", { class: "node-seq", x: 12, y: 12, width: 24, height: 20, rx: 5 })
    );
    g.appendChild(
      text(String(idx), {
        class: "node-seq-text",
        x: 24,
        y: 26,
        "text-anchor": "middle",
      })
    );

    g.appendChild(
      text(truncate(node.title, NODE_W - 56, 13), {
        class: "node-title",
        x: 44,
        y: 27,
      })
    );

    const meta = [
      node.sectionTitle,
      TYPE_LABEL[node.type] ?? node.type,
      node.required ? "必填" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    g.appendChild(
      text(truncate(meta, NODE_W - 24, 11), {
        class: "node-meta",
        x: 12,
        y: NODE_H - 14,
      })
    );

    if (node.branches.length > 0) {
      g.appendChild(
        s("rect", {
          class: "node-branch-badge",
          x: NODE_W - 44,
          y: NODE_H - 27,
          width: 32,
          height: 18,
          rx: 9,
        })
      );
      g.appendChild(
        text(`⇢${node.branches.length}`, {
          class: "node-branch-text",
          x: NODE_W - 28,
          y: NODE_H - 14,
          "text-anchor": "middle",
        })
      );
    }

    if (unreachable) {
      g.appendChild(
        text("⚠", { class: "node-warn", x: NODE_W - 18, y: 22, "text-anchor": "middle" })
      );
    }

    if (opts.canEdit()) {
      const anchor = s("circle", {
        class: "node-anchor",
        cx: NODE_W / 2,
        cy: NODE_H,
        r: 6,
      });
      anchor.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        startConnect(e, node);
      });
      g.appendChild(anchor);
    }

    g.addEventListener("pointerdown", (e) => startDrag(e, node));
    g.addEventListener("click", (e) => {
      e.stopPropagation();
      selectedId = node.id;
      render();
    });
    g.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (opts.canEdit()) opts.onEditQuestion(node.id);
    });

    return g;
  }

  // ---------- 交互 ----------

  function clientToWorld(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.tx) / view.k,
      y: (clientY - rect.top - view.ty) / view.k,
    };
  }

  function startDrag(e, node) {
    if (!opts.canEdit() || e.button !== 0) return;
    e.stopPropagation();

    const origin = clientToWorld(e.clientX, e.clientY);
    drag = {
      id: node.id,
      dx: node.x - origin.x,
      dy: node.y - origin.y,
      moved: false,
    };
  }

  function startConnect(e, node) {
    const p = clientToWorld(e.clientX, e.clientY);
    connect = {
      from: node.id,
      sx: node.x + NODE_W / 2,
      sy: node.y + NODE_H,
      cx: p.x,
      cy: p.y,
    };
    render();
  }

  function bindEvents(model) {
    if (!svg) return;

    // 平移 / 取消选中
    svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest?.(".graph-node")) return;

      const start = { x: e.clientX, y: e.clientY };
      const base = { tx: view.tx, ty: view.ty };
      let moved = false;

      const onMove = (ev) => {
        const ddx = ev.clientX - start.x;
        const ddy = ev.clientY - start.y;
        if (Math.abs(ddx) + Math.abs(ddy) > 3) moved = true;
        view.tx = base.tx + ddx;
        view.ty = base.ty + ddy;
        applyView();
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (!moved && selectedId !== null) {
          selectedId = null;
          render();
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    // 缩放：以光标为中心
    svg.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = svg.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;

        const nextK = Math.min(
          2.4,
          Math.max(0.2, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12))
        );
        const ratio = nextK / view.k;
        view.tx = px - (px - view.tx) * ratio;
        view.ty = py - (py - view.ty) * ratio;
        view.k = nextK;
        applyView();
      },
      { passive: false }
    );

    const onPointerMove = (e) => {
      if (drag) {
        const p = clientToWorld(e.clientX, e.clientY);
        const node = model.byId.get(drag.id);
        if (!node) return;
        const nx = Math.round(p.x + drag.dx);
        const ny = Math.round(p.y + drag.dy);
        if (nx === node.x && ny === node.y) return;

        drag.moved = true;
        node.x = nx;
        node.y = ny;
        live.set(node.id, { x: nx, y: ny });
        const g = svg.querySelector(`[data-id="${drag.id}"]`);
        if (g) g.setAttribute("transform", `translate(${nx} ${ny})`);
      } else if (connect) {
        const p = clientToWorld(e.clientX, e.clientY);
        connect.cx = p.x;
        connect.cy = p.y;
        const line = svg.querySelector(".graph-temp-link");
        if (line) {
          line.setAttribute("x2", String(p.x));
          line.setAttribute("y2", String(p.y));
        }
      }
    };

    const onPointerUp = (e) => {
      if (drag) {
        const node = model.byId.get(drag.id);
        if (node && drag.moved) queueSave(node.id, node.x, node.y);
        drag = null;
      }

      if (connect) {
        const target = document
          .elementFromPoint(e.clientX, e.clientY)
          ?.closest?.(".graph-node");
        const targetId = target?.getAttribute("data-id");
        const from = connect.from;
        connect = null;

        if (targetId && targetId !== from) {
          // 拖线到某个节点 = 为它建一条分支（条件留空，交给弹窗里填）
          opts.onBranchEdit(from, targetId);
        } else {
          render();
        }
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    cleanupWindowHandlers = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }

  /** 拆掉 window 级监听（每次重绘前、以及 destroy 时都要调） */
  function cleanup() {
    if (cleanupWindowHandlers) {
      cleanupWindowHandlers();
      cleanupWindowHandlers = null;
    }
  }

  // ---------- 对外 ----------

  return {
    render,

    /** 视野适配内容 */
    fit() {
      const schema = opts.getSchema();
      if (schema) fitTo(buildModel(schema, live));
    },

    /** 重新排布：按自动布局算一遍并整体保存 */
    async autoLayout() {
      const schema = opts.getSchema();
      if (!schema) return;

      const fresh = buildModel({ ...schema, layout: {} }, new Map());
      const positions = {};
      for (const n of fresh.nodes) positions[n.id] = { x: n.x, y: n.y };

      await opts.saveLayout(positions);
      for (const n of fresh.nodes) live.set(n.id, { x: n.x, y: n.y });
      opts.onToast("已重新排布并保存");
      render();
      fitTo(buildModel(opts.getSchema(), live));
    },

    /** 把还没落盘的坐标立即保存（切视图 / 离开页面前用） */
    flush() {
      return flushSave();
    },

    destroy() {
      cleanup();
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      host.replaceChildren();
      svg = null;
      viewport = null;
    },
  };
}
