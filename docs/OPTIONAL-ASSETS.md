# 可选资产与外部工具

公开仓库不包含模型权重、音源和专用二进制（`.gitignore` 明确排除了
`**/models/`、`*.sf2`、`*.ckpt`、`*.safetensors` 等）。本文件记录这些资产
的实际来源、校验值和落盘位置，用于在一台新机器上复现全部功能。

所有路径相对仓库根目录。

## 已就位（本次核对通过）

### 1. FluidSynth 2.6.1（配器 / 换音色渲染）

| 项 | 值 |
| --- | --- |
| 来源 | https://github.com/FluidSynth/fluidsynth/releases/tag/v2.6.1 |
| 资产 | `fluidsynth-v2.6.1-win10-x64-cpp11.zip` |
| 落盘 | `music-workbench/validation/audio-runtime/env/bin/` |
| `fluidsynth.exe` SHA256 | `557b9e98d860a6df6a927e58f6cc274d6451a046da780a1011810d9d00db133d` |
| 依赖 DLL | `libfluidsynth-3.dll`、`SDL3.dll`、`sndfile.dll`（同目录） |

源码里按 Unix 风格写成 `.../bin/fluidsynth`（没有 `.exe`）。`runtime_support.media_tool()`
在 Windows 上会自动补 `.exe`，`arrangement_authoring` 的资产存在性检查因此能通过。
不要手工改名成无扩展名文件。

### 2. GeneralUser GS v2.0.3（SoundFont 音源）

| 项 | 值 |
| --- | --- |
| 来源 | https://github.com/mrbumpy409/GeneralUser-GS |
| 落盘 | `music-workbench/validation/instrument-generaluser/GeneralUser-GS.sf2` |
| 大小 | 32,319,396 字节 |
| SHA256 | `9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe` |

许可为 GeneralUser GS License v2.0，允许个人与商业音乐创作。作者披露部分采样
来源无法百分百确认，分发前请自行复核。

### 3. GAME-1.0.3 medium ONNX（演唱谱：歌声转音符）

| 项 | 值 |
| --- | --- |
| 来源 | https://github.com/openvpi/GAME/releases/tag/v1.0.3 |
| 资产 | `GAME-1.0.3-medium-onnx.zip`（179,775,226 字节） |
| 落盘 | `music-workbench/validation/vocal-score-20261024/models/GAME-1.0.3-medium-onnx/` |

| 文件 | 大小 | SHA256 |
| --- | --- | --- |
| `encoder.onnx` | 40,809,108 | `fb00295abf8156806a3bf2477ccadc9dd6a8f464fa4ee1a65c85100ce17e36fe` |
| `segmenter.onnx` | 80,703,699 | `49c20f890d02f8877be4b092fae3913ec969e9236cf0a91e661e8bf52465ffda` |
| `estimator.onnx` | 74,457,404 | `2662a01e24548dc3b9f8ebc081b26947873c01eeaa573c9d0a87e7bf2a43642b` |
| `bd2dur.onnx` | 4,569 | `6672d56b00f27a20e9bfaa92801c15e394bb520e49031d3ed2515b0a6cf27402` |

模型采样率 44,100 Hz，`game_onnx.py` 以 16 秒分块流式提取（`MUSIC_GAME_CHUNK_SECONDS`
可调，范围 1–30）。CPU 实测约 1.6 倍实时。

## 仍需自行获取

### 4. TIFA-1.0（精确歌词对齐）— 公开仓库未包含

`run_tifa.py` 期望以下结构，但源码树与权重都不在本仓库：

```
music-workbench/validation/vocal-score-20261024/
├── TIFA/                          # 官方源码树（inference.api / lib / g2pflow）
└── models/TIFA-1.0/
    ├── model.pt                   # 约 151MB
    └── dictionaries/ds-zh-pinyin-lite.txt
```

本次检索未定位到官方发布页。若要复现，可改用公共强制对齐器（见下节替代方案）。

### 5. 换声引擎 — 两者都需自行准备

| 引擎 | 来源 | 说明 |
| --- | --- | --- |
| Seed-VC | https://github.com/Plachtaa/seed-vc | 作者固定 commit `51383efd921027683c89e5348211d93ff12ac2a8`；GPL3 |
| YingMusic-SVC | — | 官方权重约 732MB |

落盘位置分别为 `validation/seed-vc-20261025/` 与 `validation/yingmusic-svc-20261025/`。
两者在 CPU 上都很慢（8 秒片段约 225–330 秒），且作者记录的主观听感仍有电音。

### 6. 乐谱 PDF 导出（可选）

生成 MusicXML 之外的 PDF/PNG 预览需要 MuseScore 与 Poppler。缺少它们不影响
`score.json` 与五线谱/简谱数据本身。

### 7. Demucs 权重（自动下载）

`torch` / `demucs` 由 `scripts/install-audio.ps1` 安装；首次分轨会按 Demucs 流程
自动下载 `htdemucs` 权重（约 84MB）。不在本清单固定。

## 安装顺序

```powershell
# 1. 基础环境
python -m venv .venv
python -m pip install -r music-workbench/requirements-core.txt
python -m pip install -r music-workbench/requirements-authoring.txt

# 2. 可选：分轨
powershell -File scripts/install-audio.ps1

# 3. 外部资产：按上表放到对应目录
```

`requirements-authoring.txt` 把 `numpy` 钉在 1.26.4。`music21` 会试图升级到
numpy 2.x，而 Demucs 4.0.1 与 torch 2.5.1+cpu 依赖 1.x —— 升级会同时破坏
分轨和 torch 音频路径。
