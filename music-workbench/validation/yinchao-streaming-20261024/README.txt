音潮边生成边试听：本地端到端验证

启动：
在项目根目录运行 python3 validation/yinchao-streaming-20261024/server.py
打开 http://127.0.0.1:8602/

复用 validation/.env.local 内的音潮 Key，浏览器不读取密钥。
默认使用音潮 v4.5 和上一轮 DeepSeek 原创《末班车的窗》歌词。
点击生成会实际创建一首付费任务，文档标价为 0.22 元。
打开页面时优先恢复已保存的任务；已有试听与下载不需要重新生成。

验证内容：
1. 服务端提交任务，保留任务 ID，轮询并逐次保存原始响应。
2. 收到 status=stream、pipe_url 后，显示可试听按钮。
3. 服务端携带 Bearer Key 代理官方 audio/mpeg 流，向本地播放器分块转发。
4. 记录浏览器真实 playing、timeupdate、waiting、stalled 和 ended 事件。
5. 收到 done 后保存完整 MP3；正在播放的流保持原播放器，不强制重载。
6. 完整文件支持 HTTP Range，供浏览器跳转、重播与下载。

证据：
runs/<本地任务ID>/request.json：本次实际提交的参数。
runs/<本地任务ID>/observations.jsonl：各次真实状态查询结果。
runs/<本地任务ID>/state.json：服务端阶段与浏览器事件时间线。
runs/<本地任务ID>/complete.mp3：完整歌曲。
browser-first-play.json：整首完成前浏览器播放时间已推进的快照。
browser-continuity.json：生成完成后播放器继续播放的快照。
browser-downloaded-complete.mp3：从页面下载的成品。

本次干净验证的记录：
本地任务ID：30855397-a1bd-4857-84a8-ed476ffa7c23
首次观测到流式地址：19.207 秒。
代理首次收到音频字节：24.633 秒。
浏览器首次实际播放：24.797 秒，此时服务端状态仍为 stream。
后台生成完成：86.381 秒。
完整 MP3 下载就绪：89.645 秒。
播放器从 stream 状态连续推进到 done 后 65 秒以上，未被切换为新音频。
开始播放后的 waiting/stalled 事件计数为 0；开始播放前的缓冲事件另记。
完整音频时长 142.942 秒，44.1kHz 双声道 MP3，解码完整性检查通过。

首轮另一个任务用于排错：发生查询连接错误、代理 DNS 和流式鉴权问题；
在完成后才验证播放通道，不能作为“整首完成前播放成功”的证据。
两轮只创建两首歌曲，按文档价格合计约 0.44 元；不涉及百炼。

边界：
这是本地隔离的播放链路验证页面，尚未合入多轨工作台。
一次干净成功不能证明生产环境的长期稳定性；首次可播时间也会随排队与网络变化。
首段等待时间和整首生成耗时分别计量，没有使用假进度模拟音频生成。
不表示能边听边改变模型尚未生成的后半段；生成后编辑仍要单独验证。
完整时长未达到原来 150-210 秒要求，仍需后续验证时长控制。

官方流式接口说明：
https://platform.yinchaoyongxian.com/docs/api-reference/song/song-stream
