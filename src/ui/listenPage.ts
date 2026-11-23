import { el, toast } from './widgets';
import { state, bundleToWavBlob, type AudioBundle } from './state';

export function listenPage(mount: (n: HTMLElement) => void): void {
  const wrap = el('div');
  wrap.append(
    el('h2', { class: 'page-title' }, '试听对比'),
    el('p', { class: 'page-desc' }, '在原始录音与修复结果之间即时切换，配合波形与频谱图核对抖晃、声道同步与高频补偿效果。'),
  );

  if (!state.original) {
    wrap.append(el('div', { class: 'card empty' }, '暂无音频，请先在登记页导入或合成测试带。'));
    mount(wrap);
    return;
  }

  // ---- A/B 切换 ----
  const modeCard = el('div', { class: 'card' });
  const toggle = el('div', { class: 'toggle-wrap' });
  const btnOrig = el('button', { type: 'button' }, '原始录音 A');
  const btnRest = el('button', { type: 'button' }, '修复结果 B');
  toggle.append(btnOrig, btnRest);
  modeCard.append(el('h2', {}, 'A / B 切换'), toggle,
    el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
      '快捷键：按 A 听原始、按 B 听修复；切换时保持播放位置不变。'));

  // ---- 播放器 ----
  const playerCard = el('div', { class: 'card' });
  const audio = el('audio', { controls: '' });
  const waveCanvas = el('canvas', { height: '180' });
  const specCanvas = el('canvas', { height: '200' });
  playerCard.append(el('h2', {}, '播放与波形'), waveCanvas, el('div', { style: 'height:12px' }), audio,
    el('div', { style: 'height:14px' }), el('div', { class: 'muted', style: 'font-size:12px' }, '频谱对比（修复前后 100Hz–16kHz）'),
    el('div', { style: 'height:8px' }), specCanvas);

  // ---- 指标摘要 ----
  const infoCard = el('div', { class: 'card' });
  if (state.metrics) {
    const g = el('div', { class: 'grid-3' });
    const m = state.metrics;
    g.append(
      metric('方位角', `${m.azimuthArcmin.toFixed(2)}′`),
      metric('10k 残余', `${m.residualDbAt10k.toFixed(2)}dB`),
      metric('抖晃峰值', `${m.warpPeakPercent.toFixed(2)}%`),
    );
    infoCard.append(el('h2', {}, '修复指标摘要'), g);
  } else {
    infoCard.append(el('div', { class: 'empty' }, '尚未完成修复，仅可试听原始录音。'));
  }

  wrap.append(modeCard, playerCard, infoCard);
  mount(wrap);

  // ---- 音频 URL 管理 ----
  let origUrl = URL.createObjectURL(bundleToWavBlob(state.original));
  let restUrl: string | null = state.restored ? URL.createObjectURL(bundleToWavBlob(state.restored)) : null;
  audio.src = origUrl;

  function drawWave(bundle: AudioBundle) {
    const canvas = waveCanvas;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 900;
    canvas.width = w * dpr;
    canvas.height = 180 * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, 180);
    const data = bundle.channels[0];
    const bins = Math.min(w, 1200);
    const step = Math.floor(data.length / bins) || 1;
    ctx.strokeStyle = '#4ea1ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let b = 0; b < bins; b++) {
      let peak = 0;
      for (let i = b * step; i < Math.min(data.length, (b + 1) * step); i++) peak = Math.max(peak, Math.abs(data[i]));
      const h = peak * 80;
      const x = (b / bins) * w;
      ctx.moveTo(x, 90 - h);
      ctx.lineTo(x, 90 + h);
    }
    ctx.stroke();
  }

  function drawSpectrum() {
    const canvas = specCanvas;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 900;
    canvas.width = w * dpr;
    canvas.height = 200 * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, 200);
    // 简化周期图（512 点 FFT 的功率平均）
    const drawOne = (bundle: AudioBundle, color: string, alpha: number) => {
      const N = 1024;
      const sig = bundle.channels[0];
      const acc = new Float64Array(N / 2);
      let frames = 0;
      for (let s = 0; s + N <= sig.length && frames < 200; s += N / 2) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) { re[i] = sig[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)); }
        fft1024(re, im);
        for (let k = 0; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
        frames++;
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let k = 2; k < N / 2; k++) {
        const f = (k * bundle.sampleRate) / N;
        if (f < 80 || f > 16000) continue;
        const x = (Math.log2(f / 80) / Math.log2(16000 / 80)) * w;
        const db = 10 * Math.log10(acc[k] / frames + 1e-12);
        const y = 190 - Math.max(0, Math.min(180, db + 90));
        if (k === 2) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    drawOne(state.original!, '#f06868', 0.9);
    if (state.restored) drawOne(state.restored, '#37d0a0', 0.95);
    // 图例
    ctx.fillStyle = '#f06868'; ctx.fillText('原始', 10, 16);
    if (state.restored) { ctx.fillStyle = '#37d0a0'; ctx.fillText('修复', 60, 16); }
  }

  function setMode(mode: 'original' | 'restored') {
    if (mode === 'restored' && !state.restored) {
      toast('还没有修复结果', true);
      return;
    }
    const t = audio.currentTime;
    const playing = !audio.paused;
    audio.src = mode === 'original' ? origUrl : restUrl!;
    state.listenMode = mode;
    btnOrig.classList.toggle('active', mode === 'original');
    btnRest.classList.toggle('active', mode === 'restored');
    audio.currentTime = t;
    if (playing) void audio.play();
    drawWave(mode === 'original' ? state.original! : state.restored!);
  }

  btnOrig.addEventListener('click', () => setMode('original'));
  btnRest.addEventListener('click', () => setMode('restored'));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'a' || e.key === 'A') setMode('original');
    if (e.key === 'b' || e.key === 'B') setMode('restored');
  });

  drawWave(state.original);
  drawSpectrum();
  btnOrig.classList.add('active');
}

function metric(k: string, v: string): HTMLElement {
  const card = el('div', { class: 'metric ok' });
  card.append(el('div', { class: 'v' }, v), el('div', { class: 'k' }, k));
  return card;
}

// 内联 radix-2 FFT（仅试听页频谱用）
function fft1024(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = 2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = cr * re[b] - ci * im[b], ti = cr * im[b] + ci * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
