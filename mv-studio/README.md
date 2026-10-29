# Osmanthus MV — 本机网页画布

这是 Osmanthus 的独立视频端。公开版本保留自由画布、素材上传、分镜编辑、剪辑字幕和 MP4 导出；不附带外部网站的模板目录、展示视频、用户工程、API Key 或模型权重。

## 先运行不调用付费模型的版本

需要 **Node.js 22+** 和可执行的 **FFmpeg / ffprobe**，两者需支持 H.264、AAC。此项目没有第三方 npm 包依赖。

在本目录运行（macOS / Linux）：

```bash
node --version
ffmpeg -version
ffprobe -version
MV_DISABLE_MODELS=1 MV_DATA_DIR=./data node server.mjs
```

打开 <http://127.0.0.1:8792/>。先上传你有权使用的音乐、图片或视频，再进入画布。没有内置示例歌曲，不必恢复原作者的个人工程。数据保存在你自己的 `data/`；退出时在终端按 Ctrl+C。服务默认仅监听本机，不是已完成鉴权隔离的公网服务。

FFmpeg 不在 PATH 时可明确指定：

```bash
FFMPEG_BIN=/your/path/ffmpeg FFPROBE_BIN=/your/path/ffprobe \
MV_DISABLE_MODELS=1 node server.mjs
```

Windows 可在 PowerShell 使用 `$env:MV_DISABLE_MODELS="1"; node server.mjs`，并确保 Node、FFmpeg 和 ffprobe 已加入 PATH。

模型关闭时仍可上传、排列画布素材、手动剪辑、编辑字幕以及使用本地 FFmpeg 合成和提取音轨。AI 分镜、图像、配音和视频生成不会调用供应商；自动字幕和本地图像处理需要另外安装相应本地环境，未配置时会显示不可用。

## 可选：使用自己的模型账号

```bash
cp .env.example .env
# 在本机编辑 .env，填写自己的 Key，并有意将 MV_DISABLE_MODELS 改成 0
node --env-file=.env server.mjs
```

也支持 `MV_ENV_FILE=.env node server.mjs` 显式读取所选配置文件。不会自动读取其他项目或开发者电脑上的密钥。进程已有环境变量优先于该配置文件。不要提交 `.env`。

- `DEEPSEEK_API_KEY`：分镜与画布指令；`DEEPSEEK_MODEL` 按自己的账号可用模型配置。
- `DASHSCOPE_API_KEY`、可选 `DASHSCOPE_WORKSPACE_ID`：阿里图像、语音和视频模型。模型名和地域必须与你自己的权限匹配。
- `MV_VIDEO_BUDGET_CNY`：本地估算预算，不能替代供应商侧的余额、硬限额或真实账单。新生成可能收费。
- `PORT`、`MV_DATA_DIR`、`FFMPEG_BIN`、`FFPROBE_BIN`：服务端运行设置。

当前 AI 一键分镜成片以 5 / 10 秒短链验证；剪辑面板最多组合 8 段、60 秒。全长歌曲 MV 不是已验证的一键能力。

## 可选本地模型

代码不自动下载模型。按模型各自许可准备环境后，可配置：

- `MV_ASR_PYTHON`、`MV_ASR_MODEL`、可选 `MV_ASR_WORKER`：带 `faster_whisper` 的 Python、Whisper base 模型文件夹及识别脚本。默认脚本是 `canvas-audio-worker.py`，识别结果需要校对。
- `MV_VISION_PYTHON`、`MV_VISION_MODELS`、`MV_VISION_PACKAGES`：视觉 Python、模型目录和隔离依赖。默认位置为本目录 `.venv/bin/python`、`models/vision/models`、`models/vision/python-packages`。具体模型文件名和哈希见 `canvas-vision.mjs`。

不配置本地模型不会阻止核心网页和手动剪辑启动。没有将原作者电脑的模型环境或第三方声音库再授权给使用者。

## 与音乐端联动

独立视频端可以直接上传自己的音频。完整音乐端另有 Python、分轨、出谱、音源和工程数据依赖；仅克隆仓库并不等于恢复完整音乐工作台。详见仓库根目录说明。

## 验证

```bash
MV_DISABLE_MODELS=1 node --test --test-concurrency=1 test/*.test.mjs
```

测试在临时目录中使用合成媒体和模拟供应商响应，包含真实 FFmpeg 编码、文件校验与范围下载，不提交付费模型请求。需要 FFmpeg / ffprobe 在 PATH，或用上面的变量指定。缺少可选本地模型和专用语音夹具时，对应离线模型测试会明确跳过；这不等于这些模型已验收。
