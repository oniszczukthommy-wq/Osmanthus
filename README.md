# Osmanthus

**AI 音乐与 MV 创作工作台 · Open-source music and music-video workspace**

面向懂一些音乐、希望借助 AI 完成歌曲和编配的人。你可以复用、修改和二次开发本项目的原创代码，许可为 [MIT](LICENSE)；完整范围见 [LICENSE_SCOPE.md](LICENSE_SCOPE.md)。

## 创作流程

想法 → 展示并编辑歌词 → 用户确认 → 生成两版歌曲 → 试听选择 → 分轨、对话与手动编辑 → 导出。

开启“纯音乐”后，跳过写词与歌词确认，直接生成两版器乐候选；不加载歌词对齐或演唱谱。高级模式允许自填歌词；生成接口提供可播放音频流后可开始试听，完成后接续完整文件。歌曲封面并行生成。播放器使用随播放旋转的唱片，音频未就绪时显示加载状态；歌词核对与对照采用中型窗口。纯音乐样例已验证生成和播放，但时长仍由模型决定，尚不能保证每首都在 150–210 秒；接口未提供音频流时，需等成品音频就绪后试听。MV 保留自由画布、素材上传、分镜、剪辑字幕和 MP4 导出。

## 当前可运行范围

| 内容 | 新电脑的要求 |
| --- | --- |
| MV 独立界面、画布、素材管理 | Node.js 22+；可先关闭模型启动。 |
| 本地剪辑、音频处理、MP4 导出 | 安装 FFmpeg 和 ffprobe。 |
| AI 图片、分镜、视频生成 | 配置自己的 DeepSeek / 阿里万相等账号与 Key，费用由使用者承担。 |
| 完整音乐工作台、歌曲生成和分轨 | 需另配 Python 环境、YinChao/DeepSeek Key、自有音频工程；不是克隆即可一键全功能运行。 |
| 演唱谱、配器、换声、离线识别 | 需分别配置模型、音源和工具，遵守各自许可并验证效果。 |

本项目以本机浏览器原型为目标；没有注册、订阅计费或多租户隔离，不是开箱即用的公网 SaaS 部署方案。

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

新电脑需要自行恢复 `validation/audio-separation/.venv`、FFmpeg、相应模型与音源，配置 `music-workbench/validation/.env.local`，并用自己的音频准备 `validation/track-edit-e2e-20261024/data/` 工程。原电脑的工程、分轨 WAV、音色试听、缓存和 API Key 都不在此仓库中。目前未提供覆盖所有音乐依赖的自动安装与首次空工程初始化脚本。不要把个人数据或他人的 Key 当作安装依赖。

## 目录

- `mv-studio/`：独立 MV 应用与测试。
- `music-workbench/`：音乐生成、编辑、乐谱、音源适配与测试源码。
- `licenses/`、`THIRD_PARTY_NOTICES.md`：第三方许可。
- `docs/PUBLIC-SOURCE-MANIFEST.json`：公开源码整理范围。

## 测试与贡献

MV 的核心自动测试使用隔离临时数据，不提交付费模型生成；安装 FFmpeg 后在 `mv-studio/` 运行 `npm test`。额外本地模型的效果和云 API 听感仍需自行验收。

欢迎 Issue 和 Pull Request。请使用虚构测试输入，不要上传 Key、个人工程、受限音源、模型权重或未经许可的媒体。提交新模型适配时请说明许可、资源要求及实际测试边界。

## License

Original code: MIT. Dependencies, model weights, voice banks, media and external APIs keep their own terms. See [third-party notices](THIRD_PARTY_NOTICES.md).
