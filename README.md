# Moka Transcript Getter

基于 OpenCLI 和 Chrome CDP，从 HR 已登录的 Moka 会话中导出：

- 候选人姓名
- 应聘岗位
- 每场面试及面试官
- 面试逐字稿、AI 总结和逐题分析

插件不会读取或保存 Moka 密码、Cookie、JWT 或 CSRF Token。所有接口请求都在 HR 自己登录的 Chrome 页面上下文中发起。

## 开发环境

- Windows 10/11
- Node.js 20+
- Google Chrome
- `@jackwener/opencli` 1.8.6+

```powershell
npm install -g @jackwener/opencli@1.8.6
npm install
npm run check
opencli plugin install "D:\Users\jingboma\proj\bossHr\Moka-transcript-getter"
```

## HR 使用流程

第一步只需要打开登录窗口：

```powershell
opencli moka login -f json
```

系统会使用独立 Chrome Profile 打开：

```text
https://app.mokahr.com/interviews/overview
```

HR 在窗口中自行完成账号、密码和验证码登录。登录完成后检查：

```powershell
opencli moka status -f json
```

当结果中出现 `"mokaLogin": "authenticated"` 后导出：

```powershell
opencli moka export-transcripts --output ".\moka-transcripts.json" -f json
```

也可以只导出某位候选人：

```powershell
opencli moka export-transcripts --candidate "候选人姓名" --output ".\候选人面试记录.json" -f json
```

## 命令

| 命令 | 用途 |
| --- | --- |
| `opencli moka login` | 启动专用 Chrome 并打开 Moka |
| `opencli moka status` | 检查浏览器与 Moka 登录状态 |
| `opencli moka applications` | 获取今天有面试的应聘记录、候选人和岗位 |
| `opencli moka interviews <applicationId>` | 获取全部面试及面试官 |
| `opencli moka transcript <applicationId> <interviewId>` | 获取单场逐字稿 |
| `opencli moka export-transcripts` | 导出今天涉及候选人的全部面试记录 |

`interviewList` 的请求体模板会从 Moka 总览页的真实网络请求中自动捕获，以复用页面所需的未公开字段。首次捕获时，插件会监听当前正常加载的总览页，并只读点击一次列表底部的“加载更多”；捕获到请求体后缓存在当前标签页的专用 `sessionStorage` 键中。实际采集时会把时间范围明确覆盖为北京时间今天，并保留岗位等其他模板字段。后续命令直接复用缓存，不刷新页面，也不会读取或保存 Moka 的 Cookie、Token。

默认只发现“今天”的面试，不请求历史或未来：范围按北京时间动态计算，按开始时间升序，并自动遍历今天的全部分页。结果按 `applicationId` 去重；随后每个唯一应聘记录只调用一次 `interviewCard`，由该接口返回这条应聘记录至今的全部面试。只有显式传入高级调试参数 `--request-json` 时，才会按照用户提供的单一查询执行。

重复执行 `opencli moka login` 时会优先复用并聚焦已经打开的 Moka 总览页或登录页，不会为每次状态检查重复创建 Moka 标签页。只有当前 CDP Chrome 中完全没有 Moka 页面时才新建标签页。

## 当前 OpenCLI 兼容方式

OpenCLI 1.8.6 的普通网站 adapter 仍优先使用 Browser Bridge，尚不会因 `OPENCLI_CDP_ENDPOINT` 自动切换到直连 CDP。本插件因此注册为 OpenCLI 本地命令，并复用 OpenCLI 对外公开的 `CDPBridge` 连接专用 Chrome。OpenCLI 后续原生支持普通网站直连 CDP 后，可以移除这层兼容封装，不影响 Moka 数据解析和 Skill。

接口与字段说明见 [reference/moka-interview-apis.md](reference/moka-interview-apis.md)。

完整的开发、联调、回归和故障排查步骤见 [TESTING.md](TESTING.md)。
