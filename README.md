# Moka Transcript Getter

项目地址：[NeverlandzZ1/Moka-cli](https://github.com/NeverlandzZ1/Moka-cli)

面向 HR 的 Moka 面试记录导出工具。登录 Moka 后，一条命令即可导出今天涉及候选人的：

- 候选人姓名和应聘岗位
- 全部面试轮次及面试官
- 面试逐字稿
- Moka AI 总结和逐题分析

工具只读取当前账号有权查看的数据，不要求复制 Cookie、Token、密码或验证码。

## 使用前准备

电脑需要安装：

- [Google Chrome](https://www.google.com/chrome/)
- [Node.js 22 LTS](https://nodejs.org/)
- [Git](https://git-scm.com/downloads)

不需要安装 Python，也不需要安装 Chrome 扩展。

打开终端并确认：

```text
node --version
git --version
```

## 第一次安装

### 1. 安装 OpenCLI

Windows PowerShell 或 macOS Terminal 均可执行：

```text
npm install -g @jackwener/opencli@latest
```

确认安装成功：

```text
opencli --version
```

### 2. 安装 Moka 插件

```text
opencli plugin install github:NeverlandzZ1/Moka-cli
```

确认插件已安装：

```text
opencli plugin list
opencli moka export-transcripts --help
```

### 3. 登录 Moka

```text
opencli moka login -f json
```

命令会打开一个专用 Chrome 窗口。请在该窗口中自行登录 Moka，不要关闭窗口。

登录完成后可以检查状态：

```text
opencli moka status -f json
```

看到下面的状态即可开始导出：

```json
{
  "mokaLogin": "authenticated"
}
```

### 切换校招或社招

导出前可以切换 Moka 当前的招聘模式：

```powershell
opencli moka mode campus -f json   # 校招
opencli moka mode social -f json   # 社招
```

也可以直接使用 `校招` 或 `社招`。切换成功后，命令会间隔短暂时间刷新当前 Moka 页面两次，使界面和后续导出同时进入对应模式；导出命令会读取该模式下的今日面试。

## 日常使用

登录完成后，日常只需要运行一次导出命令。

Windows PowerShell：

```powershell
opencli moka export-transcripts `
  --output "$HOME\Desktop\moka-transcripts.json" `
  -f json
```

macOS：

```bash
opencli moka export-transcripts \
  --output "$HOME/Desktop/moka-transcripts.json" \
  -f json
```

工具会：

1. 找到北京时间今天的全部面试候选人。
2. 获取这些候选人在当前应聘记录下的全部面试。
3. 获取每场面试的面试官和逐字稿。
4. 将结果写入指定 JSON 文件。

今天没有面试时，`records` 可以为空。

## 重复导出

可以始终保存到同一个 JSON 文件。工具不会简单覆盖旧记录，而是按照下面的联合标识增量更新：

```text
applicationId + interviewId
```

- 两个 ID 都相同：更新已有面试记录。
- 任意一个 ID 不同：追加一条新面试记录。
- `stats` 根据合并后的文件重新计算。
- 已有文件格式不正确时停止写入，避免破坏原文件。

## 只保存本次结果

如果不需要历史记录，增加 `--overwrite`：

```powershell
opencli moka export-transcripts `
  --output "$HOME\Desktop\moka-transcripts.json" `
  --overwrite `
  -f json
```

开启后不会读取或合并旧文件。每次执行都只保存本次获取的记录；目标路径存在同名 JSON 时直接覆盖。未增加 `--overwrite` 时，仍保持默认的增量去重更新。

## 更新插件

```text
opencli plugin update moka-transcripts
```

更新 OpenCLI：

```text
npm install -g @jackwener/opencli@latest
```

## 常见问题

### 提示无法连接 Moka 专用 Chrome

重新打开登录窗口：

```text
opencli moka login -f json
```

### Moka 页面要求重新登录

请在命令打开的专用 Chrome 中重新登录，然后再次执行导出命令。不要从浏览器开发者工具复制 Cookie 或 Token。

### 页面首次打开比较慢

首次启动会创建独立 Chrome 登录环境，可能比日常 Chrome 慢。工具会在首次启动时自动补刷新一次，后续会复用同一登录环境。

### 某些面试没有逐字稿

Moka 可能返回“数据不存在”。这通常表示该场面试尚未生成逐字稿、没有会议数据或当前账号无查看权限。其他面试仍会继续导出。

### 输出文件包含什么

每场面试在 `records` 中对应一条记录，主要字段包括：

```text
candidateName
jobTitle
applicationId
interviewId
interviewerNames
roundName
startTime
transcript
evaluationSummary
questionAnalysis
```

## 数据安全

- 只导出当前 Moka 账号有权访问的数据。
- 密码、验证码、Cookie 和 Token 不会写入导出文件。
- 逐字稿包含候选人个人信息，请只保存到公司允许的位置。
- 不要把导出的 JSON 上传到公开网盘或提交到 GitHub。

开发、测试和发布说明见 [TESTING.md](TESTING.md)。接口字段说明见 [reference/moka-interview-apis.md](reference/moka-interview-apis.md)。
