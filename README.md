# 磁带修复工作室 · Tape Restoration Studio

老化模拟开盘磁带数字化修复的网页工具。纯 TypeScript DSP 内核 + AudioWorklet
预留实时路径 + IndexedDB 归档，无需后端，所有处理在浏览器本地完成。

## 功能（四个页面）

1. **磁带登记** `src/app/pages/register-page.ts`
   录入元数据、导入 WAV（分块解码，避免整文件驻留内存）、建立档案。
2. **修复处理** `src/app/pages/process-page.ts`
   一键执行完整修复链，展示实时进度与修复报告（方位角、抖晃、10kHz 残差、吞吐）。
3. **试听对比** `src/app/pages/listen-page.ts`
   原始 / 修复后 A/B 来回切换，保持播放位置连续。
4. **归档** `src/app/pages/archive-page.ts`
   档案管理、修复 WAV 下载、归档状态切换、存储占用统计、删除。

## DSP 处理链（与音频处理顺序一致）

```
参考音/哼声检测 → 块级 DFT 锁相跟踪（IQ 解调）→ 校正曲线（中值去野点+平滑）
→ GCC-PHAT 方位角估计 → 间隙损耗测量 + 逆补偿 FIR 设计
→ 逐通道：变速重采样（Catmull-Rom）→ 分数延迟方位对齐 → FIR 高频补偿 → 陷波
```

核心代码位于 `src/dsp/`，全部为无 DOM 依赖的纯 TypeScript，可在 Node 与浏览器复用：

| 模块 | 职责 |
| --- | --- |
| `wow-flutter.ts` | 块级 DFT 单 bin 锁相、相干度门限、校正曲线后处理、wow/flutter 指标 |
| `azimuth.ts` | GCC-PHAT 粗延迟 + 全带解缠绕相位斜率精修，延迟→方位角物理换算 |
| `eq-design.ts` | 间隙损耗模型、归一化频响测量、对数倍频程平滑、逆 FIR 设计与自检 |
| `resampler.ts` | 流式变速重采样器、三阶分数延迟 |
| `fft.ts` | 迭代 radix-2 复 FFT（正/逆变换） |
| `kernel-pipeline.ts` | 纯 TS 修复链编排（自动化测试与 UI 共用同一实现） |
| `synthesis.ts` | 三档损伤（mild/severe/humOnly）测试带合成器 |

AudioWorklet 处理器在 `src/worklets/`，供浏览器实时渲染路径使用（`restoration-engine.ts`），
UI 当前直接调用经过完整测试的纯 TS 内核，保证结果与自动化验收一致。

## 命令

```bash
npm install
npm test          # 34 个单元/端到端测试
npm run bench     # 处理吞吐基准（验收线 ≥30× 实时）
npm run build     # 类型检查 + 生产构建
npm run dev       # 本地开发服务器
```

## 验收指标（测试覆盖）

- **方位角误差 ≤ 2 角分**：端到端合成带 mild/severe/humOnly 三场景验证。
- **10kHz 高频补偿残差 ≤ 1dB**：FIR 设计自检（实测响应 × FIR 理论响应）。
- **处理速度 ≥ 30× 实时**：60s 重度损伤带约 1.9s 处理完，外推 60 分钟磁带 < 2 分钟。
- 参考音/哼声自动检测、抖晃跟踪收敛、WAV 编解码往返、长时稳定性等均有测试。

## 存储

`src/storage/idb.ts` 用 IndexedDB 分别存放磁带元数据与音频 Blob，支持容量配额查询，
音频数据不随状态对象整体载入，控制内存峰值。
