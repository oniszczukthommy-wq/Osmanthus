# Windows 使用 Osmanthus

本仓库提供 Windows 10 / 11（64 位）本机浏览器运行入口。音乐与 MV 共用 `http://127.0.0.1:8603/`，不需要 Mac、WSL 或原作者电脑的歌曲工程。

## 第一次安装

1. 下载仓库 ZIP 并完整解压，或用 Git 克隆。建议解压到有写入权限的目录，例如 `D:\Osmanthus`；中文和空格路径也纳入自动测试。
2. 安装 **Python 3.12 64 位、Node.js 22+、FFmpeg（含 ffprobe）**，加入 PATH。Windows 自带的 `curl.exe` 用于音乐流传输。在 PowerShell 中也可使用：

   ```powershell
   winget install -e --id Python.Python.3.12
   winget install -e --id OpenJS.NodeJS.LTS
   winget install -e --id Gyan.FFmpeg
   ```

   安装后重新打开终端，使 PATH 更新。包名来源：[微软 Python 清单](https://github.com/microsoft/winget-pkgs/tree/master/manifests/p/Python/Python/3/12)、[微软 FFmpeg 清单](https://github.com/microsoft/winget-pkgs/tree/master/manifests/g/Gyan/FFmpeg)。也可以从各软件官网安装。
3. 双击 **`Setup-Windows.cmd`**。脚本检查依赖，在项目内创建 `.venv`，安装基础 Python 包，并在没有 `.env` 时复制配置模板。不会覆盖已有配置，不会下载大模型，不会生成付费内容。
4. 用记事本打开根目录 `.env`，填入你自己的密钥：

   - `DEEPSEEK_API_KEY`：歌词、对话和 MV 规划。
   - `YINCHAO_API_KEY`：歌曲生成。
   - `DASHSCOPE_API_KEY`：歌曲封面、MV 图片和视频。
   - 需要付费 MV 生成时，把 `MV_DISABLE_MODELS=1` 改为 `0`，并核对本地图片/视频预算；预算值不替代供应商账户限额。

5. 双击 **`Start-Osmanthus.cmd`**。启动后会打开浏览器。首次没有歌曲是正常空白状态，可从输入想法开始创作。

运行不需要保持命令窗口开启。关闭服务用 **`Stop-Osmanthus.cmd`**；它只停止本启动器记录且身份匹配的进程，不删除歌曲、工程或配置。重新启动会恢复已保存工程。排查依赖用 **`Check-Windows.cmd`**，日志在 `music-workbench/.local/osmanthus-web/`。

这些批处理文件只对本次 PowerShell 进程使用执行策略参数，不修改整台电脑的执行策略。

## 功能与额外依赖

| 功能 | 要求 |
| --- | --- |
| 首页、歌词确认、歌曲列表、生成及试听、封面 | 基础安装；云端生成需自己的 API Key 和供应商权限。 |
| 已有分轨工程的手动/对话混音、WAV/MP3 导出 | 基础安装和 FFmpeg；对话需要 DeepSeek。 |
| 新歌分轨、进入可编辑多轨工程 | 额外安装 Demucs / PyTorch。基础安装不会冒充已分轨，也不会伪造乐器轨道。 |
| MV 选段、画布、素材、剪辑、MP4 导出 | 基础安装；中文字幕使用 Windows 本机中文字体。 |
| AI 分镜、图片、万相视频 | 自己的模型账号、权限与预算。 |
| 演唱谱、精确歌词对齐、换声、重编配、声音参考 | 仍需各自本地模型、音源和专用环境。它们没有随公开仓库分发，不能用基础安装通过来代替模型效果验收。 |

可选分轨安装见 `Install-Audio-Tools.cmd`。这会安装较大的 CPU 版 PyTorch 和 Demucs；第一次实际分轨还会按 Demucs 的流程下载权重，速度取决于 CPU 和网络。其他专用环境在 Windows 下使用 `.venv\Scripts\python.exe`；源码保留这些入口，但尚未完成所有专用模型的 Windows 实机听感验收。

GitHub 不包含 API Key、你的历史歌曲、分轨 WAV、受许可限制的声音库和模型。要迁移你原来的作品，应单独复制自己的工程和媒体；不要上传公开仓库或把 Mac 的虚拟环境复制到 Windows。原电脑上的文件不会因本次兼容更新而删除。

## 配置及常见问题

- 端口被占用：在 `.env` 修改 `MUSIC_EDITOR_PORT` 或 `MUSIC_MV_PORT`；启动器不会终止无关进程。
- FFmpeg 不在 PATH：设置 `FFMPEG_BIN=C:\ffmpeg\bin\ffmpeg.exe`、`FFPROBE_BIN=C:\ffmpeg\bin\ffprobe.exe`，或者将其目录加入 PATH。
- 字幕字体：自动查找微软雅黑、黑体和宋体；也可以设置 `MV_SUBTITLE_FONT` 为本机能覆盖歌词文字的字体。字幕缺字会报错，不会悄悄导出乱码。
- 不要在浏览器代码里填写 Key；只在服务器 `.env` 中填写，重启服务生效。
- 自动测试使用隔离的临时工程和合成媒体，不消耗音乐/视频 API 余额。测试覆盖空白启动、跨进程锁、进程存活检测、真实 WAV/MP3 编码、编辑后重启恢复和 MV 字幕导出。云模型听感与速度仍由实际账号和设备决定。

自动测试记录：[Windows and portable startup](https://github.com/oniszczukthommy-wq/Osmanthus/actions/workflows/windows.yml)。

模型调用次数、两个服务的独立额度账本、损坏任务恢复及受限下载规则见 [调用限额与安全恢复说明](SAFETY_LIMITS.md)。修改 `.env` 后重启生效；不要通过删除账本或损坏的任务文件来解除限制。
