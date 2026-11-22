import { store } from '../store';
import { toast } from './register-page';
import { encodeWav16 } from '../../audio/wav-codec';

export function renderListenPage(el: HTMLElement): void {
  const state = store.getState();
  if (!state.active || !state.active.restored) {
    el.innerHTML = `<div class="empty">尚无修复结果。请先在「修复处理」页完成修复。</div>`;
    return;
  }
  const { restored, channels, sampleRate, record } = state.active;

  el.innerHTML = `
    <h2 class="page-title">试听对比</h2>
    <p class="page-sub">磁带：${escapeHtml(record.title)} — 在原始与修复后音频之间来回切换，听感对比修复效果。</p>
    <div class="card">
      <div class="ab-bar">
        <div class="toggle" id="ab-toggle">
          <button data-orig="1" class="${state.compareOriginal ? 'active' : ''}">原始</button>
          <button data-orig="0" class="${!state.compareOriginal ? 'active' : ''}">修复后</button>
        </div>
        <span class="muted" id="which">当前：原始音频</span>
      </div>
      <audio id="player" controls></audio>
    </div>
  `;

  const toggle = el.querySelector<HTMLElement>('#ab-toggle')!;
  const which = el.querySelector<HTMLElement>('#which')!;
  const player = el.querySelector<HTMLAudioElement>('#player')!;

  // 预生成两份 WAV 的 ObjectURL（内存中，不写库）
  const makeUrl = (ch: [Float32Array, Float32Array]) => {
    const n = Math.min(ch[0].length, ch[1].length);
    const inter = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { inter[2 * i] = ch[0][i]; inter[2 * i + 1] = ch[1][i]; }
    return URL.createObjectURL(encodeWav16(inter, sampleRate, 2));
  };
  const origUrl = makeUrl(channels);
  const fixedUrl = makeUrl(restored);
  let currentUrl = state.compareOriginal ? origUrl : fixedUrl;
  player.src = currentUrl;

  toggle.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      const wantOriginal = btn.dataset.orig === '1';
      const wasPlaying = !player.paused;
      const pos = player.currentTime;
      // 释放旧 URL 引用（切换时）
      currentUrl = wantOriginal ? origUrl : fixedUrl;
      player.src = currentUrl;
      toggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      which.textContent = `当前：${wantOriginal ? '原始音频' : '修复后音频'}`;
      store.setState({ compareOriginal: wantOriginal });
      player.currentTime = pos;
      if (wasPlaying) player.play().catch(() => undefined);
    };
  });

  // 页面卸载时回收 ObjectURL
  window.addEventListener('beforeunload', () => {
    URL.revokeObjectURL(origUrl);
    URL.revokeObjectURL(fixedUrl);
  });

  toast('提示：修复后音频的高频应更明亮、抖晃导致的音高漂移应消失', 'info');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
