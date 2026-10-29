# 本机分享与文件分享

`share.py` 的 `ShareManager` 冻结当前混音的一个版本，生成 MP3 / WAV 并精确复制对应封面、海报（存在且校验匹配时）。不会调用公网托管，也不会创建指向 localhost 的伪公网二维码。

## 服务端接线

```python
from share import ShareManager
SHARES=ShareManager()

# POST /api/shares
with LOCK:
    check_context(body)
    snapshot=PROJECT.audio_snapshot()
# 编码在全局编辑锁之外完成。artwork仅由服务器查询取得，不能接受客户端文件路径。
result=SHARES.create(snapshot,body,artwork)
```

正文：`request_id`（每次分享保留的UUID）、`project_id`、`revision`；可选 `title`、`quote`、`creator`。署名可为空。相同 UUID 与内容重放复用同一份文件；同 UUID 改变内容或版本被拒绝。

可选 `artwork` 的服务器映射：

```python
{
  'project_id': snapshot.state['id'],
  'source_sha256': snapshot.state['source_sha256'],
  'cover': {'path': '/absolute/cover.png', 'sha256': '...'},
  'poster': {'path': '/absolute/poster.png', 'sha256': '...'}, # 可省略
}
```

封面也兼容扁平的 `path` / `sha256`。资源必须是 PNG、JPG 或 WebP。封面/海报不匹配歌曲身份或文件哈希时，整次分享失败，不混入其他作品的图片。

路由：

- `GET /api/shares/{uuid}` → `SHARES.public(SHARES.read(uuid))`
- `GET /api/shares/{uuid}/files/{filename}` → `serve(SHARES.asset(uuid,filename))`
- `GET /share/{uuid}` → `serve(ROOT/'share-view.html')`
- 静态文件：`/share-view.css`、`/share-view.js`

返回 `local_url`、`audio_url`、`wav_url`、`cover_url`、`poster_url`、`share_text` 和带哈希的 `files`。没有资源时对应 URL 为 null，不声称已生成。已冻结的分享不随后续轨道编辑或封面更新改变。

## 前端行为

独立分享页可播放当前快照，复制歌名/歌词，下载 MP3、封面和海报。系统支持文件分享时，以 `navigator.share` 发送真实音频文件；不支持时发起下载，由用户自行发送。不会自动向任何联系人发送消息。

当前服务监听127.0.0.1，`access_scope=local_device`，页面始终提示“本机预览链接”。对外公开网页链接需要另行部署可访问的音频与分享页。

## 检查

`test_share.py`：10项实际编码和文件检查，包括PCM24样本、MP3解码、旧版本隔离、请求重放、图片冻结、跨作品资源拒绝、篡改/路径拒绝、峰值保护、来源不变。测试不修改主工程。

## 未分轨的生成成品

`ShareManager.create_original(job, source_path, body, artwork=None)` 冻结已下载的原始 `complete.mp3`，不加载工程、不分轨、不重编码。root可接 `POST /api/shares/generated`：检查candidate_id为本机已有任务、download_ready为true，再从受控 `workflow/runs/{candidate_id}/complete.mp3` 传文件，不能接受用户传路径。正文 `request_id`、`candidate_id`，可选标题/歌词/署名；若有revision必须为0。返回 `source_kind=generated_original`、`version_label=原始生成成品`，WAV为空，MP3与原文件字节完全一致。复用同请求不能替换已分享的原始音频。

测试现为12项，新增原始成品冻结、源文件删除后保持可用、未完成/错身份/来源变化拒绝。
