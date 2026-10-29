# 已验证的局部编配核心

`arrangement_authoring.py` 是从隔离试听通过版本移植的纯编配/声部渲染模块。音符、指型选择、0.28拍拨弦手势、力度、30ms边缘处理与FluidSynth参数均未顺手修改。它不处理原曲混音、不打开Project、不登记额外音轨、不写 `additional-tracks.json`。

用户接受的是《向海而行》40–56秒这次原曲/新增钢琴/新声部重编木吉他的试听。它不表示原和弦、重拍或其他歌曲的自动编配全部通过。新任务仍应产生候选供试听；模块不会把每次 `render` 自动标成已接受。

## 调用

```python
from arrangement_authoring import AuthoringResources, build_notes, render_part

resources = AuthoringResources(
    root=ROOT,                         # workbench数据根，用于保护原工程
    protected_roots=(source_data_dir,) # 可保护root之外的源工程
)
result = build_notes(
    harmony_segments,
    ordinary_beats_seconds,
    start_seconds,
    end_seconds,
    "piano",                         # 或 "acoustic_guitar"
    vocal_context,
    resources=resources,
)
rendered = render_part(
    result,
    job_directory,
    "light-piano",                    # 简单文件名，不含路径
    sample_rate=44100,
    job_root=job_directory,            # 必填，只允许写入此作业内
    resources=resources,
)
```

`AuthoringResources` 还能显式设置 `soundfont`、`chords_db`、`synth`。默认资源来自本代码目录：小型数据库在 `resources/chords-db/guitar.json`，音源与FluidSynth继续使用已有相邻 `instrument-generaluser/GeneralUser-GS.sf2`、`audio-runtime/env/bin/fluidsynth`。`root` 可以是临时测试工作台；改变数据根不会导致默认只读资源跟着指向不存在的临时目录。没有可变的全局配置，同进程不同任务可传各自资源。

输入音符与和声区间是原曲绝对秒；输出WAV和MIDI以选区开始为0秒。MIDI的120 BPM、960 PPQ只是时间序列化时钟，不代表把歌曲改为120 BPM。`rendered.midi_time_encoding`明确记录口径，逐音回读需在1tick内。WAV保持选区的精确帧数。

和声项包含 `start_seconds/end_seconds,label,pitch_classes,root_pc,bass_pc`，可保存 `evidence/uncertainty/roman`。普通拍点必须严格递增。`vocal_context.active_intervals` 是谱面有音符区间，不能冒充原录音绝对静音；缺少上下文时保守减密，不编造句间空档。缺少某段和声时新增声部不跨该空段延音。

返回结构继续为 `notes/voicings/checks/arr_spec/audit`。其中 `arr_spec` 是程序运行计划，不冒称完整mc-workflow规格；隔离目录里的正式ARR-SPEC交接另有逐项豁免。`render_part`新增 `render` 元数据并返回其内容。

## 输出边界与重试

- `job_root`由作业管理器指定，输出必须在其中。拒绝写入workbench的 `data`、`projects`、显式保护目录，以及带 `preparation.json/project.json/additional-tracks.json` 的源工程祖先内。
- 路径解析会检查符号链接逃逸；已有输出文件/符号链接/同名渲染子目录不会被覆盖。失败重试应使用新的作业目录或新的stem，已完成作业应由上层缓存复用。
- 模块只写新的MIDI、声部WAV、逐段渲染文件及结果JSON。原曲基底、整曲长度画布、候选登记、应用/撤销均由上层负责。
- 声部为原试听相同的原始音量，不归一化整曲。调用方沿用冻结策略：同一原曲基底、相同新增part RMS目标、必要时共同降低新层以留余量；不能分别归一化原曲，也不能用限幅器悄悄更改原曲。

## 环境与测试证据

本机现有 `audio-separation/.venv` 实际具备 music21 9.7.1、Mido、NumPy 2.5.4、SoundFile 0.13.1；原隔离 `vocal-score-20261024/.venv` 为music21 10.5.1、NumPy 2.3.5、SoundFile 0.14.0。**两个已有环境均测试通过，无需安装包或切换worker。**

6项针对性测试覆盖3/4音声部、指定转位、和声空隙、冲突输入、输出逃逸/源工程保护、拒绝覆盖与资源参数化：

```sh
../audio-separation/.venv/bin/python test_arrangement_authoring.py
```

两环境分别重建真实16秒钢琴和吉他，与原试听part比较：音符及指型完全相同；44100Hz双声道705600帧的解码float32样本逐位相同，最大差为0；MIDI回读通过；原隔离输入/输出文件SHA均未变。JSON的路径或新增元数据不同不算声音变化。

证据位于：

- `../arrangement-evidence-20261026/integration-proof/authoring-vocal-score/equivalence-report.json`
- `../arrangement-evidence-20261026/integration-proof/authoring-existing-worker/equivalence-report.json`

需要重新复现时指定一个**全新的**作业输出目录：

```sh
../audio-separation/.venv/bin/python test_arrangement_authoring.py --equivalence-dir /absolute/new/authoring-verification-job
```

若在另一个部署环境确实缺依赖，最小已有环境切换是仅让编配作业解释器指向 `vocal-score-20261024/.venv/bin/python`，应用服务和分轨进程无需一起迁移；当前本机不需要这样做。不要在请求处理时临时pip安装。
