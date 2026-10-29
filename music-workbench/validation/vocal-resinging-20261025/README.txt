第五项：歌手/音色切换与重新演唱，2026-10-25

当前用户方向
- 用户明确拒绝绮萱重唱：听感不能接受，声音太机械、不自然。
- 用户要求使用之前整理的音色库，不再使用该女声。
- 从已有音色库明确选择“抒情男声”，网页音色ID 226869000163476。

已完成的技术试验（不代表听感合格）
1. resynthesize.py以已确认的雨后慢行239音符及TIFA音素时间合成绮萱完整主唱。
   输入音高由已校订旋律及原始人声约束自相关引导，保留一部分源F0起伏。
   40–48秒片段约14.70秒，完整94.772秒约171.21秒，22个分块，无削波。
   完整任务5a07a5ca-b01c-4fcd-8c9a-240ae6519761复用了本轮已完成的实际合成，前台时间不得冒充171秒推理。
2. 主唱版本基础设施：不可变candidate文件+vocal-variants.json，单轨切换，保留其他轨与片段/整轨混音，支持撤销/重做与恢复原唱。
   新演唱改变乐谱输入指纹，原“安”字校订与原谱验收不自动转给新演唱；恢复原唱时原谱继续可用。
   variant-invariants.json：22项真实音频临时工程检查通过；为验证通用基础设施，测试夹具里解除拒绝标记，线上候选仍拒绝。
3. 以上绮萱候选主观听感已失败，见user-listening-decision.json，未应用到用户真实工程。
   PRESETS enabled=false；Project拒绝应用rejected_by_user候选；实验入口hidden，不作为正式可用效果。

已有音色库接入
- research/minimax-voice-knowledge-20261024：572条目录，571段有效本地试听。并非571份可加载歌手权重。
- voice_library.py + voice-library.js接入主工作台：搜索名字/标签、性别/语言过滤、试听、保存目标音色。
- GET /api/voice-library?project_id=...，GET /api/voice-library/samples/<ID>，POST /api/voice-library/select。
- 选择写入单独voice-reference-selection.json，不改变歌曲音轨或混音版本；有工程/版本防串歌检查。
- 试听由本机白名单文件、SHA与HTTP Range提供。不同播放器互斥。
- UI明确标注“参考音色/朗读试听、唱歌转换尚待验证”；不能把选择成功当作已换歌手。
- 实际浏览器已选抒情男声，selected-voice-library-browser.json；library-acceptance.json六项通过。
- 只使用既有本地目录，未重新调用MiniMax API，也未将网页ID冒充音乐API的歌手ID。

新的换声试验（进行中）
- 引擎：Plachtaa/seed-vc，固定commit 51383efd921027683c89e5348211d93ff12ac2a8。
- 官方支持歌声转换的v1 F0-conditioned 44.1k模型；CPU2线程，30步，length_adjust=1，auto_f0_adjust=false，semitone_shift=0。
- 模型与环境位于validation/seed-vc-20261025/；代码GPL3，完整上游源码与LICENSE保留；未训练、未改权重。
- 独立.venv通过.pth复用本地音乐运行时，小依赖只安装在本目录，不升级主工作台环境。
- convert_existing_voice.py：原始雨后慢行40–48秒人声→以已有抒情男声试听作本地参考条件。
- 参考文件SHA绑定既有preview-manifest.json；仅本机个人实验，未上传歌曲给新的服务，也未对外分发试听或部署收费服务。
- 这是参考条件换声实验，不是已取得MiniMax歌手权重，不是MiniMax官方Music Voice ID接入。
- 音频输出、实际时长/音高与主观自然度仍需验证；整体第五项未通过。

原工程
雨后慢行保持revision87/8轨，混音指纹00edb9ee225592f25ebb7c5fe5444ad1945e015ed91c16915a96fe85a9af769e。
当前界面歌曲仍是最后一盏灯，revision0，原始演唱未改。目标音色选择另存，不是音轨改动。
本轮没有新增音潮付费生歌任务。PRD未修改。

后续实测与用户反馈
- Seed-VC 8秒转换已完成：总279.87秒（含首次准备）、未移调，音高YIN中位差5.49c；用户认为有改善但仍有电音。quality未通过。
- YingMusic-SVC官方732MB权重已实际加载并转换同8秒，50步CPU：总329.02秒，推理225.32秒；用户认为有改善，但最后2–3秒有电音。
- 找到原8秒输入在“远”字中途截止，故改用38–52秒原始上下文输入，再比较40–49秒完整尾句。
- 纯MPS方案先遇到F0 float64不支持（已用float32兼容适配）；全模型常驻MPS产生严重内存压力，被主动停止，无输出，不冒充成功。
- CPU语义/F0/声纹 + MPS flow + 声码器阶段卸载flow的混合运行实际完成14秒上下文：总182.59秒，推理166.31秒，输出13.990秒。中间40–49秒9秒样例无须补尾，音高交叉中位差4.49c；用户反馈“有减轻，但还需要改善”，仍未通过。
- 对照均同原始伴奏、对应人声RMS对齐、共同混音headroom；未声称算法一致性等于人工准确率。
- MDX Reverb_HQ_By_FoxJoy原始8秒去混响已跑出Reverb与No Reverb两份真实WAV；首次报告用了错误属性，在文件已成功输出后报告失败，已从文件恢复报告，无重复推理冒充成功。
  正确参数dim_t=512、FFT6144、hop1024、CPU ONNX；此前默认256导致ONNX转Torch的未完成试验已停止。
- 下一轮：保持抒情男声与模型/旋律/歌词不变，先对38–52秒上下文原人声去混响，再换声。用户已明确授权继续改善，尚未听到这一版。
- 音频/反馈：conversion-226869000163476、yingmusic-226869000163476、yingmusic-context38-52-mps-hybrid下各有audio-check.json/user-listening-decision.json。
- smoothness-comparison/保留A原始/B Seed/C Ying的同响度同伴奏8秒对照。

最新用户验收与停工口径（2026-10-25）
用户“没事，就这样吧，大差不差就好”：接受当前抒情男声完整上下文短段作为首版可接受候选，停止继续细调。
接受的是yingmusic-context38-52-mps-hybrid/converted-mix.mp3，原歌40–49秒9秒试听、输入38–52秒。current-accepted-candidate.json绑定文件SHA。允许少量残余电音，不宣称零伪影或全曲换声已验收。
清理后再换声的追加实验yingmusic-clean-context-mps-hybrid已停止，未覆盖已接受候选。去混响工具独立14秒输出有效，但未用于已接受候选。
原歌曲仍未应用新主唱，当前最后一盏灯revision0和原雨后慢行revision87均保留。全曲应用/导出仍待后续继续，不能将短段技术验收误写为第五项全部完成。
