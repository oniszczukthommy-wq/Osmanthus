# osmanthus 双方案生成后端

状态：已接入新版工作台。按最新决定，先预览并确认歌词，再启动双方案；详见 GENERATION_DRAFTS.md。

## 创建与轮询

实际新建入口是 `POST /api/generation/drafts`，预览、保存后调用草稿 `/confirm`。下述批次参数是确认服务内部提交给双方案管理器的结构；公共批次创建接口只接受已有批次的幂等重放，新请求不能绕过歌词确认。

```json
{
  "request_id": "前端生成并保留的UUID",
  "brief": "周末傍晚走到海边的轻松歌曲",
  "style": "中文 R&B",
  "voice": "成熟温暖的男中音，普通话清楚自然"
}
```

返回202。相同 request_id 和输入重复提交返回同一批次；相同 request_id 配不同输入返回409。不要因网络超时重新生成 request_id。

原 `POST /api/generation/jobs` 的 dual 别名与单曲入口也禁止新的未确认歌曲请求；历史记录仍可查询、重放和恢复。

`GET /api/generation/batches` 列出批次；`GET /api/generation/batches/{batch_id}` 轮询详情。

一个批次只有一份共享歌词。A采用简洁生成要求，B加入少量已审阅的曲风特征；原始主题、风格和人声描述均保留。用户有明确排除/限定要求时改用保守的约束保留建议。提示策略不显示在批次公共响应里；服务端保存真实提示、来源和请求。

响应含 `candidates`，每个候选独立 UUID、`candidate_slot`、中性 `label`、`stage`、`status`、`media.stream`、`media.complete`、`can_select`、`can_resume`、`can_retry_generation`。URL均为本机代理，不把服务商鉴权发到浏览器。

批次状态：`lyrics`、`generating`、`partially_available`、`awaiting_selection`、`preparing`、`ready`、`error`、`preparation_error`。一首可播放后就提供它的媒体地址；另一首继续处理。原始音频时长先用供应商报告，选中分轨后使用解码帧数校验。

候选歌词文本相同，但不复用同步时间或乐谱。当前沿用选中工程的歌词对齐与出谱接口；未选候选没有提前生成独立歌词时间轴。前端不得将原歌曲或另一个候选的时间轴套到它上面。

## 用户选择

`POST /api/generation/batches/{batch_id}/select`

```json
{"candidate_id":"该批次当前候选的UUID"}
```

仅接受完整文件已准备好的本批次候选。选定后才进入 Demucs 分轨；未选曲保留音频，不创建工程。重复选择同一候选不重复执行运行中的任务。分轨进行中拒绝切到另一首；准备完成后显式选择另一首可以为其另建工程，保留已有工程。

`ready` 响应的 `project_id` 等于候选 UUID，不等于批次 UUID。前端随后使用已有 `/api/projects/activate`，并携带当前工程 ID/版本检查上下文。对话、手动操作、WAV/MP3导出、歌词和出谱都使用所选候选工程。

选择不会偷偷切换全局正在编辑的工程；激活仍由前端明确调用。

## 恢复与失败

- `POST /api/generation/batches/{batch_id}/resume`：恢复写词、查询既有歌曲任务、重新下载或重试所选曲分轨。候选未选中时始终停在 `awaiting_selection`。
- `POST /api/generation/batches/{batch_id}/candidates/{candidate_id}/retry`，正文 `{"request_id":"本次重试的UUID"}`：仅用于供应商已明确 `fail/cancelled` 的候选，创建新的付费尝试。另一首不变，旧尝试和任务ID保留；重复同一重试ID不新增任务。
- 提交结果不明且没有供应商任务ID时，停止并提示核对，避免自动重复扣费。此时不会把重试按钮当作安全可用。
- 一首失败、另一首完成时仍可采用完成曲。
- 分轨失败保留完整音频，恢复不会重新生成歌曲。
- 服务重启由批次管理器恢复双候选；原单曲恢复器跳过这些候选，防止自动为两首都分轨。

## 验证范围

生命周期与故障测试：`test_generation_pairs.py`。旧歌词修正和工作流恢复测试继续保留。

真实端到端记录：`../dual-generation-backend-20261028/`。歌曲听感与固定歌手身份不属于接口验证的通过结论。

新版 UI 已接线；封面或对外分享接口未在此次新增，也没有把试验 Skill 整包安装到产品。Skill辅助逻辑采用经筛选的少量风格描述，不能保证音乐模型逐项遵循。
