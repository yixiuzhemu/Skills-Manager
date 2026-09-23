# Skills-Manager 设计文档（DESIGN.md）

> 包名：`@dsh-skills-manager/dsh-skills-manager`
> 定位：DeepSeek Harness（DSH）的「双面」技能管理插件

## 1. 概述

Skills-Manager 是一个基于 [Cordis](https://cordis.js.org/) 插件体系的 DSH 插件，用于统一管理来自多个来源的 Agent Skills。它被拆分为两个相互独立、分别构建与加载的「半边」：

- **Host 半边（后端 / Node.js）**：扫描、导入、管理来自多源的技能；提供技能注册表、回收站、仓库浏览、企业技能源、更新与差异比对等能力。产物为 `lib/index.js`（CommonJS/ESM 由 `tsc` 产出），类型声明为 `lib/types/`。
- **Client 半边（前端 / 浏览器）**：在 DSH 设置区域渲染统一的技能管理面板。产物为 `client/client.js`（由 `tsdown` 打包的闭包工厂，注入到 `window.__ModuleLoader__`）。

两半通过 **webServer HTTP**（`/api/skills-manager` 前缀路由）通信：Client 端用 `fetch` 调用 Host 端暴露的类型化 HTTP 接口，每次变更后重新拉取快照（详见 §6.1）。Host 端仍会在提交点 `emit` Cordis 事件（`skills-manager/changed` 等，见 §3.6）作为进程内通知，但当前 Client 并不订阅这些事件——跨进程边界由 HTTP 拉取驱动刷新。

## 2. 架构总览

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│   Host 半边 (Node.js)        │         │   Client 半边 (浏览器)         │
│   src/index.ts               │         │   src/client/index.ts (+.tsx) │
│                              │         │                               │
│  ┌────────────────────────┐  │         │  ┌─────────────────────────┐  │
│  │ Skill Registry 服务      │  │  HTTP   │  │ 设置面板 UI (React)      │  │
│  │ listSkills/import/...   │◄─┼─ fetch ─┼─►│ 变更后重拉快照           │  │
│  └───────────┬────────────┘  │         │  └─────────────────────────┘  │
│              │                │         │   React.useState 本地状态   │
│  ┌───────────▼────────────┐  │         └──────────────────────────────┘
│  │ JsonFileStore (存储层)   │  │                       ▲
│  │ ~/.dsh/skills-manager/  │  │                       │ 打包
│  └─────────────────────────┘  │            tsdown → client/client.js
│   tsc → lib/index.js          │            (闭包工厂 + lightningcss)
└─────────────────────────────┘
```

## 3. 数据模型（`src/types.ts`）

该文件定义了 Host 与 Client 之间通信的「线协议（wire vocabulary）」，是两半的共享契约。

### 3.1 技能来源 `SkillSource`

标识技能的发现或安装来源，共 9 类：

| 值 | 含义 |
| --- | --- |
| `local` | 本地机器扫描（非 DSH 目录） |
| `project` | 当前项目 |
| `dsh-global` | DSH 全局目录（`~/.dsh/skills/`） |
| `managed` | 本插件管理（导入/创建） |
| `repo` | 从仓库安装 |
| `company` | 从企业技能源安装 |
| `codex` / `claude` / `copilot` | 对应 Agent 的技能 |

### 3.2 核心记录

- **`SkillRecord`**：注册表追踪的单个技能。`id` 为 `source::relativePath` 的哈希；包含 `name`、`description`、`source`、`enabled`、只读的 `originPath`、可选的 `managedPath`、解析后的 `frontmatter`、来源明细 `sourceDetail` 及时间戳/版本。
- **`SkillFrontmatter`**：从 `SKILL.md` 解析的 YAML frontmatter（`name`、`description`、`whenToUse`、`disableModelInvocation`、`userInvocable`、`metadata`）。
- **`SourceDetail`**：来源附加元数据（仓库 URL/分支、Agent 类型、项目路径、企业源 ID）。
- **`TrashRecord`**：回收站条目，包裹删除时的 `originalSkill`，含 `deletedAt`、`trashPath`、默认 30 天后到期的 `expiresAt`。

### 3.3 仓库与企业源

- **`RepoConfig`** / **`RepoSkillItem`**：配置的 GitHub 仓库及其内部发现的技能项（含 `rawUrl`）。
- **`CompanySkillSource`**：企业技能管理端点，支持 `api` / `git` 两种类型与 `none` / `token` 鉴权。

### 3.4 更新与差异

- **`UpdateInfo`**：单个技能的可用更新信息（当前/最新版本、是否有更新）。
- **`DiffResult` / `DiffHunk` / `DiffLine`**：统一 diff 结构，支持 `add` / `remove` / `context` 行类型与行号。

### 3.5 操作参数

- **`ImportParams`**：从文件/目录导入（`zip` / `folder` / `file`）。
- **`CreateParams`**：创建新技能（`name`、`description`、`content`）。

### 3.6 Cordis 事件

在 `declare module '@deepseek-ai/cordis'` 中扩展 `Events` 接口，声明三个 payload-free 通知事件：

| 事件 | 触发时机 | 消费者动作 |
| --- | --- | --- |
| `skills-manager/changed` | 技能被导入/删除/启用/禁用/从回收站恢复 | 重读 `listSkills()` |
| `skills-manager/trash-changed` | 技能被移入回收站/恢复/永久删除 | 重读 `listTrash()` |
| `skills-manager/repos-changed` | 仓库被增删或其技能列表刷新 | 重读仓库状态 |

> 事件在每个提交点触发；观察者失败被隔离，不能否决注册表的变更。

## 4. 存储层（`src/file-store.ts`）

基于 JSON 文件的持久化基础设施，所有数据落在 `~/.dsh/skills-manager/`（由 `getBaseDir()` 暴露）。

### 4.1 `JsonFileStore<T>`

一个文档一个实例，挂载时 `start()`、销毁时 `stop()`：

- **修订号（revision）**：单调递增，每次「观察到」或「应用」变更时 `+1`，用于陈旧写入检测。
- **文件监听**：`start()` 通过 `watchFile`（间隔 1000ms）监听文档，外部修改无需重启即可被 `reload()` 拾取。
- **容错读取**：文档缺失或无法解析时读取为 `defaultData()` 默认值。
- **写入**：`save()` 整体替换文档内容（2 空格缩进 + 末尾换行），随后更新 `current`、`rev` 并回调 `onChange`。

### 4.2 目录/文件工具

`ensureDir`、`listDir`、`pathExists`、`getStats`、`readTextFile`、`writeTextFile` —— 均在基础目录下操作，写入时按需创建父目录。

## 5. 构建与打包

### 5.1 Host 半边（`tsc` + `tsconfig.json`）

- `rootDir: src` → `outDir: lib`，声明输出到 `lib/types`。
- 严格模式全开：`strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`、`rewriteRelativeImportExtensions` 等。
- **排除** `src/client`（由 Client 项目单独处理）。

### 5.2 Client 半边（`tsdown` + `tsdown.config.ts`）

镜像 DSH 外部包的 client 预设，产物为闭包工厂：

- **入口**：`src/client/index.ts` → **产物**：`client/client.js`（`outDir: client`，`format: cjs`，`platform: browser`，`target: es2022`）。
- **模块加载**：banner/footer 包裹为
  `window.__ModuleLoader__.load({ id: "@dsh-skills-manager/dsh-skills-manager", factory: (require) => { ... return module.exports; } })`。
- **外部依赖**：仅 `react` 走 loader 模块表（组件用 `React.createElement` 编写，不依赖 `react/jsx-runtime`，尽管后者也在 external 列表中以备将来改用 JSX）；其余（CSS Modules 等）全部内联（`noExternal`），因为 loader 表无法解析的 `require()` 会导致运行时抛错。
- **CSS Modules**：自定义插件 `dsh-css-modules-inline` 通过虚拟 id（前缀 `\0dsh-css:`、后缀 `.mjs`，避开 tsdown 自身 `.css` 管线）用 `lightningcss` 编译；`import 'x.module.css'` 返回哈希类名映射，并在工厂执行时自动注入 `<style data-plugin>` 标签（卸载时由 loader 移除）。哈希基于仓库相对路径（posix 分隔符），保证跨平台（含 Windows）一致。
- **不产 dts/sourcemap**：Host 类型由 `tsc` 提供；此处产 dts 会把 banner/footer 包进 `.d.cts` 破坏解析。

### 5.3 类型检查（`tsconfig.client.json`）

仅类型检查（`noEmit`）浏览器端源码 `src/client`，启用 `jsx: react-jsx`。`pnpm run typecheck` 同时运行 Host 与 Client 两个项目。

### 5.4 脚本（`package.json` scripts）

| 脚本 | 作用 |
| --- | --- |
| `build` | `clean` → `tsc -p tsconfig.json` → `tsdown` → `normalize-client-banner` |
| `build:client` | 仅打包 Client 半边 |
| `typecheck` | 对 Host、Client、Test 三个 tsconfig 做 `--noEmit` 检查 |
| `test` | `node --test "test/**/*.test.ts"`（Node 内置运行器 + 原生类型剥离） |
| `test:watch` | `test` 的 `--watch` 模式 |
| `bundle` / `watch` | `tsdown` 打包 / 监听模式 |
| `clean` | 运行 `scripts/clean.mjs` |
| `prepack` | `build` + `scripts/preflight.mjs` |

### 5.5 打包前守卫（`scripts/preflight.mjs`）

校验所有必须携带 npm 包名的纯字符串位置确实一致（编译器无法检查）：

1. `cordis.patch.yml` 必须以 `name: '<包名>'` 插入。
2. `client/client.js` 必须以 `window.__ModuleLoader__.load({ id: "<包名>"` 开头。

任一漂移则打包失败，避免重命名后静默发布损坏产物。

### 5.6 加载补丁（`cordis.patch.yml`）

DSH bundle 补丁，将本插件以 `id: skills-manager`、`name: '@dsh-skills-manager/dsh-skills-manager'` 插入到 profile 的 layer 栈中。

### 5.7 单元测试（`test/` + `tsconfig.test.json`）

采用 **Node 内置测试运行器**（`node:test` + `node:assert`）配合 Node ≥23 的**原生 TypeScript 类型剥离**，零额外依赖、零打包即可运行 `.ts` 测试。`tsconfig.test.json`（`include: ["test"]`）以与主项目同等的严格度对测试做 `--noEmit` 类型门禁，并纳入 `npm run typecheck`。

- `test/http.test.ts`：通过 `registerHttpApi` 挂载真实路由 handler，以 `Readable` 伪造 `IncomingMessage`、记录型对象伪造 `ServerResponse`，并用 `Proxy` 版 `SkillsManager` mock 记录调用 / 注入返回值与异常；黑盒覆盖来源安全（same-origin / loopback / cross-site 拒绝）、方法分派（GET/HEAD/POST/405）、读写路由、marker/content-type/JSON/4MB 上限守卫、`{ ok, data }` 信封与 403/405/400/413/404 状态码。
- `test/api.test.ts`：以桩替换全局 `fetch`，覆盖信封拆包（`data ?? null`）、`ok:false` / HTTP 错误 / 非 JSON → `ApiError`（含 code）、GET 查询编码、POST marker/内容类型/请求体契约。

> 两个被测模块（`src/http.ts`、`src/client/api.ts`）均为纯 `import type` 模块、无运行时依赖边，故测试完全隔离，无需加载 Cordis / 服务实现。当前 **39 个用例全绿**（9 个 suite）。

## 6. 包导出与运行时约定

`package.json` 的 `exports` 映射：

| 子路径 | 目标 |
| --- | --- |
| `.` | `lib/index.js`（类型 `lib/types/index.d.ts`） |
| `./types` | `lib/types.js`（类型 `lib/types/types.d.ts`） |
| `./client` | `client/client.js` |
| `./src/*` | `src/*`（源码直通） |

`dsh` 字段声明：
- `bundle.patch` → `./cordis.patch.yml`
- `client.inject` → `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-locale`
- `client.platform` → `web`

发布文件（`files`）：`lib`、`client`、`src`、`cordis.patch.yml`。

### 6.1 Host↔Client 传输架构决策

本插件采用 **webServer HTTP** 作为 Host↔Client 的唯一活传输通道，而非 typert 代码生成链。决策依据如下：

- **typert / api-remotes 对独立第三方插件不可行**：`@deepseek-ai/dsh-api-remotes` 的客户端面（a）依赖未安装的 `@deepseek-ai/dsh-api-gateway`；（b）只挂载由 harness monorepo **构建期 codegen** 生成的固定 `/remote` 命名空间集合，第三方插件无法注入自己的命名空间。因此 `@Remote` / `TypertRemoteService` 标记对独立插件永远无法抵达浏览器。
- **webServer 是公开、稳定的宿主注入面**：`ctx.webServer.register({ kind: 'prefix', path, handler })` 返回 disposer，`handler` 签名为 `(req: IncomingMessage, res: ServerResponse) => void | Promise<void>`。Host 在其上暴露 `/api/skills-manager`，Client 用 `fetch` 调用，两侧各自独立构建，无需 codegen 或网关。
- **`@Remote` 标记保留为惰性**：`TypertRemoteService` 构造时只创建被动冻结的 binding 描述符（`bindTypertRemote`），`@Remote` 仅记录原型描述符，无网关时运行时无副作用。故保留这些标记（避免 25 处高风险删除重构），以兼容将来若接入 typert 网关。
- **安全模型**：来源必须为 loopback 主机（或 `sec-fetch-site: same-origin|none`）；每个写操作 `POST` 必须携带 `x-dsh-skills-manager: 1` 标记头与 `application/json` 内容类型；请求体上限 4MB；统一以 `{ ok: true, data }` / `{ ok: false, code, error }` JSON 信封响应，协议错误用 403/405/400/413 状态码。
- **客户端类型隔离**：`src/types.ts` 含 `declare module '@deepseek-ai/cordis'` 事件增强，浏览器程序无法解析；故 `src/client/wire.ts` 复制一份纯数据形状（不含 Cordis 增强）供客户端导入，Host 仍为唯一事实源，两侧手工同步。
- **参考实现**：同类插件 `@michengai/dsh-skills-manager` 已验证 webServer HTTP 方案；本方案只新增一个 `dsh-host-webserver` peer 依赖（npm 可得），且 `SkillsManager` 的业务方法保持不变，HTTP 处理器仅做转发。

## 7. 技术栈

- **语言**：TypeScript ^6.0.3
- **前端**：React ^18.2.0、Zustand ~4.4.7（状态管理）、Immer ^10.1.1（不可变数据）、lightningcss ^1.33.0（CSS 处理）
- **运行时依赖**：jszip ^3.10.1（压缩包）、yaml ^2.5.0（frontmatter 解析）
- **DSH 内部依赖（peer）**：`@deepseek-ai/cordis`、`schemastery`、`dsh-skill`、`dsh-settings`、`dsh-host-webserver`（HTTP 传输）、`dsh-typert-protocol`（惰性标记）、`dsh-client-store`、`dsh-client-locale`、`dsh-client-ui-settings`、`dsh-client-ui-slots`
- **构建**：tsdown ^0.22.14
- **环境**：Node.js `^22.19.0 || >=24.0.0`，包管理器 pnpm@11.7.0

## 8. 当前实现状态

> ✅ **Host 与 Client 两个半边均已完整实现，构建链全绿**。Host↔Client 通信采用 **webServer HTTP** 模式（见 §6.1），不依赖 typert 代码生成链。

**基础设施：**
- `src/types.ts`：完整的类型与事件定义（线协议契约）。
- `src/file-store.ts`：JSON 存储基础设施（修订跟踪 + 文件监听）。
- 完整的构建配置与脚本（`tsconfig*.json`、`tsdown.config.ts`、`scripts/*`、`cordis.patch.yml`）。

**Host 纯逻辑模块（无 Cordis 依赖，可独立测试）：**
- `src/skill-file.ts`：`SKILL.md` frontmatter 解析/序列化、`skillId` 哈希、kebab-case 归一、版本读取、目录读取。
- `src/scanner.ts`：多源发现（dsh-global / project / codex / claude / copilot / 额外目录），`originPath` 指向 `SKILL.md`。
- `src/importer.ts`：`zip` / `folder` / `file` 三形态导入 + 从零创建，物化到 `managed/<id>/`。
- `src/diff.ts`：LCS 统一 diff（分块 + 上下文窗口 + 大输入降级保护）。
- `src/github.ts`：GitHub 仓库源（trees API 定位 + raw 下载）与企业源（`api` / `git`）远程操作。

**Host 编排层：**
- `src/service.ts`：`SkillsManager`（继承 `TypertRemoteService`，服务键 `skillsManager`）。以四个 `JsonFileStore` 持久化 `registry.json` / `trash.json` / `repos.json` / `company.json`；实现扫描/导入/创建/启停/软删除/回收站（恢复·清除·清空·30 天过期清理）/仓库源/企业源/更新检查/diff/应用更新；在各提交点 `emit` 三个事件；注册 `ctx.skills` provider 使启用的技能对 harness 生效。公共方法以 `@Remote` 装饰——这些标记在当前架构下**惰性**（仅记录原型描述符，运行时无副作用），保留以兼容将来若接入 typert 网关。
- `src/http.ts`：**Host↔Client 的活传输层**。在 `ctx.webServer` 上注册一个 `prefix` 路由 `/api/skills-manager`，将 GET/POST 请求分派到 `SkillsManager` 方法；统一以 `{ ok: true, data }` / `{ ok: false, code, error }` JSON 信封响应。安全校验：来源必须为 loopback 主机（或 `sec-fetch-site: same-origin|none`），且每个写操作 `POST` 必须携带 `x-dsh-skills-manager` 标记头与 `application/json` 内容类型；请求体上限 4MB。
- `src/index.ts`：插件入口（`Config` schema + `inject: ['skills', 'webServer']` + `apply`），实例化服务、同步注册 provider、以 `ctx.effect` 注册 HTTP 路由并驱动 store 启停，并增强 `Context` 暴露 `ctx.skillsManager`。

**Client 半边：**
- `src/client/index.ts`：浏览器入口，导出 `name` / `inject: ['slots', 'locale']` / `apply(ctx)`；注册 i18n 字典并将面板组件贡献到 `settings.section` 插槽（`id: skills-manager`）。
- `src/client/api.ts`：基于 `fetch` 的类型化 HTTP 客户端，拆包 `{ ok, data }` 信封，失败抛出 `ApiError`。
- `src/client/wire.ts`：宿主线协议的**客户端本地副本**（纯数据形状），避免将 `src/types.ts` 中的 Cordis 事件增强拉入浏览器程序。
- `src/client/section.ts`：主面板组件（`React.createElement` 编写），含五个标签页——技能（搜索/启停/详情/删除）、回收站（恢复/永久删除/清空）、仓库源（增删/同步/安装）、企业源（增删/同步/安装）、更新（`checkUpdates` + 内联 diff 对比 + `applyUpdate`）。
- `src/client/locales.ts`：`skills-manager` 命名空间的 zh/en 字典。
- `src/client/styles.module.css`：CSS Modules 样式（绑定 `--dsw-alias-*` 设计令牌，带字面回退）。
- `src/client/css.d.ts`：`*.module.css` 的环境声明。

**验证结果：** `tsc -p tsconfig.json --noEmit`、`tsc -p tsconfig.client.json --noEmit`、`tsc -p tsconfig.test.json --noEmit` 均无错；`npm run build` 产出 `lib/`（含 `http.js`）与 `client/client.js`（~60KB，`react` 外部化、CSS 内联、banner 正确）；`normalize-client-banner` 与 `preflight` 均通过；`npm run test` **39/39 用例全绿**（`node:test`，见 §5.7）。

## 9. 后续可选优化

Host 与 Client 两个半边均已交付并通过全链路验证。以下为可选的增强方向，非当前里程碑的阻塞项：

1. **导入体验**：当前 `importSkill` 走宿主机文件系统路径（客户端以文本框输入绝对路径）。若要对齐参考项目的拖拽上传，需在 Host 增加一个接收文件字节（zip/多文件）的路由，并在客户端用 `webkitdirectory` 文件选择器上传。
2. **事件驱动刷新**：目前面板在每次变更后主动 `reload()` 快照；可进一步订阅 Host 转发的 `skills-manager/changed` 等事件实现多窗口实时同步（需经 webServer 的 SSE 或宿主事件转发机制）。
3. **状态管理**：面板当前用 React 内置 hooks 管理状态；若交互进一步复杂化，可引入已列于依赖的 Zustand + Immer。
4. **错误本地化**：Host 返回的 `error` 为原始消息字符串；可扩展为带 `code` + `params` 的结构化错误，由客户端 `t(code, params)` 本地化（参考项目已采用此模式）。
5. **测试覆盖扩展**：`src/http.ts`（路由分派 / 安全校验 / 信封）与 `src/client/api.ts`（信封拆包 / 错误码）的单元测试**已落地**（见 §5.7，39 用例全绿）；后续可为 Host 纯逻辑模块（`diff.ts` / `skill-file.ts` / `importer.ts` / `scanner.ts`）与 `section.ts` 组件补充测试。
