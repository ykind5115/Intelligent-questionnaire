// ESLint 扁平配置（ESLint 9/10 风格）。
//
// 为什么是扁平配置而不是 .eslintrc：
//   ESLint 10 已移除 eslintrc 支持，本项目直接从零开始，没有历史包袱。
//
// 设计取向（重要）：
//   1. **只挑「真问题」的规则**，不追求规则数量。
//      格式一律交给 Prettier，避免两套工具互相打架（见下方注释）。
//   2. **不启用 stylistic 类规则**，尤其不加 `eslint-config-prettier` ——
//      只要不打开格式规则，就不存在与 Prettier 冲突的问题，也少一个依赖。
//   3. 与 tsconfig 的严格档位对齐；但**类型感知的规则只用在 tsconfig 覆盖的文件上**。
//      这一点踩过坑：把 `recommendedTypeChecked` 直接铺给所有文件时，
//      连 `eslint.config.js`（不在任何 tsconfig 项目里）也会被要求提供类型信息，
//      ESLint 直接报「don't have parserOptions set to generate type information」而退出。
//      正确做法是分层：`recommended` 铺全部，`recommendedTypeChecked` 只给有 tsconfig 的文件。
import tseslint from "typescript-eslint";

/** 有 tsconfig 覆盖、可以做类型感知 lint 的目录 */
const TYPED_FILES = ["src/**/*.ts", "tests/**/*.ts", "prisma/**/*.ts"];

export default tseslint.config(
  // ---------- 忽略 ----------
  // 生成产物、前端静态资源（原生 JS，另有 node --check 把关）、
  // 临时脚本与审计目录都不参与 lint。
  {
    ignores: [
      "generated/**",
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "public/**",
      "tmp-*/**",
      "tmp-*",
    ],
  },

  // ---------- 第一层：无需类型信息的推荐规则（铺全部文件，含本配置文件） ----------
  ...tseslint.configs.recommended,

  // ---------- 第二层：类型感知规则（只给有 tsconfig 的文件） ----------
  ...tseslint.configs.recommendedTypeChecked.map((cfg) => ({
    ...cfg,
    files: TYPED_FILES,
  })),

  {
    files: TYPED_FILES,
    languageOptions: {
      parserOptions: {
        // 类型感知所需的 project 配置。
        // 用 projectService 而不是手动 project 列表：前者会自动按 tsconfig
        // 的 include 匹配文件，新增文件不需要再改这里。
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ---- 类型安全 ----
      // 类型断言到 any 会掩盖问题；unknown 才是本项目的惯用做法。
      "@typescript-eslint/no-explicit-any": "warn",
      // 未 await 的 Promise 是最难查的一类 bug（错误被吞掉）。
      "@typescript-eslint/no-floating-promises": "error",
      // async 函数里返回一个 Promise 却忘了 await：语义与直觉不同。
      "@typescript-eslint/no-misused-promises": "error",
      // 只在必要时才断言类型。
      //
      // **刻意关闭**，原因有二，都与本仓库的实际写法有关：
      //   1. 有一类断言是**类型正确性所必需**的：Prisma 的 JSONB 字段类型是
      //      `InputJsonValue`，而我们的结构类型（如 `QuestionnaireSchema`）不满足它，
      //      必须写 `schema as object` 才能通过类型检查。这条规则认为该断言
      //      「不改变类型」并删掉它 —— 实测 `--fix` 正是这么做的，
      //      直接把 typecheck 打回 2 个错误。
      //   2. `expectData<T>()` 的签名有意放宽成 `ApiResult<unknown>`，
      //      让调用方在断言处**显式写出期望的响应形状**。规则会把这种显式断言
      //      判为多余，但它是这套 API 的用法本身。
      //
      // 换言之：这条规则的自动修复会破坏代码，留着只会制造噪音（29 处）。
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // 空接口等价于 {}，会接受任何非 null 值。
      "@typescript-eslint/no-empty-object-type": "error",
      // 用 `error` 而不是 `off`：本项目历史上出现过「catch 里什么都不做，
      // 于是真正的失败被静默吞掉」的问题（见 AGENT.md 第 9 节经验①）。
      "no-empty": ["error", { allowEmptyCatch: false }],

      // ---- 未使用变量 ----
      // 下划线前缀是「我故意不用」的约定，与项目既有写法一致。
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // ---- 一致性 ----
      // 全等比较。宽松比较在判断「id 是否存在」这类场景会踩坑。
      eqeqeq: ["error", "always", { null: "ignore" }],
      // 中文注释 + 英文标识符是本项目的约定，见 AGENT.md 第 3 节。
      "@typescript-eslint/naming-convention": [
        "error",
        // 变量：默认 camelCase / PascalCase / UPPER_CASE，允许解构时用下划线占位
        {
          selector: "variable",
          format: ["camelCase", "PascalCase", "UPPER_CASE"],
          leadingUnderscore: "allow",
        },
        { selector: "typeLike", format: ["PascalCase"] },
        // 兼容既有代码中 `roles.includes("template_admin")` 这类字符串字面量，
        // 因此不检查 enumMember / 属性名（Prisma 生成的类型不受我们控制）。
      ],
    },
  },

  // ---------- 测试文件放宽 ----------
  {
    files: ["tests/**/*.ts"],
    rules: {
      // 测试里为了断言会大量构造对象，显式 any 太啰嗦。
      "@typescript-eslint/no-explicit-any": "off",
      // 断言「抛错」时会写 `expect(() => f()).toThrow()`，
      // 也会刻意构造非法输入，这几条在测试里价值不大。
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      // 测试替身经常要「实现一个异步接口但没有真正 await」
      // （例如假 Provider 的 async chat、内存实现的 async summarize）。
      // 强行给它们加 `await Promise.resolve()` 只是为了让 lint 闭嘴，
      // 属于被规则扭曲代码，因此这里关掉。
      "@typescript-eslint/require-await": "off",
    },
  }
);
