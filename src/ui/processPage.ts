import { el, toast } from './widgets';
import { db, newId, type JobRecord, type RestorationMetrics } from '../db';
import { state, DEFAULT_PARAMS } from './state';
import { runPipelineTs } from '../dsp/pipeline';
import { measureResponse } from '../dsp/fir';
import { fftInPlace } from '../dsp/fft';
import { synthesizeTape, WARP_PRESETS, AZIMUTH_PRESETS } from '../dsp/synthesis';

export function processPage(mount: (n: HTMLElement) => void): void {
  const wrap = el('div');
  wrap.append(
    el('h2', { class: 'page-title' }, '修复处理'),
    el('p', { class: 'page-desc' }, '抖晃跟踪与滤波在 AudioWorklet 中实现（试听与离线引擎），本页通过等价的 TypeScript 参考流水线跑完整修复并核算指标。'),
  );

  if (!state.tape || !state.original) {
    wrap.append(el('div', { class: 'card empty' }, '尚未选择磁带，请先到「磁带登记」页导入或合成测试带。'));
    mount(wrap);
    return;
  }

  const params = state.params ?? { ...DEFAULT_PARAMS };
  state.params = params;

  // ---- 参数 ----
  const paramCard = el('div', { class: 'card' });
  paramCard.append(el('h2', {}, '处理参数'));
  const refHz = el('input', { type: 'number', value: String(params.referenceHz) });
  const useHum = el('select', {});
  useHum.append(new Option('专用参考音', 'false'), new Option('交流哼声（无参考音）', 'true'));
  useHum.value = String(params.useHum);
  const humHz = el('input', { type: 'number', value: String(params.humHz) });
  const tapsSel = el('select', {});
  for (const t of [97, 129, 161, 257]) tapsSel.append(new Option(`${t} 抽头`, String(t)));
  tapsSel.value = String(params.taps);
  const boostSel = el('select', {});
  for (const b of [8, 12, 16, 20]) boostSel.append(new Option(`最大提升 ${b}dB`, String(b)));
  boostSel.value = String(params.maxBoostDb);

  const pg = el('div', { class: 'grid-3' });
  pg.append(
    field('参考音频率 (Hz)', refHz),
    field('跟踪信号源', useHum),
    field('哼声基频 (Hz)', humHz),
    field('滤波器抽头数', tapsSel),
    field('高频最大提升', boostSel),
  );
  paramCard.append(pg);

  // 参考带选择（合成测试带时可重建干净带频谱）
  const refHint = el('div', { class: 'muted', style: 'font-size:12px' },
    '参考带用于扣除节目素材的自然频谱滚降。合成测试带可自动生成；真实磁带请加载校准带。');
  paramCard.append(refHint);

  // ---- 进度 ----
  const progCard = el('div', { class: 'card' });
  const stageLabel = el('div', { class: 'muted' }, '等待开始');
  const track = el('div', { class: 'progress-track' }, el('div', { class: 'progress-fill', style: 'width:0%' }));
  const fill = track.firstElementChild as HTMLElement;
  progCard.append(el('h2', {}, '处理进度'), stageLabel, el('div', { style: 'height:10px' }), track);

  const runBtn = el('button', { class: 'btn' }, '开始修复');
  const stopHint = el('span', { class: 'muted' }, '');
  progCard.append(el('div', { style: 'height:14px' }), el('div', { class: 'row' }, runBtn, stopHint));

  // ---- Worklet 自检 ----
  const checkCard = el('div', { class: 'card' });
  const checkBtn = el('button', { class: 'btn secondary' }, '运行 AudioWorklet 自检');
  const checkBody = el('div', { style: 'margin-top:12px' });
  checkCard.append(el('h2', {}, 'Worklet 引擎自检'),
    el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:10px' },
      '在 OfflineAudioContext 中运行三个 Worklet，并与 TypeScript 参考实现交叉验证。'),
    checkBtn, checkBody);
  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    checkBody.replaceChildren(el('div', { class: 'muted' }, '自检运行中…'));
    try {
      const { runWorkletSelfCheck } = await import('../audio/selfCheck');
      const results = await runWorkletSelfCheck();
      checkBody.replaceChildren(...results.map((r) => {
        const row = el('div', { class: 'row', style: 'padding:6px 0' });
        row.append(
          el('span', { class: `badge ${r.pass ? 'done' : 'failed'}` }, r.pass ? '通过' : '失败'),
          el('strong', {}, r.name),
          el('span', { class: 'muted', style: 'font-size:12px' }, r.detail));
        return row;
      }));
    } catch (err) {
      checkBody.replaceChildren(el('div', { class: 'badge failed' }, `自检异常：${(err as Error).message}`));
    } finally {
      checkBtn.disabled = false;
    }
  });

  // ---- 指标 ----
  const metricCard = el('div', { class: 'card' });
  metricCard.append(el('h2', {}, '修复指标'));
  const metricGrid = el('div', { class: 'grid-3' });
  metricCard.append(metricGrid);
  metricGrid.append(el('div', { class: 'empty' }, '处理完成后显示'));

  // ---- 作业历史 ----
  const jobCard = el('div', { class: 'card' });
  jobCard.append(el('h2', {}, '本磁带作业记录'));
  const jobBody = el('div');
  jobCard.append(jobBody);
  refreshJobs();

  runBtn.addEventListener('click', async () => {
    params.referenceHz = Number(refHz.value) || 1000;
    params.useHum = useHum.value === 'true';
    params.humHz = Number(humHz.value) || 50;
    params.taps = Number(tapsSel.value);
    params.maxBoostDb = Number(boostSel.value);

    runBtn.disabled = true;
    fill.style.width = '5%';
    stageLabel.textContent = '准备参考带频谱…';

    try {
      // 参考带频谱：用同类素材的无损合成样本作为校准基准
      let reference;
      const refTape = synthesizeTape({
        sampleRate: state.original!.sampleRate,
        durationSeconds: Math.min(20, state.original!.channels[0].length / state.original!.sampleRate),
        warp: WARP_PRESETS.mild,
        azimuth: { ...AZIMUTH_PRESETS.aligned, lossDbAt10k: 0 },
        hum: { baseHz: 0, level: 0 },
        referenceToneHz: 0, referenceLevel: 0, noiseLevel: 0,
        seed: 777,
      });
      reference = measureResponse(refTape.clean.left, state.original!.sampleRate, 8192, { fft: fftInPlace });

      fill.style.width = '15%';
      stageLabel.textContent = '抖晃跟踪 → 变采样率校正 → 方位角估计 → 高频补偿…';
      const t0 = performance.now();
      // 让进度条先绘制
      await new Promise((r) => setTimeout(r, 30));
      const result = runPipelineTs(
        { sampleRate: state.original!.sampleRate, channels: state.original!.channels, reference },
        params,
      );
      const elapsed = (performance.now() - t0) / 1000;
      const durationSec = state.original!.channels[0].length / state.original!.sampleRate;
      const metrics: RestorationMetrics = {
        ...result.metrics,
        processingSeconds: elapsed,
        realtimeFactor: durationSec / Math.max(elapsed, 1e-6),
      };

      fill.style.width = '90%';
      state.restored = {
        sampleRate: state.original!.sampleRate,
        channels: [result.restored.left, result.restored.right],
      };
      state.metrics = metrics;

      const job: JobRecord = {
        id: newId('job'),
        tapeId: state.tape!.id,
        status: 'done',
        progress: 1,
        stage: '完成',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        params: { ...params },
        metrics,
      };
      await db.put('jobs', job);
      state.job = job;

      fill.style.width = '100%';
      stageLabel.textContent = `完成，耗时 ${elapsed.toFixed(2)}s（实时倍率 ${metrics.realtimeFactor.toFixed(1)}×）`;
      renderMetrics(metricGrid, metrics, result.azimuth.thetaArcmin);
      refreshJobs();
      toast('修复完成，可前往试听页对比');
    } catch (err) {
      stageLabel.textContent = '处理失败';
      toast((err as Error).message, true);
    } finally {
      runBtn.disabled = false;
    }
  });

  wrap.append(paramCard, progCard, checkCard, metricCard, jobCard);
  mount(wrap);

  async function refreshJobs() {
    const all = await db.getAll<JobRecord>('jobs');
    const jobs = all.filter((j) => j.tapeId === state.tape!.id).sort((a, b) => b.startedAt - a.startedAt);
    if (!jobs.length) {
      jobBody.replaceChildren(el('div', { class: 'empty' }, '暂无作业'));
      return;
    }
    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', {}, '状态'), el('th', {}, '方位角'), el('th', {}, '10k 残余'),
      el('th', {}, '耗时'), el('th', {}, '实时倍率'))));
    const tb = el('tbody');
    for (const j of jobs) {
      tb.append(el('tr', {},
        el('td', {}, el('span', { class: 'badge done' }, '完成')),
        el('td', { class: 'mono' }, `${j.metrics?.azimuthArcmin.toFixed(2)}′`),
        el('td', { class: 'mono' }, `${j.metrics?.residualDbAt10k.toFixed(2)}dB`),
        el('td', {}, `${j.metrics?.processingSeconds.toFixed(2)}s`),
        el('td', { class: 'mono' }, `${j.metrics?.realtimeFactor.toFixed(1)}×`)));
    }
    table.append(tb);
    jobBody.replaceChildren(table);
  }
}

function renderMetrics(grid: HTMLElement, m: RestorationMetrics, azimuth: number): void {
  const azOk = Math.abs(m.azimuthStdArcmin) <= 2;
  const hfOk = Math.abs(m.residualDbAt10k) <= 1;
  const items: Array<[string, string, boolean, string?]> = [
    ['方位角估计', `${azimuth.toFixed(2)} 角分`, true, `标准差 ${m.azimuthStdArcmin.toFixed(2)}′（指标 ≤2′）`],
    ['声道延迟', `${m.delayMs.toFixed(3)} ms`, true],
    ['抖晃峰值', `${m.warpPeakPercent.toFixed(2)}%`, true],
    ['修复前 10k 损耗', `${m.lossDbAt10k.toFixed(2)} dB`, true],
    ['修复后 10k 残余', `${m.residualDbAt10k.toFixed(2)} dB`, hfOk, '指标：与参考带相差 ≤1dB'],
    ['方位角稳定性', `${m.azimuthStdArcmin.toFixed(2)} 角分`, azOk],
  ];
  grid.replaceChildren(...items.map(([k, v, ok, sub]) => {
    const card = el('div', { class: `metric ${ok ? 'ok' : 'warn'}` });
    card.append(el('div', { class: 'v' }, v), el('div', { class: 'k' }, k));
    if (sub) card.append(el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' }, sub));
    return card;
  }));
}

function field(label: string, input: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, el('span', { class: 'lbl' }, label), input);
}
