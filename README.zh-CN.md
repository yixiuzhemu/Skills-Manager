# Skills-Manager

[English](./README.md)

> 包名：`@dsh-skills-manager/dsh-skills-manager`
> DeepSeek Harness（DSH）的「双面」技能管理插件。

Skills-Manager 将来自多个来源的 Agent Skills 统一到一个管理面板之后。它是
一个基于 [Cordis](https://cordis.js.org/) 的插件，被拆分为两个相互独立、分别
构建与加载的「半边」：

- **Host 半边（Node.js）**——扫描、导入并管理来自多源的技能；拥有技能注册表、
  回收站、仓库浏览、企业技能源、更新与差异比对能力。同时注册 `ctx.skills`
  provider，使每个启用的技能对 harness 生效。
- **Client 半边（浏览器）**——在 DSH 设置区域渲染统一的技能管理面板，含五个
  标签页：技能、回收站、仓库源、企业源、更新。

两半通过 **webServer HTTP**（`/api/skills-manager`）通信：客户端用 `fetch`
调用类型化路由，并在每次变更后重新拉取快照。

> 完整架构、数据模型与设计依据见 [DESIGN.md](./DESIGN.md)。

## 功能特性

- **多源发现**——DSH 全局、当前项目、各 Agent（Codex / Claude / Copilot），
  以及额外的用户目录。
- **导入与创建**——从 zip 压缩包、文件夹或单个 `SKILL.md` 导入；或从零创建
  一个新的受管技能。
- **启用 / 禁用**——实时切换技能对 harness 目录的生效状态。
- **带保留期的回收站**——软删除、恢复、永久清除、清空，以及自动过期清理
  （默认 30 天）。
- **仓库源**——浏览 GitHub 仓库、列出其内部技能并安装。
- **企业源**——注册 `api` / `git` 类型的企业端点，同步并安装其所提供的技能。
- **更新与差异**——检查上游版本，并在应用更新前审阅内联的统一 diff。
- **本地持久化**——数据以 JSON 文档存于 `~/.dsh/skills-manager/`，带修订号
  跟踪与文件监听。

## 架构

```
Host 半边 (Node.js)                          Client 半边 (浏览器)
  src/index.ts                                src/client/index.ts
  SkillsManager 服务     ◄── HTTP fetch ──►   设置面板 (React)
  JsonFileStore (~/.dsh/skills-manager/)      每次变更后重拉快照
  tsc → lib/index.js                          tsdown → client/client.js
```

- **传输**——在 `ctx.webServer` 上注册一个 `prefix` 路由
  `/api/skills-manager`；每个响应都是 `{ ok, data }` / `{ ok, code, error }`
  的 JSON 信封。
- **安全**——请求必须来自 loopback 主机（或携带 `same-origin` / `none` 的
  `sec-fetch-site`）；每个写操作 `POST` 必须携带 `x-dsh-skills-manager` 标记头
  与 `application/json` 内容类型；请求体上限 4 MB。

## 快速开始

### 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`（已在 `packageManager` 中声明）

### 安装与构建

```bash
pnpm install
pnpm build       # clean → tsc（host）→ tsdown（client）→ 规范化 banner
```

`pnpm build` 会在 `lib/` 下产出 Host 产物，并在 `client/client.js` 产出浏览器
产物。

### 校验

```bash
pnpm typecheck   # 对 host + client + test 三个项目做 --noEmit 检查
pnpm test        # 以 node:test 运行 test/**/*.test.ts
```

### 加载到 DSH

本包是一个 DSH bundle 插件，声明了：

- `dsh.bundle.patch` → `./cordis.patch.yml`（将插件以 `id: skills-manager`
  插入到 profile 的 layer 栈中），
- `dsh.client.inject` → `@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-locale`，
- `dsh.client.platform` → `web`。

当本包被安装进一个消费上述字段的 DSH 宿主后：Host 半边在加载时注册
`/api/skills-manager` 路由与 `ctx.skills` provider，Client 半边将面板贡献到
`settings.section` 插槽。打开 harness 的 **设置 → Skills Manager** 即可使用。

### 开发监听

```bash
pnpm watch       # 以 tsdown --watch 监听 Client 半边
pnpm test:watch  # 变更时重新运行测试
```

## 配置

Host 插件读取以下配置（均为可选；零配置默认值即解析为本地方案）：

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `projectRoot` | `string` | `''` | 作为 `project` 源扫描的项目根目录。 |
| `extraDirs` | `string[]` | `[]` | 作为 `local` 源扫描的额外目录。 |
| `agentRoots.codex` | `string` | `''` | Codex 技能目录的覆盖路径。 |
| `agentRoots.claude` | `string` | `''` | Claude 技能目录的覆盖路径。 |
| `agentRoots.copilot` | `string` | `''` | Copilot 技能目录的覆盖路径。 |
| `githubApiBase` | `string` | `https://api.github.com` | GitHub REST API 基址。 |
| `githubRawBase` | `string` | `https://raw.githubusercontent.com` | GitHub raw 内容基址。 |
| `githubToken` | `string` | `''` | 可选的 bearer 令牌，用于鉴权请求。 |
| `trashRetentionDays` | `number` | `30` | 回收站技能在自动清除前的保留天数。 |
| `scanOnStart` | `boolean` | `true` | 启动时是否执行一次发现扫描。 |

## 脚本

| 脚本 | 作用 |
| --- | --- |
| `build` | `clean` → `tsc -p tsconfig.json` → `tsdown` → `normalize-client-banner` |
| `build:client` | 仅打包 Client 半边 |
| `typecheck` | 对 host、client、test 三个 tsconfig 做 `--noEmit` 检查 |
| `test` | `node --test "test/**/*.test.ts"` |
| `test:watch` | `test` 的监听模式 |
| `bundle` / `watch` | `tsdown` 打包 / 监听 |
| `clean` | 运行 `scripts/clean.mjs` |
| `prepack` | `build` + `scripts/preflight.mjs` 守卫 |

## 项目结构

```
src/
  index.ts        Host 插件入口（配置 schema、inject、apply）
  service.ts      SkillsManager 编排核心
  http.ts         Host↔Client HTTP 传输（/api/skills-manager）
  file-store.ts   JSON 持久化（修订号跟踪 + 文件监听）
  scanner.ts      多源发现
  importer.ts     zip / folder / file 导入 + 创建
  diff.ts         LCS 统一 diff
  github.ts       GitHub 仓库源与企业源远程操作
  skill-file.ts   SKILL.md 解析 / 序列化 / id 哈希
  types.ts        共享线协议词汇 + Cordis 事件增强
  client/         浏览器半边（面板、api 客户端、wire 类型、字典、样式）
test/             node:test 用例（http + api）
DESIGN.md         完整设计文档
```

## 技术栈

- **语言**——TypeScript
- **前端**——React 18（`React.createElement`，不依赖 JSX runtime）、
  lightningcss 处理 CSS Modules
- **运行时依赖**——`jszip`、`yaml`
- **构建**——`tsc`（host）+ `tsdown`（client）
- **测试**——Node 内置 `node:test` + 原生 TypeScript 类型剥离

## 许可证

MIT
