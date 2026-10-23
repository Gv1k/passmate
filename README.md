# PassMate

**从历年真题出发，把备考拆成清晰、可执行的复习任务。**

PassMate 是一个 AI 辅助备考 Web 应用，将真题考点分析、复习优先级、任务清单和学习助手放在同一个工作台中，帮助你安排「先学什么、怎么练、还剩多少」。

**[访问在线网站](https://gv1k.github.io/passmate/)** · [查看部署状态](https://github.com/Gv1k/passmate/actions/workflows/deploy-pages.yml)

## 主要功能

| 功能 | 说明 |
| --- | --- |
| 科目与考试日程 | 设置科目、考试日期和目标分数，查看考试倒计时与复习进度。 |
| 真题分析 | 上传最多三套真题的图片，通过 Dify 工作流逐套提取考点，再综合分析与排序。 |
| 考点优先级看板 | 按大题、小题展示考点，查看频次、分值、优先级与难度，支持编辑和标记已学完。 |
| 复习清单与笔记 | 管理科目任务、快捷待办和学习笔记，根据任务完成情况计算进度。 |
| Prompt Center | 生成单元学习、闪卡练习提示词，并提供练习复盘模板，支持一键复制。 |
| AI Solver | 通过文字向 AI 学习助手提问，获取解题与复习帮助。 |
| 复习流程跟踪 | 跟踪上传真题、学习考点、自主练习和复盘等步骤的完成情况。 |
| 云端状态保存 | 通过 Supabase 读取和保存科目、清单、笔记、考点与目标分数等数据。 |

## 使用流程

1. 在 **My Schedule** 中设置备考科目和考试日期。
2. 选择科目，上传一至三套真题图片并开始分析。
3. 在 **Priority Board** 中查看考点，安排复习顺序。
4. 使用 **Prompt Center** 获取学习或复盘提示词，遇到问题时向 **AI Solver** 提问。
5. 完成清单任务、记录笔记，跟踪距离考试的时间和学习进度。

## 技术栈

- **前端**：React 19、TypeScript、Vite 8。
- **样式**：Tailwind CSS 4 与 CSS，采用深色界面和轨道式科目导航。
- **数据服务**：Supabase Edge Functions、Hono 与 PostgreSQL 键值存储。
- **AI 服务**：Dify 工作流与聊天应用，经 Supabase 代理调用。
- **部署**：GitHub Actions 自动构建，GitHub Pages 托管静态前端。

项目由 Figma Make 起步，保留了相关预览插件和站点配置。

## 本地运行

准备 **Node.js 22.12 或更高的 22.x 版本**，以及随 Node.js 安装的 npm。

```bash
git clone https://github.com/Gv1k/passmate.git
cd passmate
npm ci
npm run dev
```

开发服务器默认运行在 [http://localhost:8443](http://localhost:8443)。该端口需要空闲；端口及其他开发设置位于 [`vite.config.ts`](./vite.config.ts)。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动开发服务器。 |
| `npm run build` | 构建生产版本，输出到 `dist/`。 |
| `npm run preview` | 本地预览构建结果，默认端口为 `8443`。 |
| `npm run format` | 使用 oxfmt 格式化代码。 |

启动前端后，云端功能会连接 [`utils/supabase/info.tsx`](./utils/supabase/info.tsx) 中配置的 Supabase 项目；本地启动不会自动创建数据库、部署后端或配置 Dify。

## 部署到 GitHub Pages

当前网站地址：**https://gv1k.github.io/passmate/**。

向 `main` 分支推送代码后，[部署工作流](./.github/workflows/deploy-pages.yml) 会自动完成以下步骤：

1. 使用 Node.js 22 和 `npm ci` 安装依赖。
2. 设置 `GITHUB_PAGES=true` 并构建前端。
3. 上传 `dist/` 构建产物并发布到 GitHub Pages。

也可以在仓库的 **Actions → Deploy PassMate to GitHub Pages → Run workflow** 中手动触发部署。仓库 **Settings → Pages → Source** 应选择 **GitHub Actions**。

`GITHUB_PAGES=true` 会使 Vite 使用 `/passmate/` 作为资源路径前缀。若部署到其他名称的仓库或自定义域名，需要相应调整 [`vite.config.ts`](./vite.config.ts) 的 `base`。

线上内容由源码构建产生，无需手动更新仓库中保留的 `docs/` 或 `dist/` 文件。

## 后端与 AI 配置

GitHub Pages 只托管前端。数据保存和 AI 功能依赖单独部署的 Supabase Edge Functions，以及已经配置好的 Dify 应用。

### 数据服务

- 前端接口封装：[`src/lib/passmateApi.ts`](./src/lib/passmateApi.ts)。
- 数据函数源码：[`supabase/functions/server/index.tsx`](./supabase/functions/server/index.tsx)。
- 当前前端使用的函数名称：`make-server-f263515b`，数据接口路径为 `/passmate`。
- 数据库存储表：`kv_store_f263515b`，表结构定义见 [`kv_store.tsx`](./supabase/functions/server/kv_store.tsx) 顶部注释。
- 服务端使用 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 访问数据库。

源码目录名 `server` 与线上函数名 `make-server-f263515b` 不同。迁移后端时，需要对齐部署名称、函数内的路由前缀和前端接口地址。

### Dify 代理

[`supabase/functions/dify-proxy/index.ts`](./supabase/functions/dify-proxy/index.ts) 负责转发图片上传、工作流执行和聊天请求。对应的 Dify API Key 通过 Supabase 服务端 Secrets 配置：

| Secret | 用途 |
| --- | --- |
| `DIFY_STAGE1_KEY` | 单套真题的图片识别与考点拆解。 |
| `DIFY_STAGE2_KEY` | 多套真题的综合分析与考点排序。 |
| `DIFY_PROMPT_KEY` | 单元学习和闪卡提示词生成。 |
| `DIFY_ASSISTANT_KEY` | AI Solver 聊天助手。 |

Dify API Key 和 Supabase Service Role Key 仅用于服务端。前端使用的是 Supabase 项目 ID 与公开 anon key。

仓库包含代理代码，但未包含可直接导入的 Dify 工作流定义。迁移到自己的服务时，还需要在 Dify 配置对应应用，并使输入、输出字段与 [`src/App.tsx`](./src/App.tsx) 中的调用逻辑一致。

### 当前数据模式

当前版本没有独立用户登录和按用户隔离的数据空间，所有访问者使用同一条 `passmate:v1` 状态记录。清单、笔记等操作会修改这份共享数据。若要用于多用户场景，需要补充身份认证和按用户存储的机制。

## 项目结构

```text
passmate/
├── .github/workflows/deploy-pages.yml  # GitHub Pages 自动部署
├── .figma/make/site.json              # 站点标题与元信息
├── index.html                        # 网页入口
├── src/
│   ├── App.tsx                       # 页面、交互与 AI 调用逻辑
│   ├── main.tsx                      # React 挂载入口
│   ├── index.css                     # 全局样式与主题
│   ├── imports/                      # 图片素材
│   └── lib/passmateApi.ts             # 状态读取、保存与代理地址
├── supabase/functions/
│   ├── server/                       # 状态接口与数据库访问
│   └── dify-proxy/                   # Dify API 代理
├── utils/supabase/info.tsx            # Supabase 公开连接配置
├── package.json                      # 依赖与脚本
└── vite.config.ts                    # 构建、开发与资源路径配置
```
