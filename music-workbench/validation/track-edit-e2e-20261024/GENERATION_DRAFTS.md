# 歌词预览、确认与双方案生成

2026-10-28：按用户最新决定，生成歌曲前先展示歌词，允许编辑并明确确认；成曲后的局部改词与续写移出本次范围。

## 接口

1. `POST /api/generation/drafts`，正文 `request_id`（UUID）、`brief`、`style`、`voice`，可选 `lyrics` 和 `title`。只调用写词服务，或展示用户提供的歌词，不提交音潮歌曲任务。
2. `GET /api/generation/drafts/{id}` 轮询；`GET /api/generation/drafts` 列表。`writing → ready / error`，支持 `POST /{id}/resume` 恢复。
3. `POST /api/generation/drafts/{id}/save`，正文 `version`、`lyrics`，可选 `title/style/voice`。按版本检查保存；文字与设置实际改变时版本增加。保存也不提交歌曲。
4. `POST /api/generation/drafts/{id}/confirm`，正文 `version`、`fingerprint`（上一步响应提供）。确认的歌词、歌名、风格、人声要求先持久化，然后启动两首歌；返回 `{draft,batch}`。
5. 后续沿用 `GET /api/generation/batches/{id}`、候选媒体和 `/select` 接口。所选歌曲才准备分轨工程。

新建歌曲的入口统一走草稿确认。原 `/api/generation/batches` 与 `/api/generation/jobs`（包含 dual 别名）拒绝新请求直接绕过确认，已有请求的幂等重放保留；已有音频导入不涉及新歌付费提交。

## 一致性

- 确认冻结整份歌词与生成设置，不接受 `approved:true` 之类客户端自报标记。
- 批次 ID 由草稿 UUID 确定性派生。重复点击、连接中断、服务恢复使用同一批次；不会因重复确认生成额外歌曲。
- 确认记录必须先写盘；瞬时写盘失败后的重试也重新完成这一步，不能跳过审批持久化。
- 确认后该草稿不可继续改字。另一次创作要新建草稿，再次展示和确认；已经生成的两首保持原文。
- 双候选使用同一份已确认歌词，确认后不再走自动改写/修复歌词流程。两首的旋律、演唱时序和音色仍可能不同。
- 批次保存 `lyric_draft_id`、`lyric_draft_version`、`lyric_approval_fingerprint`，可追溯实际请求。

## 页面

`/` 与 `/studio` 为接入真实后端的新版；`/legacy` 保留旧编辑页供历史功能排查。新页面的流程是“生成歌词 → 编辑/重写 → 确认歌词并生成两首 → 试听采用 → 分轨 → 对话/手动编辑 → 导出”。

语音识别只填待发送文本，仍需用户核对；时长和歌曲实际演唱完整性由模型输出决定，接口确认歌词不等于保证模型逐字唱完整。
