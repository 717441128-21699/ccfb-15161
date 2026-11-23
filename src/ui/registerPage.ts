import { el, toast, fmtDuration } from './widgets';
import { db, newId, type TapeRecord } from '../db';
import { state, DEFAULT_PARAMS, type AudioBundle } from './state';
import { decodeWav, deinterleave } from '../dsp/wav';
import {
  synthesizeTape,
  WARP_PRESETS,
  AZIMUTH_PRESETS,
  type WarpSpec,
  type AzimuthSpec,
} from '../dsp/synthesis';

export function registerPage(mount: (n: HTMLElement) => void): void {
  const wrap = el('div');
  wrap.append(
    el('h2', { class: 'page-title' }, '磁带登记'),
    el('p', { class: 'page-desc' }, '登记磁带元数据并导入数字化音频；也可按指定抖晃与方位偏差合成测试带，用于验证修复指标。'),
  );

  // ---- 登记表单 ----
  const form = el('div', { class: 'card' });
  form.append(el('h2', {}, '1. 磁带信息'));
  const titleInput = el('input', { placeholder: '如：1985年农村改革采访（第三盘）' });
  const catalogInput = el('input', { placeholder: '如：CAT-1985-003', value: `CAT-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 900) + 100)}` });
  const sourceInput = el('input', { placeholder: '采访对象 / 栏目' });
  const yearInput = el('input', { type: 'number', value: '1985' });
  const notesInput = el('textarea', { rows: '3', placeholder: '备注：带基状况、霉变、断带记录等' });
  const grid = el('div', { class: 'grid-2' });
  grid.append(
    field('磁带标题', titleInput),
    field('馆藏编号', catalogInput),
    field('采访来源', sourceInput),
    field('录制年份', yearInput),
  );
  form.append(grid, field('备注', notesInput));

  // ---- 音频导入 ----
  const importCard = el('div', { class: 'card' });
  importCard.append(el('h2', {}, '2. 导入数字化音频（WAV）'));
  const fileInput = el('input', { type: 'file', accept: '.wav,audio/wav' });
  const importInfo = el('div', { class: 'muted' }, '未选择文件');
  importCard.append(fileInput, el('div', { style: 'height:10px' }), importInfo);

  let imported: AudioBundle | undefined;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const decoded = await decodeWav(file);
      const planar = deinterleave(decoded.interleaved, decoded.channels);
      const channels = decoded.channels >= 2
        ? [planar[0], planar[1]]
        : [planar[0], planar[0].slice()];
      imported = { sampleRate: decoded.sampleRate, channels };
      importInfo.textContent = `已加载 ${file.name}：${decoded.sampleRate}Hz，${decoded.channels} 声道，${fmtDuration(decoded.frames / decoded.sampleRate)}`;
      toast('音频导入成功');
    } catch (err) {
      toast(`导入失败：${(err as Error).message}`, true);
    }
  });

  // ---- 测试带合成 ----
  const synthCard = el('div', { class: 'card' });
  synthCard.append(el('h2', {}, '3. 或合成测试带（按抖晃 / 方位偏差场景）'));
  let chosenWarp: WarpSpec = WARP_PRESETS.moderate;
  let chosenAz: AzimuthSpec = AZIMUTH_PRESETS.offset;
  const warpGrid = el('div', { class: 'preset-grid' });
  const azGrid = el('div', { class: 'preset-grid' });
  const synthInfo = el('div', { class: 'muted' }, '选择场景后点击合成（默认 20 秒，48kHz 立体声）。');

  const warpBtns = Object.entries(WARP_PRESETS).map(([key, spec]) => {
    const b = el('button', { type: 'button' },
      el('div', { class: 'pn' }, warpLabel(key)),
      el('div', { class: 'pd' }, `wow ±${(spec.wowDepth * 100).toFixed(1)}% / flutter ±${(spec.flutterDepth * 100).toFixed(1)}%`));
    if (key === 'moderate') b.classList.add('active');
    b.addEventListener('click', () => {
      chosenWarp = spec;
      warpBtns.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    });
    return b;
  });
  warpGrid.append(...warpBtns);

  const azBtns = Object.entries(AZIMUTH_PRESETS).map(([key, spec]) => {
    const b = el('button', { type: 'button' },
      el('div', { class: 'pn' }, azLabel(key)),
      el('div', { class: 'pd' }, `方位 ${spec.arcmin}′ / 10k 损耗 ${spec.lossDbAt10k}dB`));
    if (key === 'offset') b.classList.add('active');
    b.addEventListener('click', () => {
      chosenAz = spec;
      azBtns.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    });
    return b;
  });
  azGrid.append(...azBtns);

  const durationInput = el('input', { type: 'number', value: '20', min: '4', max: '600' });
  const synthBtn = el('button', { class: 'btn' }, '合成测试带');
  synthCard.append(
    el('div', { class: 'muted', style: 'margin-bottom:6px;font-size:12px' }, '抖晃场景'),
    warpGrid,
    el('div', { style: 'height:14px' }),
    el('div', { class: 'muted', style: 'margin-bottom:6px;font-size:12px' }, '方位角 / 高频损耗场景'),
    azGrid,
    el('div', { style: 'height:14px' }),
    field('时长（秒）', durationInput),
    synthBtn,
    el('div', { style: 'height:8px' }),
    synthInfo,
  );

  synthBtn.addEventListener('click', () => {
    const dur = Math.max(4, Number(durationInput.value) || 20);
    synthBtn.disabled = true;
    synthBtn.textContent = '合成中…';
    // 让出主线程一帧再做重计算
    setTimeout(() => {
      try {
        const tape = synthesizeTape({
          sampleRate: 48000,
          durationSeconds: dur,
          warp: chosenWarp,
          azimuth: chosenAz,
          hum: { baseHz: 50, level: 0.01, harmonics: [1, 2, 3] },
          referenceToneHz: 1000,
          referenceLevel: 0.18,
          noiseLevel: 0.004,
          seed: (Date.now() & 0xffffffff) >>> 0,
        });
        imported = {
          sampleRate: 48000,
          channels: [tape.degraded.left, tape.degraded.right],
        };
        importInfo.textContent = `已合成测试带：${dur}s，48kHz 立体声（含 1kHz 参考音、50Hz 哼声、本底噪声）`;
        synthInfo.textContent = `合成完成。真实方位 ${chosenAz.arcmin}′，真实 10k 损耗 ${chosenAz.lossDbAt10k}dB。`;
        toast('测试带合成完成');
      } catch (err) {
        toast(`合成失败：${(err as Error).message}`, true);
      } finally {
        synthBtn.disabled = false;
        synthBtn.textContent = '合成测试带';
      }
    }, 30);
  });

  // ---- 登记入库 ----
  const saveBtn = el('button', { class: 'btn' }, '登记并进入处理');
  const listCard = el('div', { class: 'card' });
  listCard.append(el('h2', {}, '已登记磁带'));
  const listBody = el('div');
  listCard.append(listBody);

  async function refreshList() {
    const tapes = await db.getAll<TapeRecord>('tapes');
    tapes.sort((a, b) => b.createdAt - a.createdAt);
    if (!tapes.length) {
      listBody.replaceChildren(el('div', { class: 'empty' }, '暂无登记记录'));
      return;
    }
    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', {}, '编号'), el('th', {}, '标题'), el('th', {}, '来源'),
      el('th', {}, '年份'), el('th', {}, '时长'), el('th', {}, ''))));
    const tb = el('tbody');
    for (const t of tapes) {
      const useBtn = el('button', { class: 'btn secondary', style: 'padding:5px 12px' }, '选用');
      useBtn.addEventListener('click', async () => {
        state.tape = t;
        state.original = imported;
        state.params = { ...DEFAULT_PARAMS };
        toast(`已选用「${t.title}」`);
      });
      const delBtn = el('button', { class: 'btn danger', style: 'padding:5px 12px' }, '删除');
      delBtn.addEventListener('click', async () => {
        await db.delete('tapes', t.id);
        refreshList();
      });
      tb.append(el('tr', {},
        el('td', { class: 'mono' }, t.catalogNo),
        el('td', {}, t.title),
        el('td', {}, t.source || '—'),
        el('td', {}, String(t.recordedYear)),
        el('td', {}, fmtDuration(t.durationSeconds)),
        el('td', {}, el('div', { class: 'row' }, useBtn, delBtn))));
    }
    table.append(tb);
    listBody.replaceChildren(table);
  }
  refreshList();

  saveBtn.addEventListener('click', async () => {
    if (!imported) {
      toast('请先导入 WAV 或合成测试带', true);
      return;
    }
    if (!titleInput.value.trim()) {
      toast('请填写磁带标题', true);
      return;
    }
    const record: TapeRecord = {
      id: newId('tape'),
      title: titleInput.value.trim(),
      catalogNo: catalogInput.value.trim(),
      source: sourceInput.value.trim(),
      recordedYear: Number(yearInput.value) || 1985,
      durationSeconds: imported.channels[0].length / imported.sampleRate,
      sampleRate: imported.sampleRate,
      notes: notesInput.value.trim(),
      createdAt: Date.now(),
      tags: [],
    };
    await db.put('tapes', record);
    state.tape = record;
    state.original = imported;
    state.restored = undefined;
    state.job = undefined;
    state.metrics = undefined;
    state.params = { ...DEFAULT_PARAMS };
    toast('登记成功，跳转处理页');
    location.hash = '#/process';
    refreshList();
  });

  form.append(el('div', { style: 'height:6px' }), saveBtn);
  wrap.append(form, importCard, synthCard, listCard);
  mount(wrap);
}

function field(label: string, input: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, el('span', { class: 'lbl' }, label), input);
}

function warpLabel(key: string): string {
  return { mild: '轻度抖晃', moderate: '中度抖晃', severe: '重度抖晃' }[key] ?? key;
}
function azLabel(key: string): string {
  return { aligned: '已对齐', slight: '轻微偏移', offset: '明显偏移', severe: '严重偏移' }[key] ?? key;
}
