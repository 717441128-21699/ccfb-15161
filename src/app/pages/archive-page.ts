import { loadTapes, removeTape, getBlob, refreshStorageUsage } from '../audio-service';
import { putTape } from '../../storage/idb';
import { toast } from './register-page';
import type { TapeRecord } from '../state';

export function renderArchivePage(el: HTMLElement): void {
  el.innerHTML = `
    <h2 class="page-title">归档</h2>
    <p class="page-sub">管理已修复磁带档案，下载 WAV，查看存储占用。</p>
    <div class="card">
      <div id="storage" class="muted">存储占用计算中…</div>
    </div>
    <div class="card">
      <h2>磁带档案</h2>
      <div id="list"><div class="empty">加载中…</div></div>
    </div>
  `;

  refresh();

  async function refresh() {
    const [tapes, { usage, quota }] = await Promise.all([loadTapes(), refreshStorageUsage()]);
    el.querySelector('#storage')!.innerHTML = quota > 0
      ? `已用 <strong>${formatBytes(usage)}</strong> / 配额 ${formatBytes(quota)}（${((usage / quota) * 100).toFixed(1)}%）`
      : `已用 <strong>${formatBytes(usage)}</strong>`;

    const list = el.querySelector('#list')!;
    if (tapes.length === 0) {
      list.innerHTML = '<div class="empty">档案库为空</div>';
      return;
    }
    const table = document.createElement('table');
    table.innerHTML = `<thead><tr>
      <th>标题</th><th>编号</th><th>状态</th><th>方位角</th><th>10k 残差</th>
      <th>时长</th><th>操作</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const t of tapes) {
      const tr = document.createElement('tr');
      const eqWorst = t.report ? Math.max(...t.report.eqResidual10kDb.map(v => Math.abs(v))) : null;
      tr.innerHTML = `
        <td>${escapeHtml(t.title)}</td>
        <td class="mono">${escapeHtml(t.catalogNo)}</td>
        <td><span class="status-pill status-${t.status}">${statusLabel(t.status)}</span></td>
        <td>${t.report ? `${t.report.azimuthArcmin.toFixed(1)} 角分` : '—'}</td>
        <td>${eqWorst !== null ? `${eqWorst.toFixed(2)} dB` : '—'}</td>
        <td>${t.durationSec ? `${(t.durationSec / 60).toFixed(1)} 分` : '—'}</td>
        <td></td>`;
      const actionTd = tr.lastElementChild as HTMLElement;
      const btnRow = document.createElement('div');
      btnRow.style.display = 'flex';
      btnRow.style.gap = '6px';

      if (t.restoredBlobId) {
        const archiveBtn = document.createElement('button');
        archiveBtn.className = 'btn secondary';
        archiveBtn.textContent = t.status === 'archived' ? '取消归档' : '归档';
        archiveBtn.onclick = () => toggleArchive(t, refresh);
        btnRow.appendChild(archiveBtn);

        const dlBtn = document.createElement('button');
        dlBtn.className = 'btn secondary';
        dlBtn.textContent = '下载修复 WAV';
        dlBtn.onclick = () => download(t);
        btnRow.appendChild(dlBtn);
      }
      const delBtn = document.createElement('button');
      delBtn.className = 'btn danger';
      delBtn.textContent = '删除';
      delBtn.onclick = () => remove(t, refresh);
      btnRow.appendChild(delBtn);

      actionTd.appendChild(btnRow);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    list.innerHTML = '';
    list.appendChild(table);
  }
}

async function toggleArchive(t: TapeRecord, refresh: () => void): Promise<void> {
  const next = { ...t, status: (t.status === 'archived' ? 'processed' : 'archived') as TapeRecord['status'] };
  await putTape(next);
  toast(next.status === 'archived' ? '已归档' : '已取消归档', 'success');
  refresh();
}

async function download(t: TapeRecord): Promise<void> {
  try {
    const blob = await getBlob(t.restoredBlobId!);
    if (!blob) throw new Error('修复后的音频不存在');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t.catalogNo}_restored.wav`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast(`下载失败：${(err as Error).message}`, 'error');
  }
}

async function remove(t: TapeRecord, refresh: () => void): Promise<void> {
  if (!confirm(`确定删除「${t.title}」及其全部音频？此操作不可撤销。`)) return;
  await removeTape(t.id);
  toast('已删除', 'success');
  refresh();
}

function statusLabel(s: TapeRecord['status']): string {
  return { registered: '已登记', processing: '处理中', processed: '已修复', archived: '已归档' }[s];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
