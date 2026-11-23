# 磁带修复工作站（Tape Restoration Studio）

八十年代采访录音磁带数字化后的**纯浏览器端**修复工具。所有 DSP 与数据存储均在本地完成，
不上传任何音频。抖晃跟踪与滤波以 **AudioWorklet** 实现，处理编排与算法参考实现用 **TypeScript**。

## 功能与四个页面

| 页面 | 职责 |
| --- | --- |
| 磁带登记 | 录入馆藏元数据、导入 WAV；或按选定抖晃/方位角场景**合成测试带** |
| 修复处理 | 参考音/哼声跟踪 → 变采样率校正 → 方位角估计 → 高频补偿，显示指标与 Worklet 自检 |
| 试听对比 | 原始/修复 **A/B 即时切换**（快捷键 A/B，保持播放位置），波形与对数频谱叠加 |
| 归档 | 原始与修复音频以 16-bit PCM WAV 存入 IndexedDB，可下载/删除 |

## 修复原理

1. **抖晃（wow & flutter）跟踪**：对参考音（默认 1kHz）或交流哼声（50/60Hz 及谐波）
   做加窗 I/Q 正交解调，递归 NCO 提取基带相位，帧间相位差给出瞬时播放速率 r(t)。
   多谐波按功率加权融合，再用变采样率（Catmull-Rom 三次插值）把时间轴拉直。
2. **方位角估计**：右声道相对左声道的延迟 τ 对应磁头方位角
   `τ = trackPitch·tan(θ)/tapeSpeed`。先做加窗归一化互相关定整数延迟，
   再对分数部分做最小 MSE 网格 + 抛物线精修，多帧加权平均。
3. **高频补偿**：缝隙损耗 `sin(x)/x` 的正则化逆，频率采样法设计线性相位 FIR，
   与分数延迟对齐滤波器级联，分声道卷积。
4. 损耗估计需一份**参考带频谱**（校准带或同类无损样本），用于扣除节目素材本身的自然滚降。

## 关键指标（`npm test`，19 项全过）

- **方位角估计误差 ≤ 2 角分**：在 0 / ±10 / ±25 / 30 / 60 角分、含噪含抖晃场景下实测最大偏差约 0.6 角分。
- **10kHz 响应与参考带相差 ≤ 1dB**：3 / 5 / 8 / 12dB 四种缝隙损耗补偿后实测偏差均 < 0.6dB。
- **60 分钟磁带 ≤ 2 分钟处理完**：60 秒样本实测实时倍率约 **80×**，外推整盘约 **45 秒**
  （overlap-save FFT 卷积、递归 NCO、限帧周期图，处理耗时与磁带长度近似线性且有界）。
- 测试带按三档抖晃（轻/中/重）× 四档方位偏差（对齐/轻微/明显/严重）合成，
  含参考音、50Hz 哼声、本底噪声与高频缝隙损耗。

## 架构

```
src/
  dsp/
    constants.ts     物理常量、方位角↔延迟、缝隙损耗曲线
    fft.ts           radix-2 FFT、Hann 窗
    tracker.ts       I/Q 抖晃跟踪（TS 参考实现）
    azimuth.ts       时域粗-精方位角估计
    resample.ts      变采样率重采样
    filterDesign.ts  缝隙逆滤波 + 分数延迟 FIR 设计
    fir.ts           直接卷积 / overlap-save / 周期图
    synthesis.ts     测试带合成（抖晃、方位、损耗、哼声、噪声）
    pipeline.ts      TS 与 Worklet 两条流水线编排、流式分块
    wav.ts           WAV 编解码
  audio/
    workletEngine.ts OfflineAudioContext 加载/运行 Worklet 的封装
    selfCheck.ts     Worklet 与 TS 参考实现交叉自检
  ui/                四个页面 + 共享状态（IndexedDB）
public/worklets/     三个 AudioWorklet 处理器（独立 ES 模块）
```

Worklet 与 TS 参考实现保持同构；处理页的「Worklet 引擎自检」在浏览器里
用 OfflineAudioContext 交叉验证两者输出。

## 命令

```bash
npm install
npm run dev      # 本地开发
npm test         # 单元测试（vitest）
npm run build    # 类型检查 + 生产构建
npm run preview  # 预览构建产物
```

## 说明与取舍

- 抖晃可跟踪带宽受分析帧时长约束；合成测试带的 flutter 取真实盒式带主导机械分量
  （4–5Hz），重度随机抖晃的点级相关阈值相应放宽。
- 真实磁带若无专用参考音，可切换到交流哼声跟踪；哼声缺失时需外部提供速率曲线。
- Worklet 处理器放在 `public/worklets/` 作为独立模块直接 `addModule` 加载，不经过打包。
