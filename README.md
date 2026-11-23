# 磁带录音修复工具(Tape Rescue)

针对八十年代采访磁带数字化的修复工具:机器老化造成的抖晃(音调漂移)、
磁头方位角偏差(左右声道不同步、高频发闷)的自动测量与校正。

## 功能

- **参考音检测**:自动找带首对位音(1kHz 等)和交流电哼声(50/60Hz),
  频率用正交解调相位斜率精化到亚赫兹
- **抖晃跟踪**:正交解调 + 块内相位最小二乘斜率拟合,得到速度偏差曲线 ε(t);
  对位音缺失的段落自动切换哼声接力跟踪
- **音高校正**:按 ε(t) 做时变重采样(8 抽头窗 sinc 查找表插值,10kHz 无附加滚降)
- **方位角估计**:左右声道高频互谱相位-频率加权拟合 → 声道间时差 → 方位角;
  分数样本延时对齐声道
- **高频补偿**:按估计方位角设计 sinc 损耗的逆 FIR(限幅防深零反演),FFT 快速卷积
- **试听对比**:原始/修复一键切换;抖晃跟踪与校正滤波以 AudioWorklet 实时运行
  (支持离线曲线模式和 Worklet 内现场跟踪模式)

## 页面

| 页面 | 功能 |
|---|---|
| 磁带登记 | 编号、年代、类型、带速、内容等元数据登记(localStorage 持久化) |
| 修复处理 | 加载音频 → 后台 Worker 跑修复管线 → 偏差曲线 / EQ 曲线 / 指标展示 |
| 试听对比 | 原始 ↔ 修复 A/B 切换,AudioWorklet 实时处理 |
| 归档 | 归档记录、导出修复后 WAV(24bit)和处理报告 JSON |

## 运行

```bash
npm install
npm run serve     # 编译并启动 http://localhost:8321/
```

## 测试与验收

```bash
node dist/tools/synth.js test-tapes   # 合成几种抖晃 × 方位角偏差的测试带 WAV
npm run verify                        # 精度验收(5 组场景)
npm run bench                         # 性能验收(60 分钟磁带)
```

合成测试带:带首 1kHz 对位音 + 节目内容(谐波簇 + 宽带噪声 + 10kHz 校准音)
+ 50Hz 哼声,叠加正弦 wow/flutter + 随机漂移的速度偏差,以及方位角劣化
(声道间分数延时 + 每轨 sinc 高频损耗),同时输出未劣化参考带。

### 验收结果(本机实测)

| 指标 | 要求 | 实测 |
|---|---|---|
| 方位角估计误差 | ≤ 2 角分 | ≤ 0.12 角分(5 组场景) |
| 补偿后 10kHz 响应与参考带差 | ≤ 1 dB | ≤ 0.23 dB |
| 60 分钟磁带处理时间 | ≤ 2 分钟 | 67–78 秒(约 50 倍实时) |
| 残余抖晃 | (参考) | 0.075–0.19%(注入 0.3–1.5%) |

## 结构

```
src/dsp/       DSP 核心(纯 TS,Node / 浏览器 / Worklet 通用)
  fft.ts         基-2 FFT、重叠相加快速卷积、Goertzel
  interp.ts      8 抽头窗 sinc 分数延时插值表
  reference.ts   参考音/哼声检测与频率精化
  wowtrack.ts    抖晃跟踪(WowTracker 实时类 + 离线块估计)
  pitchcorrect.ts 时变重采样音高校正
  azimuth.ts     方位角估计、声道对齐、损耗模型
  hfeq.ts        高频补偿 FIR 设计与施加
  wav.ts         WAV 编解码
  pipeline.ts    修复管线编排
src/worklet/restore-worklet.ts   AudioWorklet:实时抖晃跟踪 + 校正滤波
src/ui/        页面(登记/处理/试听/归档)+ 处理 Worker
tools/synth.ts   测试带合成    tools/verify.ts  精度验收
tools/bench.ts   性能验收      tools/serve.mjs  静态服务器
```
