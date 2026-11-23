// 页面路由与四个页面:磁带登记 / 修复处理 / 试听对比 / 归档导出
import { session, registry, archive, uid } from './store.js';
import { decodeWav, encodeWav } from '../dsp/wav.js';
import { firResponseDb } from '../dsp/hfeq.js';
const app = document.getElementById('app');
const WORKLET_URL = './dist/src/worklet/restore-worklet.js';
const WORKER_URL = './dist/src/ui/pipeline-worker.js';
// ---------- 通用 ----------
function esc(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}
function drawCurve(canvas, xs, ys, opts) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#101418';
    ctx.fillRect(0, 0, W, H);
    let yMin = opts.yMin ?? Math.min(...ys);
    let yMax = opts.yMax ?? Math.max(...ys);
    if (yMax - yMin < 1e-9) {
        yMax += 1;
        yMin -= 1;
    }
    const pad = 8;
    // 零线
    if (yMin < 0 && yMax > 0) {
        const y0 = H - pad - ((0 - yMin) / (yMax - yMin)) * (H - 2 * pad);
        ctx.strokeStyle = '#3a4550';
        ctx.beginPath();
        ctx.moveTo(0, y0);
        ctx.lineTo(W, y0);
        ctx.stroke();
    }
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < xs.length; i++) {
        const x = (xs[i] / xs[xs.length - 1]) * W;
        const y = H - pad - ((ys[i] - yMin) / (yMax - yMin)) * (H - 2 * pad);
        if (i === 0)
            ctx.moveTo(x, y);
        else
            ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#9fb2c8';
    ctx.font = '11px sans-serif';
    ctx.fillText(`${opts.yLabel}  [${yMin.toFixed(2)} .. ${yMax.toFixed(2)}]`, 8, 14);
}
function tapeSelector(selectedId) {
    const tapes = registry.list();
    if (tapes.length === 0)
        return '<p class="hint">还没有登记磁带,请先到「磁带登记」页登记。</p>';
    const opts = tapes.map((t) => `<option value="${t.id}" ${t.id === selectedId ? 'selected' : ''}>${esc(t.title)}(${esc(t.era)})</option>`).join('');
    return `<label>选择磁带:<select id="tapeSel"><option value="">—</option>${opts}</select></label>`;
}
// ---------- 页 1:磁带登记 ----------
function renderRegister() {
    const tapes = registry.list();
    app.innerHTML = `
    <h2>磁带登记</h2>
    <form id="regForm" class="card form">
      <div class="row"><label>磁带编号*<input name="title" required></label>
      <label>年代<input name="era" value="1980s"></label></div>
      <div class="row"><label>类型
        <select name="tapeType"><option>盒式磁带</option><option>开盘磁带</option><option>其他</option></select></label>
      <label>带速
        <select name="speed"><option>4.76 cm/s</option><option>9.5 cm/s</option><option>19 cm/s</option><option>38 cm/s</option></select></label></div>
      <div class="row"><label>品牌/型号<input name="brand"></label>
      <label>数字化人<input name="operator"></label></div>
      <label>内容描述<textarea name="content" rows="2"></textarea></label>
      <label>备注<textarea name="note" rows="2"></textarea></label>
      <button type="submit">登记</button>
    </form>
    <h3>已登记(${tapes.length})</h3>
    <table class="tbl"><thead><tr><th>编号</th><th>年代</th><th>类型</th><th>带速</th><th>内容</th><th></th></tr></thead>
    <tbody>${tapes.map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(t.era)}</td><td>${esc(t.tapeType)}</td><td>${esc(t.speed)}</td><td>${esc(t.content)}</td>
      <td><button data-del="${t.id}" class="link">删除</button></td></tr>`).join('')}</tbody></table>`;
    document.getElementById('regForm').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const fd = new FormData(ev.target);
        const rec = {
            id: uid(),
            title: String(fd.get('title') ?? ''),
            era: String(fd.get('era') ?? ''),
            tapeType: String(fd.get('tapeType') ?? ''),
            speed: String(fd.get('speed') ?? ''),
            brand: String(fd.get('brand') ?? ''),
            content: String(fd.get('content') ?? ''),
            operator: String(fd.get('operator') ?? ''),
            note: String(fd.get('note') ?? ''),
            createdAt: new Date().toISOString(),
        };
        registry.add(rec);
        renderRegister();
    });
    app.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
        registry.remove(b.dataset.del);
        renderRegister();
    }));
}
// ---------- 页 2:修复处理 ----------
let worker = null;
async function decodeFile(file) {
    const buf = await file.arrayBuffer();
    // 先走浏览器解码(支持 mp3/flac/wav 等),失败再用内置 WAV 解码
    try {
        const AC = window.AudioContext ?? window.webkitAudioContext;
        const ctx = new AC();
        const ab = await ctx.decodeAudioData(buf.slice(0));
        void ctx.close();
        const L = ab.getChannelData(0).slice();
        const R = ab.numberOfChannels > 1 ? ab.getChannelData(1).slice() : L.slice();
        return { L, R, fs: ab.sampleRate };
    }
    catch {
        const wav = decodeWav(new Uint8Array(buf));
        const L = wav.channels[0];
        const R = wav.channels.length > 1 ? wav.channels[1] : wav.channels[0];
        return { L, R, fs: wav.sampleRate };
    }
}
function renderProcess() {
    const tape = session.tapeId ? registry.get(session.tapeId) : undefined;
    app.innerHTML = `
    <h2>修复处理</h2>
    <div class="card">
      ${tapeSelector(session.tapeId)}
      ${tape ? `<span class="hint">已选:${esc(tape.title)} / ${esc(tape.speed)}</span>` : ''}
      <div style="margin-top:10px"><input type="file" id="fileIn" accept="audio/*,.wav"></div>
      <div id="fileInfo" class="hint">${session.fileName ? `已加载:${esc(session.fileName)}` : ''}</div>
      <button id="runBtn" ${session.origL ? '' : 'disabled'}>开始修复</button>
      <div id="prog" class="prog" hidden><div id="progBar"></div></div>
      <div id="progText" class="hint"></div>
    </div>
    <div id="resultArea">${session.result ? resultHtml(session.result) : ''}</div>`;
    document.getElementById('tapeSel')?.addEventListener('change', (ev) => {
        session.tapeId = ev.target.value || null;
        renderProcess();
    });
    document.getElementById('fileIn').addEventListener('change', async (ev) => {
        const f = ev.target.files?.[0];
        if (!f)
            return;
        const info = document.getElementById('fileInfo');
        info.textContent = '解码中…';
        try {
            const { L, R, fs } = await decodeFile(f);
            session.origL = L;
            session.origR = R;
            session.sampleRate = fs;
            session.fileName = f.name;
            session.result = null;
            info.textContent = `已加载:${f.name} — ${fmtTime(L.length / fs)},${fs} Hz,${(L.length / 1e6).toFixed(1)}M 样本/声道`;
            document.getElementById('runBtn').disabled = false;
        }
        catch (err) {
            info.textContent = `解码失败:${err}`;
        }
    });
    document.getElementById('runBtn').addEventListener('click', () => {
        if (!session.origL || !session.origR)
            return;
        const prog = document.getElementById('prog');
        const bar = document.getElementById('progBar');
        const text = document.getElementById('progText');
        prog.hidden = false;
        document.getElementById('runBtn').disabled = true;
        worker?.terminate();
        worker = new Worker(WORKER_URL, { type: 'module' });
        // 拷贝一份给 worker(原 buffer 还要留着试听)
        const L = session.origL.slice();
        const R = session.origR.slice();
        worker.onmessage = (ev) => {
            const m = ev.data;
            if (m.type === 'progress') {
                bar.style.width = `${(m.frac * 100).toFixed(0)}%`;
                text.textContent = m.stage;
            }
            else if (m.type === 'done') {
                session.result = m.result;
                text.textContent = `完成,用时 ${(session.result.timings.total / 1000).toFixed(1)}s`;
                document.getElementById('resultArea').innerHTML = resultHtml(session.result);
                bindResultPlots(session.result);
                document.getElementById('runBtn').disabled = false;
            }
            else if (m.type === 'error') {
                text.textContent = `处理失败:${m.message}`;
                document.getElementById('runBtn').disabled = false;
            }
        };
        worker.postMessage({ L, R, fs: session.sampleRate }, [L.buffer, R.buffer]);
    });
    if (session.result)
        bindResultPlots(session.result);
}
function resultHtml(r) {
    const az = r.azimuth;
    return `
    <div class="card">
      <h3>处理结果</h3>
      <table class="kv">
        <tr><td>参考音</td><td>${r.reference.type === 'tone' ? '对位音' : r.reference.type === 'hum' ? '交流哼声' : '无'}
          ${r.reference.primary.toFixed(2)} Hz${r.reference.humFreq ? `(哼声 ${r.reference.humFreq.toFixed(2)} Hz)` : ''}</td></tr>
        <tr><td>方位角偏差</td><td>${az.angleArcmin.toFixed(2)} 角分(声道时差 ${(az.dtSeconds * 1e6).toFixed(1)} µs)</td></tr>
        <tr><td>10kHz 损耗 / 补偿后残差</td><td>${r.eq.lossDbAt10k.toFixed(2)} dB / ${r.eq.residualDbAt10k.toFixed(2)} dB</td></tr>
        <tr><td>残余抖晃</td><td>${(r.residualWowFlutter * 100).toFixed(3)} %</td></tr>
        <tr><td>各阶段耗时</td><td>${Object.entries(r.timings).map(([k, v]) => `${k}: ${(v / 1000).toFixed(1)}s`).join(',')}</td></tr>
      </table>
      <h4>速度偏差曲线 ε(t)</h4>
      <canvas id="devPlot" width="860" height="180"></canvas>
      <h4>高频补偿滤波器响应</h4>
      <canvas id="eqPlot" width="860" height="180"></canvas>
      <p class="hint">到「试听对比」页切换原始/修复试听;到「归档」页导出结果。</p>
    </div>`;
}
function bindResultPlots(r) {
    const devCv = document.getElementById('devPlot');
    if (devCv) {
        const n = r.deviation.eps.length;
        const xs = [], ys = [];
        const step = Math.max(1, Math.floor(n / 800));
        for (let i = 0; i < n; i += step) {
            xs.push((i * r.deviation.hop) / r.sampleRate);
            ys.push(r.deviation.eps[i] * 100);
        }
        drawCurve(devCv, xs, ys, { yLabel: '速度偏差 %', color: '#4fc3f7' });
    }
    const eqCv = document.getElementById('eqPlot');
    if (eqCv) {
        const xs = [], ys = [];
        for (let f = 100; f <= 20000; f *= 1.06) {
            xs.push(Math.log10(f));
            ys.push(firResponseDb(r.eq.taps, f, r.sampleRate));
        }
        drawCurve(eqCv, xs, ys, { yLabel: 'EQ 响应 dB(log 频率 100Hz-20kHz)', color: '#ffb74d' });
    }
}
// ---------- 页 3:试听对比 ----------
let audioCtx = null;
let workletNode = null;
let sourceNode = null;
let playStartedAt = 0;
let playTimer = 0;
let restoredMode = false;
function renderListen() {
    const ready = session.origL && session.result;
    app.innerHTML = `
    <h2>试听对比</h2>
    ${!ready ? '<p class="hint">请先在「修复处理」页加载音频并完成修复。</p>' : ''}
    <div class="card" ${!ready ? 'hidden' : ''}>
      <div class="ab">
        <button id="abOrig" class="abBtn ${restoredMode ? '' : 'on'}">原始</button>
        <button id="abRest" class="abBtn ${restoredMode ? 'on' : ''}">修复</button>
      </div>
      <div class="row">
        <button id="playBtn">▶ 播放</button>
        <label class="hint"><input type="checkbox" id="liveMode"> 实时跟踪模式(Worklet 内现场测抖晃,不用离线曲线)</label>
      </div>
      <div id="playPos" class="hint">--:--</div>
      <p class="hint">信号流:原始文件 → AudioWorklet(抖晃校正重采样 + 高频补偿 FIR)→ 输出。「原始」即 Worklet 旁通。</p>
    </div>`;
    if (!ready)
        return;
    const setMode = (rest) => {
        restoredMode = rest;
        document.getElementById('abOrig').classList.toggle('on', !rest);
        document.getElementById('abRest').classList.toggle('on', rest);
        workletNode?.port.postMessage({ type: 'bypass', value: !rest });
    };
    document.getElementById('abOrig').addEventListener('click', () => setMode(false));
    document.getElementById('abRest').addEventListener('click', () => setMode(true));
    document.getElementById('playBtn').addEventListener('click', async () => {
        if (sourceNode) {
            stopPlayback();
            return;
        }
        const r = session.result;
        if (!audioCtx) {
            audioCtx = new AudioContext({ sampleRate: session.sampleRate });
            await audioCtx.audioWorklet.addModule(WORKLET_URL);
        }
        await audioCtx.resume();
        const len = session.origL.length;
        const buf = audioCtx.createBuffer(2, len, session.sampleRate);
        buf.getChannelData(0).set(session.origL);
        buf.getChannelData(1).set(session.origR);
        workletNode = new AudioWorkletNode(audioCtx, 'tape-restore', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        });
        const live = document.getElementById('liveMode').checked;
        if (live) {
            workletNode.port.postMessage({ type: 'setLive', f0: r.reference.primary });
        }
        else {
            workletNode.port.postMessage({ type: 'setCurve', eps: r.deviation.eps.slice(), hop: r.deviation.hop });
        }
        workletNode.port.postMessage({ type: 'setEq', taps: r.eq.taps.slice() });
        workletNode.port.postMessage({ type: 'bypass', value: !restoredMode });
        sourceNode = audioCtx.createBufferSource();
        sourceNode.buffer = buf;
        sourceNode.connect(workletNode).connect(audioCtx.destination);
        sourceNode.onended = () => { if (sourceNode)
            stopPlayback(); };
        sourceNode.start();
        playStartedAt = audioCtx.currentTime;
        document.getElementById('playBtn').textContent = '■ 停止';
        const posEl = document.getElementById('playPos');
        playTimer = window.setInterval(() => {
            if (!audioCtx)
                return;
            const t = audioCtx.currentTime - playStartedAt;
            posEl.textContent = `${fmtTime(t)} / ${fmtTime(len / session.sampleRate)}`;
        }, 250);
    });
}
function stopPlayback() {
    try {
        sourceNode?.stop();
    }
    catch { /* 已停止 */ }
    sourceNode?.disconnect();
    workletNode?.disconnect();
    sourceNode = null;
    workletNode = null;
    window.clearInterval(playTimer);
    const btn = document.getElementById('playBtn');
    if (btn)
        btn.textContent = '▶ 播放';
}
// ---------- 页 4:归档 ----------
function renderArchive() {
    const rows = archive.list();
    app.innerHTML = `
    <h2>归档</h2>
    <div class="card">
      ${session.result
        ? `<button id="arcBtn">归档当前结果并导出</button>
           <button id="wavBtn">导出修复后 WAV(24bit)</button>
           <button id="jsonBtn">导出处理报告 JSON</button>`
        : '<p class="hint">当前没有已完成的修复结果。</p>'}
    </div>
    <h3>归档记录(${rows.length})</h3>
    <table class="tbl"><thead><tr><th>磁带</th><th>文件</th><th>时长</th><th>方位角</th><th>残余抖晃</th><th>10kHz残差</th><th>归档时间</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${esc(r.tapeId)}</td><td>${esc(r.fileName)}</td><td>${fmtTime(r.durationSec)}</td>
      <td>${r.azimuthArcmin.toFixed(2)}′</td><td>${(r.residualWowFlutter * 100).toFixed(3)}%</td>
      <td>${r.eqResidualDbAt10k.toFixed(2)}dB</td><td>${new Date(r.archivedAt).toLocaleString()}</td>
      <td><button data-del="${r.id}" class="link">删除</button></td></tr>`).join('')}</tbody></table>`;
    const download = (name, blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    document.getElementById('wavBtn')?.addEventListener('click', () => {
        const r = session.result;
        const wav = encodeWav([r.L, r.R], r.sampleRate, 24);
        download(`restored_${session.fileName ?? 'tape'}.wav`, new Blob([wav.buffer], { type: 'audio/wav' }));
    });
    document.getElementById('jsonBtn')?.addEventListener('click', () => {
        const r = session.result;
        const report = {
            tape: session.tapeId ? registry.get(session.tapeId) : null,
            file: session.fileName,
            sampleRate: r.sampleRate,
            reference: r.reference,
            azimuth: { arcmin: r.azimuth.angleArcmin, dtUs: r.azimuth.dtSeconds * 1e6 },
            eq: { lossDbAt10k: r.eq.lossDbAt10k, residualDbAt10k: r.eq.residualDbAt10k, maxGainDb: r.eq.maxGainDb },
            residualWowFlutter: r.residualWowFlutter,
            timings: r.timings,
            exportedAt: new Date().toISOString(),
        };
        download(`report_${session.fileName ?? 'tape'}.json`, new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    });
    document.getElementById('arcBtn')?.addEventListener('click', () => {
        const r = session.result;
        const rec = {
            id: uid(),
            tapeId: session.tapeId ?? '(未关联)',
            fileName: session.fileName ?? '(未知)',
            archivedAt: new Date().toISOString(),
            durationSec: r.L.length / r.sampleRate,
            sampleRate: r.sampleRate,
            refType: r.reference.type,
            refFreq: r.reference.primary,
            azimuthArcmin: r.azimuth.angleArcmin,
            azimuthDtUs: r.azimuth.dtSeconds * 1e6,
            eqLossDbAt10k: r.eq.lossDbAt10k,
            eqResidualDbAt10k: r.eq.residualDbAt10k,
            residualWowFlutter: r.residualWowFlutter,
            processMs: r.timings.total,
        };
        archive.add(rec);
        renderArchive();
    });
    app.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
        archive.remove(b.dataset.del);
        renderArchive();
    }));
}
// ---------- 路由 ----------
const pages = {
    register: renderRegister,
    process: renderProcess,
    listen: renderListen,
    archive: renderArchive,
};
function route() {
    const hash = location.hash.replace('#/', '') || 'register';
    const page = pages[hash] ?? renderRegister;
    document.querySelectorAll('nav button').forEach((b) => {
        b.classList.toggle('on', b.dataset.page === hash);
    });
    if (hash !== 'listen')
        stopPlayback();
    page();
}
document.querySelectorAll('nav button').forEach((b) => {
    b.addEventListener('click', () => {
        location.hash = `#/${b.dataset.page}`;
    });
});
window.addEventListener('hashchange', route);
route();
