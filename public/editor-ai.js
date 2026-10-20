/**
 * AI 对话面板（嵌在编辑器左侧）。
 *
 * 依据：把原「从零创建」页合并进「问卷编辑器」后的三栏之一。
 *
 * ## 与原来的 create.js 有什么不同
 *
 * 原页面是「对话驱动」：先起名 → 建模板 → 对话生成 → 定稿 → 发布 → 建案。
 * 合并后改为「编辑器驱动」：**AI 永远编辑当前打开的这个草稿版本**。
 * 因此这里不再负责建模板/定稿/发布（那些在编辑器工具栏上），
 * 只负责「围绕当前版本对话」。
 *
 * 绑定方式：`POST /ai/conversations` 用
 * `{ scene: "create_template", targetType: "template", targetId: <草稿版本 id> }`。
 * 后端对该组合的语义是「绑定这个 draft 版本」，而不是新建模板 ——
 * 因此 AI 的改动与手工编辑落在同一份结构上，两边天然一致。
 *
 * ## 为什么每个版本一个会话
 *
 * 会话一旦创建，其 scene 与 target 就固定下来。切换模板/版本后若复用旧会话，
 * AI 会继续改上一个版本 —— 那是最难察觉的一类错误（看着像改了，其实改错了对象）。
 * 因此这里按 versionId 缓存会话，切换时重新绑定。
 */
import { $, api, el, getUserId, toast } from "/common.js";

/** 工具名 → 中文说明（与后端 Tool Registry 对应） */
const TOOL_LABELS = {
  add_section: "新增分组",
  add_question: "新增题目",
  update_section: "修改分组",
  update_question: "修改题目",
  remove_question: "删除题目",
  move_question: "移动题目",
  set_question_branch: "设置分支",
  get_questionnaire: "读取问卷",
};

/**
 * @param {{
 *   getVersionId: () => string | null,
 *   canEdit: () => boolean,
 *   onStructureChanged: () => Promise<void> | void,
 * }} opts
 */
export function createChatPanel(opts) {
  /** versionId → conversationId */
  const conversations = new Map();
  let streaming = false;

  const log = () => $("chat-log");

  function setStatus(text, kind) {
    const node = $("chat-status");
    if (!node) return;
    node.textContent = text;
    node.className = "badge" + (kind ? ` ${kind}` : "");
  }

  function addMessage(role, text) {
    const node = el("div", { className: `msg ${role}`, text });
    log().appendChild(node);
    node.scrollIntoView({ block: "end" });
    return node;
  }

  function addToolLine(toolName) {
    const line = el("div", { className: "tool running" });
    line.appendChild(el("span", { className: "dot" }));
    line.appendChild(el("code", { text: TOOL_LABELS[toolName] ?? toolName }));
    const label = el("span", { text: "执行中…" });
    line.appendChild(label);
    log().appendChild(line);
    line.scrollIntoView({ block: "end" });
    return { line, label };
  }

  /** 版本切换或首次进入时，更新提示语与按钮状态 */
  function render() {
    const versionId = opts.getVersionId();

    if (!versionId) {
      setStatus("未打开");
    } else if (!opts.canEdit()) {
      setStatus("只读", "warn");
    } else if (conversations.has(versionId)) {
      setStatus("已绑定");
    } else {
      setStatus("待提问");
    }

    const input = $("chat-input");
    const send = $("chat-send");
    const disabled = streaming || !versionId || !opts.canEdit();
    if (input) input.disabled = disabled;
    if (send) send.disabled = disabled;
  }

  /** 确保当前版本有会话；没有就创建 */
  async function ensureConversation(versionId) {
    const cached = conversations.get(versionId);
    if (cached) return cached;

    const conv = await api("POST", "/api/v1/ai/conversations", {
      scene: "create_template",
      targetType: "template",
      // 关键：给了 targetId 就绑定这个草稿版本，不新建模板
      targetId: versionId,
    });

    conversations.set(versionId, conv.conversationId);
    return conv.conversationId;
  }

  /** 发一条消息并消费 SSE 流 */
  async function send(content) {
    if (streaming) return;

    const versionId = opts.getVersionId();
    if (!versionId) {
      toast("先新建或加载一个模板草稿，再让 AI 帮忙", true);
      return;
    }
    if (!opts.canEdit()) {
      toast("当前版本只读或当前账号不是模板管理员，不能修改", true);
      return;
    }

    let conversationId;
    try {
      conversationId = await ensureConversation(versionId);
    } catch (e) {
      toast(`无法开始对话：${e.message}`, true);
      return;
    }

    streaming = true;
    render();
    addMessage("user", content);

    const bubble = addMessage("assistant", "");
    const tools = new Map();
    let sawUpdate = false;

    try {
      const res = await fetch(
        `/api/v1/ai/conversations/${conversationId}/messages/stream`,
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
          case "tool_call_start":
            tools.set(payload.operationId, addToolLine(payload.toolName));
            break;
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

      if (sawUpdate) await opts.onStructureChanged();
    } catch (e) {
      addMessage("error", `连接中断：${e.message}`);
    } finally {
      streaming = false;
      render();
      $("chat-input")?.focus();
    }
  }

  /** 绑定表单事件（只绑一次） */
  function bind() {
    const form = $("chat-form");
    if (!form || form.dataset.bound === "1") return;
    form.dataset.bound = "1";

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = $("chat-input");
      const content = input.value.trim();
      if (!content) return;
      input.value = "";
      await send(content);
    });

    $("chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  }

  return {
    /** 页面初始化时调用一次 */
    init() {
      bind();
      render();
    },
    /** 版本切换后调用 */
    render,
    /** 切到新版本时清掉该版本的会话缓存（例如草稿被发布后） */
    forget(versionId) {
      conversations.delete(versionId);
    },
    /**
     * 清空全部会话缓存。
     *
     * **切换用户时必须调用**：会话归属于创建它的用户，
     * 换账号后继续用缓存里的会话 id 发消息会得到 403（访问他人会话）。
     * 现象是「换了用户就发不出消息」，很容易被误判成权限配置问题。
     */
    reset() {
      conversations.clear();
      render();
    },
  };
}
