GeneralUser GS 真实渲染验证（2026-10-23）

来源与安装
- 官方仓库 https://github.com/mrbumpy409/GeneralUser-GS
- 固定 commit 684543d5e5efaef08d02be50dcda8d552478fa60，v2.0.3（官方变更记录日期 2026-02-22）。
- 本次用户明确授权重新测试；只在当前目录保存 SF2、官方许可、文档和测试产出，没有恢复旧 Skills，也没有改 PRD。
- SF2 大小 32,319,396 字节。文件哈希与下载来源见 source-manifest.json。
- 项目隔离运行时 ../audio-runtime/env/bin/fluidsynth 2.6.1；不修改 MuseScore 全局设置或系统音频配置。

测试方法与产出
- 原始旋律 ../fixtures/score-source.json，160 BPM，8 小节，12 秒，21 个音符及休止符。
- melody-piano.wav 与 melody-nylon-guitar.wav 具有相同音高、起始时间、时值、力度，仅 MIDI program 从 0 改到 24。
- fingered-bass.wav、standard-drums.wav、rhythm-section.wav 是另外编写的 4 小节 6 秒节奏样例，与原始旋律不是同一份音符数据。
- 所有 WAV 是 44.1kHz、双声道、PCM16，可在网页和常见播放器中播放。
- 音频有乐器释放尾音，因此文件长度比音符总时长稍长。
- 实测每份短样例离线渲染 0.13–0.28 秒，包含每次重新加载音源；不代表完整 AI 歌曲或产品最终延迟。
- 所有文件通过有效 WAV、非静音和零削波检查；钢琴/吉他波形哈希不同。完整结果见 validation-report.json。
- 这是客观渲染验证，没有据此声称其主观音质达到最终成品标准。

产品用途
可把结构化伴奏轨（MIDI/音符事件）交给 FluidSynth，渲染为音轨 WAV，再在网页工作台替换这条轨道的 AudioBuffer。旋律/节奏和乐谱均可继续使用相同音符数据。它可以快速覆盖钢琴、吉他、贝斯、鼓等基础配器。
它不负责 AI 作曲、人声演唱、整曲分轨或按新乐器演奏法重编配。音源更换只实现“换音色”。

许可与限制
官方自定义 GeneralUser GS License v2.0 声明允许个人或商业音乐创作、软件项目使用和音源修改。作者同时披露：部分来自历史免费音源的采样原始来源不能百分之百确认。本地自用原型可以继续评估；如果以后把音源随公开或商业产品分发，应重新评估具体采样来源及产品分发方式。官方完整许可保存在 documentation/LICENSE.txt。

复现
python3 validation/instrument-generaluser/test_generaluser.py '/Users/zyx/Documents/ChatGPT/音乐类/validation/audio-runtime/env/bin/fluidsynth'

声望数据
GitHub 页面本次核查 190 Star / 15 Fork，非引擎星数。本次 API 查询因公共限流返回 403，星数/Fork 由官方 GitHub 页面核对，未伪称 API 成功。
