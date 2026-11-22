import { store } from '../store';
import { toast } from './register-page';
import { runKernelPipeline } from '../../dsp/kernel-pipeline';
import { saveRestoredWav } from '../audio-service';
import { putTape } from '../../storage/idb';
import type { RestorationReportRecord } from '../state';

export function renderProcessPage(el: HTMLElement): void {
  const state = store.getState();
  if (!state.active) {
    el.innerHTML = `<div class="empty">尚未选择磁带。请先到「磁带登记」页导入 WAV。</div>`;
    return;
  }
  const { record, sampleRate } = state.active;

  el.innerHTML = `
    <h2 class="page-title">修复处理</h2>
    <p class="page-sub">磁带：${escapeHtml(record.title)}（${escapeHtml(record.catalogNo)}）·
      采样率 ${sampleRate} Hz · ${((record.durationSec ?? 0) / 60).toFixed(1)} 分钟</p>

    <div class="card">
      <h2>处理参数</h2>
      <div class="form-grid">
        <div class="form-field">
          <label>参考音频率（Hz，无参考音填 0 走交流哼声）</label>
          <input id="refHz" type="number" value="${state.active.spec.refToneHz}" min="0" step="1" />
        </div>
        <div class="form-field">
          <label>交流哼声频率（Hz）</label>
          <input id="humHz" type="number" value="${state.active.spec.humHz}" min="20" step="1" />
        </div>
      </div>
      <div class="btn-row">
        <button id="run" class="btn">开始修复</button>
        <button id="goto-listen" class="btn secondary" disabled>前往试听</button>
      </div>
      <div id="progress" style="display:none;">
        <div class="progress-track"><div class="progress-fill" style="width:0%"></div></div>
        <div class="progress-msg" id="progress-msg">准备中…</div>
      </div>
    </div>

    <div class="card" id="report-card" style="display:none;">
      <h2>修复报告</h2>
      <div class="metric-grid" id="metrics"></div>
    </div>
  `;

  const runBtn = el.querySelector<HTMLButtonElement>('#run')!;
  const listenBtn = el.querySelector<HTMLButtonElement>('#goto-listen')!;
  const progressBox = el.querySelector<HTMLElement>('#progress')!;
  const fill = progressBox.querySelector<HTMLElement>('.progress-fill')!;
  const msg = el.querySelector<HTMLElement>('#progress-msg')!;

  runBtn.onclick = async () => {
    const active = store.getState().active!;
    const refHz = Number(el.querySelector<HTMLInputElement>('#refHz')!.value);
    const humHz = Number(el.querySelector<HTMLInputElement>('#humHz')!.value);
    const spec = { ...active.spec, refToneHz: refHz, humHz };
    runBtn.disabled = true;
    progressBox.style.display = 'block';
    fill.style.width = '5%';
    msg.textContent = '初始化修复引擎…';

    try {
      // 让进度条先渲染一帧
      fill.style.width = '20%';
      msg.textContent = '抖晃跟踪与方位角估计…';
      await new Promise(r => setTimeout(r, 30));
      // 纯 TS 内核（与自动化测试同一实现），同步执行；分阶段更新进度
      const [chL, chR] = active.channels;
      fill.style.width = '45%';
      msg.textContent = '设计高频补偿并执行校正滤波…';
      await new Promise(r => setTimeout(r, 20));
      const result = runKernelPipeline(chL, chR, spec);
      const audioSec = chL.length / active.sampleRate;
      const realtimeFactor = (result.elapsedMs / 1000) > 0 ? audioSec / (result.elapsedMs / 1000) : 0;
      fill.style.width = '100%';
      msg.textContent = '修复完成';

      // 持久化修复后 WAV
      toast('正在保存修复结果…');
      const { blobId } = await saveRestoredWav(active.record, [result.outL, result.outR], active.sampleRate);

      const report: RestorationReportRecord = {
        trackHz: result.trackHz,
        trackSource: result.trackSource,
        azimuthArcmin: result.azimuth.angleArcmin,
        wowRmsPct: result.drift.wowRmsPct,
        flutterRmsPct: result.drift.flutterRmsPct,
        wowFlutterPct: result.drift.wowFlutterPct,
        eqResidual10kDb: result.eq.map(e => e.residualAt10kDb),
        realtimeFactor,
        elapsedMs: result.elapsedMs,
      };
      const updatedRecord = {
        ...active.record,
        status: 'processed' as const,
        restoredBlobId: blobId,
        report,
      };
      await putTape(updatedRecord);

      store.setState({
        active: { ...active, spec, drift: result.drift, azimuth: result.azimuth, eq: result.eq, restored: [result.outL, result.outR], record: updatedRecord },
      });
      renderReport(el, report);
      listenBtn.disabled = false;
      toast('修复完成并已保存', 'success');
    } catch (err) {
      toast(`修复失败：${(err as Error).message}`, 'error');
      runBtn.disabled = false;
    }
  };

  listenBtn.onclick = () => store.setState({ page: 'listen', compareOriginal: true });

  // 已修复过则直接展示历史报告
  if (state.active.record.report) {
    renderReport(el, state.active.record.report);
    listenBtn.disabled = !state.active.restored;
  }
}

function renderReport(el: HTMLElement, r: RestorationReportRecord): void {
  const card = el.querySelector<HTMLElement>('#report-card')!;
  const metrics = el.querySelector<HTMLElement>('#metrics')!;
  card.style.display = 'block';
  const eqWorst = Math.max(...r.eqResidual10kDb.map(v => Math.abs(v)));
  const items: { label: string; value: string; unit: string; good?: boolean; warn?: boolean }[] = [
    { label: '跟踪源', value: r.trackSource, unit: '' },
    { label: '方位角', value: r.azimuthArcmin.toFixed(2), unit: '角分' },
    { label: 'Wow (RMS)', value: r.wowRmsPct.toFixed(3), unit: '%' },
    { label: 'Flutter (RMS)', value: r.flutterRmsPct.toFixed(3), unit: '%' },
    { label: '抖晃峰峰', value: r.wowFlutterPct.toFixed(2), unit: '%' },
    { label: '10kHz 补偿残差', value: eqWorst.toFixed(2), unit: 'dB', good: eqWorst <= 1, warn: eqWorst > 1 },
    { label: '处理速度', value: r.realtimeFactor.toFixed(1), unit: '× 实时' },
    { label: '耗时', value: (r.elapsedMs / 1000).toFixed(2), unit: '秒' },
  ];
  metrics.innerHTML = items.map(m => `
    <div class="metric ${m.good ? 'good' : ''} ${m.warn ? 'warn' : ''}">
      <div class="label">${m.label}</div>
      <div class="value">${m.value} <span class="unit">${m.unit}</span></div>
    </div>`).join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
