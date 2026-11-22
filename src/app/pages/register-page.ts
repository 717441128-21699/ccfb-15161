import { store } from '../store';
import { registerTape, importWav, loadTapes, getBlob } from '../audio-service';
import { decodeWavStream, type PcmChunk } from '../../audio/wav-codec';
import type { TapeRecord } from '../state';

export function renderRegisterPage(el: HTMLElement): void {
  el.innerHTML = `
    <h2 class="page-title">磁带登记</h2>
    <p class="page-sub">录入磁带元数据并导入数字化后的 WAV 文件，建立修复档案。</p>
    <div class="card">
      <form id="reg-form">
        <div class="form-grid">
          <div class="form-field">
            <label>磁带标题 *</label>
            <input name="title" required placeholder="例如：1987 年现场采访 A 面" />
          </div>
          <div class="form-field">
            <label>档案编号 *</label>
            <input name="catalogNo" required placeholder="例如：TAPE-2026-001" />
          </div>
          <div class="form-field">
            <label>来源</label>
            <input name="source" placeholder="例如：地方电视台资料室" />
          </div>
          <div class="form-field">
            <label>录制年份</label>
            <input name="recordedYear" type="number" min="1900" max="2100" placeholder="1987" />
          </div>
          <div class="form-field full">
            <label>备注</label>
            <textarea name="notes" placeholder="带速、内容描述、已知损伤等"></textarea>
          </div>
        </div>
        <div class="btn-row">
          <button type="submit" class="btn">登记并选择音频</button>
        </div>
      </form>
      <div id="drop" class="dropzone" style="margin-top:18px; display:none;">
        拖放 WAV 文件到此处，或 <strong>点击选择</strong>
        <input id="file" type="file" accept=".wav,audio/wav" style="display:none" />
      </div>
    </div>
    <div class="card">
      <h2>已登记磁带</h2>
      <div id="tape-list"><div class="empty">加载中…</div></div>
    </div>
  `;

  let draftRecord: TapeRecord | null = null;
  const form = el.querySelector<HTMLFormElement>('#reg-form')!;
  const drop = el.querySelector<HTMLElement>('#drop')!;
  const fileInput = el.querySelector<HTMLInputElement>('#file')!;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    draftRecord = await registerTape({
      title: String(fd.get('title') ?? ''),
      catalogNo: String(fd.get('catalogNo') ?? ''),
      source: String(fd.get('source') ?? ''),
      recordedYear: fd.get('recordedYear') ? Number(fd.get('recordedYear')) : undefined,
      notes: String(fd.get('notes') ?? ''),
    });
    drop.style.display = 'block';
    toast('档案已登记，请导入 WAV 音频');
    refreshList();
  };

  drop.onclick = () => fileInput.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
  drop.ondragleave = () => drop.classList.remove('drag');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  };
  fileInput.onchange = () => {
    const f = fileInput.files?.[0];
    if (f) handleFile(f);
  };

  async function handleFile(file: File) {
    if (!draftRecord) { toast('请先填写并提交登记信息', 'error'); return; }
    try {
      toast('正在解码 WAV…');
      const { channels, sampleRate, durationSec } = await importWav(file, draftRecord);
      const record = { ...draftRecord, sampleRate, durationSec };
      store.setState({
        active: { record, channels, sampleRate, spec: { ...store.getState().active?.spec ?? specOf(sampleRate) } },
        page: 'process',
      });
      toast(`导入成功：${(durationSec / 60).toFixed(1)} 分钟`, 'success');
    } catch (err) {
      toast(`导入失败：${(err as Error).message}`, 'error');
    }
  }

  async function refreshList() {
    const tapes = await loadTapes();
    const list = el.querySelector('#tape-list')!;
    if (tapes.length === 0) {
      list.innerHTML = '<div class="empty">尚未登记任何磁带</div>';
      return;
    }
    const table = document.createElement('table');
    table.innerHTML = `<thead><tr>
      <th>标题</th><th>编号</th><th>来源</th><th>年份</th><th>状态</th><th>时长</th><th></th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const t of tapes) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(t.title)}</td>
        <td class="mono">${escapeHtml(t.catalogNo)}</td>
        <td>${escapeHtml(t.source || '—')}</td>
        <td>${t.recordedYear ?? '—'}</td>
        <td><span class="status-pill status-${t.status}">${statusLabel(t.status)}</span></td>
        <td>${t.durationSec ? `${(t.durationSec / 60).toFixed(1)} 分` : '—'}</td>
        <td></td>`;
      const actionTd = tr.lastElementChild as HTMLElement;
      if (t.originalBlobId) {
        const btn = document.createElement('button');
        btn.className = 'btn secondary';
        btn.textContent = '处理';
        btn.onclick = () => reopenForProcessing(t);
        actionTd.appendChild(btn);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    list.innerHTML = '';
    list.appendChild(table);
  }

  async function reopenForProcessing(record: TapeRecord) {
    try {
      const blob = await getBlob(record.originalBlobId!);
      if (!blob) throw new Error('原始音频不存在');
      const chunks: PcmChunk[] = [];
      await decodeWavStream(blob, (c) => { chunks.push(c); });
      const total = chunks.reduce((s, c) => s + c.channels[0].length, 0);
      const L = new Float32Array(total), R = new Float32Array(total);
      let off = 0;
      for (const c of chunks) { L.set(c.channels[0], off); R.set(c.channels[1], off); off += c.channels[0].length; }
      store.setState({
        active: { record, channels: [L, R], sampleRate: record.sampleRate!, spec: specOf(record.sampleRate!) },
        page: 'process',
      });
    } catch (err) {
      toast(`无法打开：${(err as Error).message}`, 'error');
    }
  }

  refreshList();
}

function specOf(sampleRate: number) {
  // 复用默认物理规格，采样率按实际文件覆盖
  return { ...{ trackSpacingM: 1.78e-3, tapeSpeed: 0.1905, sampleRate, refToneHz: 1000, refChannel: 0, humHz: 50 } };
}

function statusLabel(s: TapeRecord['status']): string {
  return { registered: '已登记', processing: '处理中', processed: '已修复', archived: '已归档' }[s];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'info' ? '' : kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
