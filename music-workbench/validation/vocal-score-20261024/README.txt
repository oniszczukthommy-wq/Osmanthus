第三项：真实演唱谱验证（2026-10-24）

当前结论
已把当前歌曲“雨后慢行”的演唱谱候选接入同一工作台 http://127.0.0.1:8603/?v=vocal-score-3 。可切换五线谱/简谱，下载对应PDF，在原始演唱人声与谱面旋律钢琴参考之间切换试听，并点重点校订位置定位原唱。原歌曲混音、已有轨道修改保留。
最新用户反馈“准确，可以的”：当前这首歌的校订版演唱谱已获用户试听验收通过，绑定当前任务与文件hash，见user-listening-acceptance.json。17处算法提示保留，不等于17处已确认错误；没有逐音人工真值或跨歌曲准确率结论。218字定位完整性与用户试听反馈分别记录。

用户已确认
1. 演唱谱按完整原始演唱生成；试听静音、轨道音量不删谱上的音符。以后真正改旋律/重新演唱才更新源谱。
2. 用户听取42.7–46.1秒原始人声后，确认“走过这安静的街”确实唱出了“安”。
3. 校订以44.06秒为分界，把原模型43.89–44.31秒的F4（MIDI65）拆为“这”“安”两个同音音符；音高保留，其他原始音高与时间不改。
记录在 human-reference-44s.json 与歌曲 data/vocal-score-corrections.json。确认来自用户；44.06秒位置来自TIFA元音边界估计，不冒称用户逐帧标注了时间。

当前版本
- score engine: singing-score-review-2。
- 正式工作台候选任务 bce272f9-1e16-4c77-8af2-a8669b5b5768，原始人声源 c6f722c8-c2da-4fad-879f-e0bde53d80ca。
- 239个音符，218/218字获得位置，17个音符需要重点听辨，人工确认修订1处。
- 基础模型首版：238音符、217/218字、17标记；任务 a323d37f-f2a6-4951-9d66-fef4c441f383 和 output/review/ 保留，不覆盖。
- output/review-v2/ 为当前校订候选；output/pdf/（工作区根目录）是交付副本，delivery-manifest.json记录SHA256。
- 五线谱2页，简谱4页。两者共用一份score.json；原始浮点音高/时间保留，谱面十六分音符量化。
- 音频试听原声为完整原始人声，不受当前vocals 30–45秒静音影响；谱面参考为同一份量化音符的钢琴渲染，不冒充原唱。

实际运行和边界
1. GAME官方v1.0.3 medium ONNX，CPU1线程，官方ONNX协议与OpenVPI dataset-tools实现作为适配依据。模型包约180MB。game_onnx.py。
2. TIFA-1.0官方权重及当前固定源码，中文G2P、CPU1线程；run_tifa.py使用官方类，显式ConfigurationScope.FA，使用输入别名旁边的歌词文本。模型包约151MB。
3. check_pitch_grid.py：在60–181 BPM范围估计候选，独立YIN音高交叉检查。原始首次分析中约95.8%的可比较音符相差半音以内；这是两算法一致性，不是准确率。先前钢琴实验98.4 BPM不能作为演唱谱真值，提示词92 BPM也不能直接使用。
4. 已知旋律的绮萱合成人声控制：8个音高均匹配。GAME起点比合成设定约晚70–88ms，主要对应声母与元音起点差；不得把音高通过说成节奏全部准确。TIFA字边界输出另保留。
5. 全新后台链路实际跑通，fresh-worker-acceptance.json：159.504秒，模型输出236音符/217字/18标记，不改原project.json。该独立验证在人工校订前执行，不是当前239音符候选版本。网页初次任务复用了预先完成的分析，0.34秒；校订版复用现有分析，0.65秒。这两个缓存时间不能冒充全新转谱耗时。
6. GAME D3PM存在随机边界移除，两次新提取有238/236音符差异。当前每首源人声/歌词/校订/引擎版本保持一个不可变候选，刷新和切换记谱格式不会重新提取。不承诺同一音频每次重新推理完全相同。
7. 缓存的独立中文CTC语音模型无给词识别了三个真实歌唱片段，但明显误识别，不用于改写歌词或判定漏唱；见independent-ctc-text-check.json。TIFA强制对齐也不替代真实唱词人工核对。
8. MuseScore原生多格式批量SVG导出出现收尾mutex崩溃，保留日志。当前链改用单独PDF命令成功退出，再用Poppler渲染PNG预览；不把崩溃当成功。简谱用同一数据生成SVG和ReportLab PDF，嵌入系统STHeiti字体，已修复首版CID字体在Poppler缺字的问题。
9. 新 .venv 通过 .pth 复用既有音频/ONNX环境，新依赖只装在本目录，不升级工作台原运行环境。锁定包在requirements.lock.txt；源码和权重hash在resource-provenance.json。仓库代码许可保留于各上游仓库，未对外发布模型或声库。
10. 本轮没有新增歌曲生成费用，没有把歌曲上传给新的外部服务。PRD未改。

接入
- 工作台 scores.py：持久化任务、只读原始人声/歌词、校订hash、版本校验、后台进程、恢复状态及文件白名单/hash校验。
- /api/scores/jobs POST；/api/scores/project/<project_id> GET；/api/scores/jobs/<job_id>/files/<filename> GET。
- score.js：同工程预览、五线谱/简谱切换、PDF下载、原唱/谱面旋律对照与17处问题试听。试听互斥，不会与混音叠放。快速切换/暂停的过期metadata及play Promise取消已处理。
- 后台新歌曲可执行完整链路；源歌词缺失、文件hash错误、过期校订锚点等会停止，不能猜一个谱冒充完成。

验证
score-format-acceptance.json：校订版16项通过，包括MusicXML读回、音高/时值/歌词逐事件一致、两种记谱同数据、每小节完整、239个音符及人工同音拆分、其余原始音高/时间保持。
score-job-contract-acceptance.json：12项临时目录契约测试，进程启动mock；与真实推理验证分开记录。
workflow-acceptance.json、browser-generation.json、browser-playback-proof.json、browser-cancellation-acceptance.json、browser-human-fix.json、browser-final-v2.json：真实浏览器/试听/下载和校订加载证据。
首版两种PDF已实际浏览器下载并核对hash；校订版两种PDF重新渲染和校验，工作台已加载新版本。不要混称校订版两种文件都重新做过浏览器下载。
浏览器原生自动化点击偶有坐标拦截，混音播放使用CDP userGesture、部分切换用已观察DOM按钮处理；真实音频状态已验证，不声称所有路径都是物理鼠标点按。
旧三组混音/分轨/编辑回归通过，见mixer-regression.log。

下一步
优先对17个标记位置和代表性完整段落建立人工参考：实际音高、节奏、字音对应、一字多音、同音反复、起拍。再评估音符/边界误差，修订原始旋律事件或记谱，不用“输入覆盖率”代替准确性。此前用户先确认“安”字存在；最新已确认当前校订谱准确可接受。后续仍需验证其他歌曲与逐音标注指标。
当前歌曲混音已是用户自己应用木吉他候选后的revision87、8轨、指纹00edb9ee225592f25ebb7c5fe5444ad1945e015ed91c16915a96fe85a9af769e。不要回滚到上一轮revision86。

最终浏览器：Ego Space53已成功finish并保留结果页面，旧p1句柄结束。?v=vocal-score-3已显示校订后的五线谱，两张预览加载，原唱播放器暂停；revision87/8轨混音保持。测试工具提示Ego Lite有可用更新，本轮未升级。后续如用户要求继续操作，需按技能claim此保留空间，不可直接复用已结束句柄。
