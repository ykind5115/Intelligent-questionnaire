/**
 * 开发态鉴权中间件的边界测试（决策 D11）。
 *
 * 这个文件来自一次真实故障：
 *   前端 api() 无条件带 `x-user-id: state.userId`，而页面刚加载时
 *   state.userId 还是 null，于是浏览器发出了字面量字符串 "null"，
 *   后端按 UUID 校验直接 401 → 账号列表取不到 → 用户下拉永远为空，
 *   现象看起来就是「登录不上」。
 *
 * 因此这里把几种取值都固定下来，避免再退化。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  apiRequest,
  prisma,
  startTestServer,
  type TestHttpClient,
} from "./helpers.js";
import { USERS } from "../questionnaire/helpers.js";

let client: TestHttpClient;

beforeAll(async () => {
  client = await startTestServer();
});

afterAll(async () => {
  await client.close();
  await prisma.$disconnect();
});

interface Me {
  id: string;
  username: string;
  roles: string[];
}

describe("开发态鉴权：x-user-id 的各种取值", () => {
  it("不带 x-user-id → 200，回退到 dispatcher1", async () => {
    const res = await apiRequest<Me>(client, "GET", "/api/v1/me");
    expect(res.status).toBe(200);
    expect(res.body.data?.username).toBe("dispatcher1");
  });

  it("合法 UUID → 200，且解析出对应用户", async () => {
    const res = await apiRequest<Me>(client, "GET", "/api/v1/me", {
      userId: USERS.dispatcher,
    });
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(USERS.dispatcher);
    expect(res.body.data?.username).toBe("dispatcher1");
  });

  it("字符串 \"null\" → 401（回归：前端误发字面量 null 曾导致「登录不上」）", async () => {
    const res = await apiRequest(client, "GET", "/api/v1/me", {
      userId: "null",
    });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("UNAUTHORIZED");
  });

  it("字符串 \"undefined\" → 401", async () => {
    const res = await apiRequest(client, "GET", "/api/v1/me", {
      userId: "undefined",
    });
    expect(res.status).toBe(401);
  });

  it("用户名（开发态）→ 200，便于 curl 手工调试", async () => {
    const res = await apiRequest<Me>(client, "GET", "/api/v1/me", {
      userId: "dispatcher1",
    });
    expect(res.status).toBe(200);
    expect(res.body.data?.username).toBe("dispatcher1");
    expect(res.body.data?.id).toBe(USERS.dispatcher);
  });

  it("未知的用户名/UUID → 401，且不会静默回退成别人", async () => {
    // 注意用 ASCII：HTTP 请求头不允许非 ASCII 字符，
    // 用中文会被 fetch 直接拒绝（与产品逻辑无关）
    const res = await apiRequest(client, "GET", "/api/v1/me", {
      userId: "no-such-user-9f3a",
    });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("UNAUTHORIZED");
    // 关键：确认**没有静默回退成别人**。
    // 401 响应里不应携带任何用户数据（若回退了，data 会是兜底账号）。
    expect(res.body.data).toBeUndefined();
    expect(res.body.success).toBe(false);
  });

  it("停用的用户 → 401", async () => {
    // 造一个停用账号
    const id = "00000000-0000-4000-8000-00000000dead";
    await prisma.user.upsert({
      where: { username: "disabled_user" },
      update: { status: "disabled" },
      create: {
        id,
        username: "disabled_user",
        displayName: "已停用",
        status: "disabled",
        roles: ["dispatcher"],
      },
    });

    try {
      const res = await apiRequest(client, "GET", "/api/v1/me", {
        userId: "disabled_user",
      });
      expect(res.status).toBe(401);
    } finally {
      await prisma.user.deleteMany({ where: { username: "disabled_user" } });
    }
  });
});

describe("开发态账号列表（前端用户选择器依赖）", () => {
  it("GET /api/v1/dev/users 不需要身份也能取到（页面加载时还没选中用户）", async () => {
    const res = await apiRequest<{
      items: { id: string; username: string; roles: string[] }[];
    }>(client, "GET", "/api/v1/dev/users");

    expect(res.status).toBe(200);
    const items = res.body.data?.items ?? [];
    expect(items.length).toBeGreaterThanOrEqual(4);

    // 关键：id 必须是**合法 UUID**，否则前端拿它当 x-user-id 会 401
    for (const u of items) {
      expect(u.id, `${u.username} 的 id 不是 UUID`).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    }

    // 四个种子账号都在
    const names = items.map((u) => u.username);
    for (const expected of [
      "admin",
      "dispatcher1",
      "investigator1",
      "reviewer1",
    ]) {
      expect(names).toContain(expected);
    }

    // 不返回敏感字段
    for (const u of items) {
      expect(u).not.toHaveProperty("passwordHash");
    }
  });

  it("列表里的 id 可以直接用作 x-user-id", async () => {
    const list = await apiRequest<{
      items: { id: string; username: string }[];
    }>(client, "GET", "/api/v1/dev/users");

    const dispatcher = list.body.data?.items.find(
      (u) => u.username === "dispatcher1"
    );
    expect(dispatcher).toBeDefined();

    const me = await apiRequest<Me>(client, "GET", "/api/v1/me", {
      userId: dispatcher!.id,
    });
    expect(me.status).toBe(200);
    expect(me.body.data?.username).toBe("dispatcher1");
  });
});
