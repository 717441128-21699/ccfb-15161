import { el, toast, fmtDuration, fmtTime, downloadBlob } from './widgets';
import { db, newId, type ArchiveRecord, type TapeRecord, type JobRecord } from '../db';
import { state, bundleToWavBlob } from './state';

export function archivePage(mount: (n: HTMLElement) => void): void {
  const wrap = el('div');
  wrap.append(
    el('h2', { class: 'page-title' }, '归档'),
    el('p', { class: 'page-desc' }, '将原始与修复音频以 16-bit PCM WAV 归档到浏览器本地数据库，并支持导出下载。'),
  );

  const createCard = el('div', { class: 'card' });
  createCard.append(el('h2', {}, '创建归档'));
  if (!state.tape) {
    createCard.append(el('div', { class: 'empty' }, '请先在登记页选择磁带。'));
  } else if (!state.restored || !state.original) {
    createCard.append(el('div', { class: 'empty' }, '请先在处理页完成修复。'));
  } else {
    const notes = el('textarea', { rows: '2', placeholder: '归档备注（可选）' });
    const saveBtn = el('button', { class: 'btn' }, '归档当前修复结果');
    createCard.append(
      el('div', { class: 'muted', style: 'margin-bottom:10px' },
        `磁带：${state.tape.title}（${state.tape.catalogNo}），时长 ${fmtDuration(state.tape.durationSeconds)}`),
      notes, el('div', { style: 'height:10px' }), saveBtn,
    );
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        const origBlob = bundleToWavBlob(state.original!);
        const restBlob = bundleToWavBlob(state.restored!);
        const origId = newId('wav');
        const restId = newId('wav');
        await db.putBlob(origId, origBlob);
        await db.putBlob(restId, restBlob);
        const record: ArchiveRecord = {
          id: newId('arc'),
          tapeId: state.tape!.id,
          jobId: state.job?.id ?? '',
          archivedAt: Date.now(),
          originalWavId: origId,
          restoredWavId: restId,
          metrics: state.metrics!,
          notes: notes.value.trim(),
        };
        await db.put('archives', record);
        toast('归档成功');
        refresh();
      } catch (err) {
        toast(`归档失败：${(err as Error).message}`, true);
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  const listCard = el('div', { class: 'card' });
  listCard.append(el('h2', {}, '归档记录'));
  const body = el('div');
  listCard.append(body);

  wrap.append(createCard, listCard);
  mount(wrap);
  refresh();

  async function refresh() {
    const [archives, tapes, jobs] = await Promise.all([
      db.getAll<ArchiveRecord>('archives'),
      db.getAll<TapeRecord>('tapes'),
      db.getAll<JobRecord>('jobs'),
    ]);
    archives.sort((a, b) => b.archivedAt - a.archivedAt);
    if (!archives.length) {
      body.replaceChildren(el('div', { class: 'empty' }, '暂无归档记录'));
      return;
    }
    const tapeMap = new Map(tapes.map((t) => [t.id, t]));
    const jobMap = new Map(jobs.map((j) => [j.id, j]));
    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', {}, '归档时间'), el('th', {}, '磁带'), el('th', {}, '方位角'),
      el('th', {}, '10k 残余'), el('th', {}, '备注'), el('th', {}, '操作'))));
    const tb = el('tbody');
    for (const a of archives) {
      const tape = tapeMap.get(a.tapeId);
      void jobMap.get(a.jobId);
      const dlOrig = el('button', { class: 'btn secondary', style: 'padding:5px 10px' }, '原始 WAV');
      const dlRest = el('button', { class: 'btn', style: 'padding:5px 10px' }, '修复 WAV');
      const del = el('button', { class: 'btn danger', style: 'padding:5px 10px' }, '删除');
      dlOrig.addEventListener('click', async () => {
        const blob = await db.getBlob(a.originalWavId);
        if (blob) downloadBlob(blob, `${tape?.catalogNo ?? 'tape'}_original.wav`);
      });
      dlRest.addEventListener('click', async () => {
        const blob = await db.getBlob(a.restoredWavId);
        if (blob) downloadBlob(blob, `${tape?.catalogNo ?? 'tape'}_restored.wav`);
      });
      del.addEventListener('click', async () => {
        await db.delete('archives', a.id);
        await db.deleteBlob(a.originalWavId);
        await db.deleteBlob(a.restoredWavId);
        toast('已删除归档');
        refresh();
      });
      tb.append(el('tr', {},
        el('td', {}, fmtTime(a.archivedAt)),
        el('td', {}, tape ? `${tape.title}` : '（已删除磁带）'),
        el('td', { class: 'mono' }, `${a.metrics.azimuthArcmin.toFixed(2)}′`),
        el('td', { class: 'mono' }, `${a.metrics.residualDbAt10k.toFixed(2)}dB`),
        el('td', { class: 'muted' }, a.notes || '—'),
        el('td', {}, el('div', { class: 'row' }, dlOrig, dlRest, del))));
    }
    table.append(tb);
    body.replaceChildren(table);
  }
}
