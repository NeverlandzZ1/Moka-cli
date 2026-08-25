---
name: moka-interview-transcripts
description: 通过 Moka 专用 Chrome 登录会话查询或导出候选人、应聘岗位、面试官和面试逐字稿。用户提到 Moka 面试记录、会议转写、候选人逐字稿或批量导出时使用。
---

# Moka 面试逐字稿

使用 `opencli moka` 命令完成操作。不要让 HR 接触 CDP、Cookie、Token 或接口参数。

## 登录状态机

1. 先运行 `opencli moka status -f json`。
2. 如果专用 Chrome 未连接，运行 `opencli moka login -f json`。
3. 如果 `mokaLogin` 是 `waiting_for_user`，告诉用户已打开 Moka，请其在浏览器中完成登录；暂停数据操作，不要索要账号、密码、验证码、Cookie 或 Token。
4. 用户确认登录后重新运行 `opencli moka status -f json`。只有 `mokaLogin` 为 `authenticated` 才继续。
5. 会话失效时回到第 2 步，不尝试绕过登录或权限控制。

## 数据操作

- 批量导出：`opencli moka export-transcripts --output <绝对路径>.json -f json`
- 按姓名导出：增加 `--candidate "<候选人姓名>"`
- 查看应聘记录：`opencli moka applications --candidate "<候选人姓名>" -f json`
- 查看某应聘记录的面试：`opencli moka interviews <applicationId> -f json`
- 查看单场逐字稿：`opencli moka transcript <applicationId> <interviewId> -f json`

导出后检查 `stats` 和 `errors`。向用户报告输出路径、应聘记录数、面试数、成功取得的逐字稿数、暂无逐字稿数和错误数；有单项错误时保留已成功结果，不要把整个任务描述成失败。

需要判断字段来源或排查接口变化时，读取 [Moka 接口说明](../../reference/moka-interview-apis.md)。

只读取当前登录账号有权访问的数据。逐字稿包含候选人个人信息，不要上传到未获授权的外部服务。

