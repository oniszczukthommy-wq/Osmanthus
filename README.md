# Osmanthus

**AI 音乐与 MV 创作工作台 · Open-source music and music-video workspace**

[项目展示与用户流程](https://github.com/oniszczukthommy-wq/ai-music-workbench-showcase) · [好友临时体验网关说明](music-workbench/tools/FRIEND_DEMO.md)

面向懂一些音乐、希望借助 AI 完成歌曲和编配的人。你可以复用、修改和二次开发本项目的原创代码，许可为 [MIT](LICENSE)；完整范围见 [LICENSE_SCOPE.md](LICENSE_SCOPE.md)。

## 创作流程

想法 → 展示并编辑歌词 → 用户确认 → 生成两版歌曲 → 试听选择 → 分轨、对话与手动编辑 → 导出。

开启“纯音乐”后，跳过写词与歌词确认，直接生成两版器乐候选；不加载歌词对齐或演唱谱。高级模式允许自填歌词；确认歌词后，先返回音频流的一版会自动开始试听，另一版继续生成；手动暂停或换歌会取消自动试听。流传输不使用成品下载的低速超时限制。生成完成后直接用成品播放地址从当前位置接续，无需等待本机下载完；断流时继续等待同一首，避免误切其他歌曲。供应商未返回音频流时，需要等待可用音频。当前已实测在整曲完成前出声，但测试链路仍出现流速不足、缓冲与 TLS 超时；持续流式试听尚未通过稳定性验收，不保证固定首声延迟。歌曲封面并行生成。播放器使用随播放旋转的唱片，音频未就绪时显示加载状态；歌词核对与对照采用中型窗口。纯音乐样例已验证生成和播放，但时长仍由模型决定，尚不能保证每首都在 150–210 秒；接口未提供音频流时，需等成品音频就绪后试听。MV 保留自由画布、素材上传、分镜、剪辑字幕和 MP4 导出。

新创作采用第一首优先：先提交 A，收到第一首完整音频地址后再启动 B，同时继续第一首的试听和本地保存。新策略不重建或清理历史歌曲。界面使用加载动效，隐藏模型生成／写词过程文案，保留歌词确认、试听与错误提示。调度已通过隔离测试，首声等待缩短幅度尚未用新付费歌曲实测。

首页的灵感按钮调用 DeepSeek 生成可编辑的主题、配器和段落发展建议，不直接启动歌曲生成。歌曲详情与歌词面板跟随实际播放时钟滚动；未分轨成品可先基于完整音频准备歌词时间轴，已有工程使用对应的人声对齐。新歌首次同步需要准备时间，不使用平均分句模拟演唱时间。

## 当前可运行范围

| 内容 | 新电脑的要求 |
| --- | --- |
| MV 独立界面、画布、素材管理 | Node.js 22+；可先关闭模型启动。 |
| 本地剪辑、音频处理、MP4 导出 | 安装 FFmpeg 和 ffprobe。 |
| AI 图片、分镜、视频生成 | 配置自己的 DeepSeek / 阿里万相等账号与 Key，费用由使用者承担。 |
| 音乐工作台、歌曲生成 | 基础 Python 安装及自己的 YinChao/DeepSeek Key；首次可空白启动。新歌分轨另装 Demucs。 |
| 演唱谱、配器、换声、离线识别 | 需分别配置模型、音源和工具，遵守各自许可并验证效果。 |

本项目以本机浏览器原型为目标；没有注册、订阅计费或多租户隔离，不是开箱即用的公网 SaaS 部署方案。

音乐和 MV 文字调用有各自持久化的次数限额，失败或结果不确定的供应商请求也计次；金额预算仍独立保留。新限制只记录启用后的调用，不追溯已有账户支出。下载限制在登记工程的媒体目录内；损坏的历史生歌记录保留原文件并停止自动付费恢复，不影响其他正常歌曲。配置、重启和恢复注意事项见 [调用限额与安全恢复说明](docs/SAFETY_LIMITS.md)。

画布多标签冲突、音乐保存失败回滚、预览缓存回收、预算锁恢复、异步媒体处理、本机访问限制及主分支检查规则见 [可靠性与回归说明](docs/RELIABILITY.md)。

## Windows 本机运行

完整解压后，按 [Windows 安装说明](docs/WINDOWS.md) 安装 Python 3.12、Node.js 22+ 和 FFmpeg，运行 `Setup-Windows.cmd`；填写自己的 `.env`，再双击 `Start-Osmanthus.cmd`。统一入口为 <http://127.0.0.1:8603/>。停止用 `Stop-Osmanthus.cmd`，依赖检查用 `Check-Windows.cmd`。

首次启动不需要原电脑的歌曲文件。基础包支持音乐与 MV 网页、云端生成接入、已有工程混音和本地导出；新歌分轨可另运行 `Install-Audio-Tools.cmd`。出谱、歌词对齐、换声及重编配仍需专用模型与音源，不能把启动通过等同于全部模型在 Windows 上已验收。

## 快速开始：独立 MV 工作台

安装 Node.js 22+、FFmpeg 和 ffprobe 后：

```sh
git clone https://github.com/oniszczukthommy-wq/Osmanthus.git
cd Osmanthus/mv-studio
export FFMPEG_BIN="$(command -v ffmpeg)"
export FFPROBE_BIN="$(command -v ffprobe)"
MV_DISABLE_MODELS=1 npm start
```

打开 http://127.0.0.1:8792/ 。上传你有权使用的本地音乐／图片／视频即可操作核心画布与剪辑流程。没有提供第三方歌曲或视频包。

模型调用为可选项：复制 `mv-studio/.env.example` 为 `.env`，填写你自己的 Key 并核对预算，使用 `node --env-file=.env server.mjs` 启动。`.env` 不会提交到 Git。详见 [MV 使用说明](mv-studio/README.md)。

## 完整音乐工作台

`music-workbench/` 包含原型源码。现有运行环境的统一入口是 `python3 music-workbench/tools/osmanthus_web.py start`，默认音乐端口 8603，MV 挂载在 `/mv/`。

新电脑安装 `music-workbench/requirements-core.txt` 后，可以用空白工作台启动，不要求已有歌曲工程。启动器读取根目录 `.env`，也兼容 `music-workbench/validation/.env.local`。支持从 PATH 或配置解析 FFmpeg，Windows / macOS 的虚拟环境路径分别处理。原电脑的歌曲、分轨 WAV、音色试听、缓存和 API Key 不在仓库中；高级本地模型和音源需按许可另行准备。

## 目录

- `mv-studio/`：独立 MV 应用与测试。
- `music-workbench/`：音乐生成、编辑、乐谱、音源适配与测试源码。
- `licenses/`、`THIRD_PARTY_NOTICES.md`：第三方许可。
- `docs/PUBLIC-SOURCE-MANIFEST.json`：公开源码整理范围。

## 测试与贡献

MV 的核心自动测试使用隔离临时数据，不提交付费模型生成；安装 FFmpeg 后在 `mv-studio/` 运行 `npm test`。额外本地模型的效果和云 API 听感仍需自行验收。

Windows / Linux CI 还执行音乐付费限额、歌词重试、批次恢复、媒体路径及 MV 文字调用/HTTP 回归；测试使用临时账本、合成媒体和假供应商，不使用你的真实余额。通过这些回归不代表已解决全部审查发现，也不替代完整的模型听感验收。

欢迎 Issue 和 Pull Request。请使用虚构测试输入，不要上传 Key、个人工程、受限音源、模型权重或未经许可的媒体。提交新模型适配时请说明许可、资源要求及实际测试边界。

## License

Original code: MIT. Dependencies, model weights, voice banks, media and external APIs keep their own terms. See [third-party notices](THIRD_PARTY_NOTICES.md).
