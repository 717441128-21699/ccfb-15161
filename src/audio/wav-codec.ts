/**
 * 极简 WAV PCM 编解码（16/24-bit 整数、单声道/立体声）。
 * 解码采用分块读取，配合主线程流式处理，避免 60 分钟磁带整带驻留内存。
 */

export interface PcmChunk {
  /** 平面声道数据，每通道一块 */
  channels: Float32Array[];
  sampleRate: number;
  isLast: boolean;
}

interface WavHeader {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
}

function readHeader(view: DataView): WavHeader {
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') throw new Error('不是 RIFF/WAVE 文件');
  let offset = 12;
  let dataOffset = -1;
  let dataLength = 0;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (dataOffset < 0 || !sampleRate) throw new Error('WAV 缺少 data/fmt 块');
  return { sampleRate, channels, bitsPerSample, dataOffset, dataLength };
}

/** 分块解码 WAV，逐 chunk 回调（每块默认 30s） */
export async function decodeWavStream(
  file: Blob,
  onChunk: (chunk: PcmChunk) => void | Promise<void>,
  chunkSec = 30,
): Promise<{ sampleRate: number; channels: number; totalSamples: number }> {
  const headBuf = await file.slice(0, Math.min(64 * 1024, file.size)).arrayBuffer();
  const header = readHeader(new DataView(headBuf));
  if (header.bitsPerSample !== 16 && header.bitsPerSample !== 24) {
    throw new Error(`暂不支持 ${header.bitsPerSample}-bit WAV，请先转成 16/24-bit PCM`);
  }
  const bytesPerSample = header.bitsPerSample / 8;
  const frameBytes = header.channels * bytesPerSample;
  const chunkFrames = chunkSec * header.sampleRate;
  const totalSamples = Math.min(header.dataLength, file.size - header.dataOffset) / frameBytes;

  let pos = header.dataOffset;
  const end = header.dataOffset + Math.min(header.dataLength, file.size - header.dataOffset);
  let isLast = false;
  while (pos < end) {
    const next = Math.min(end, pos + chunkFrames * frameBytes);
    const buf = await file.slice(pos, next).arrayBuffer();
    const view = new DataView(buf);
    const frames = Math.floor(view.byteLength / frameBytes);
    const channels = Array.from({ length: header.channels }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < header.channels; c++) {
        const bytePos = i * frameBytes + c * bytesPerSample;
        channels[c][i] = decodeSample(view, bytePos, header.bitsPerSample);
      }
    }
    pos = next;
    isLast = pos >= end;
    await onChunk({ channels, sampleRate: header.sampleRate, isLast });
  }
  return { sampleRate: header.sampleRate, channels: header.channels, totalSamples: Math.floor(totalSamples) };
}

function decodeSample(view: DataView, bytePos: number, bits: number): number {
  if (bits === 16) return view.getInt16(bytePos, true) / 32768;
  // 24-bit little endian → int32
  const b0 = view.getUint8(bytePos);
  const b1 = view.getUint8(bytePos + 1);
  const b2 = view.getUint8(bytePos + 2);
  let v = b0 | (b1 << 8) | (b2 << 16);
  if (v & 0x800000) v |= 0xff000000;
  return v / 8388608;
}

/** 交织立体声 PCM → 16-bit WAV Blob（分块拼装，避免巨型 ArrayBuffer） */
export function encodeWav16(interleaved: Float32Array, sampleRate: number, channels = 2): Blob {
  const frames = Math.floor(interleaved.length / channels);
  const dataBytes = frames * channels * 2;
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  writeStr(v, 0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeStr(v, 8, 'WAVE');
  writeStr(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  writeStr(v, 36, 'data');
  v.setUint32(40, dataBytes, true);

  const pcm = new Uint8Array(dataBytes);
  const dv = new DataView(pcm.buffer);
  for (let i = 0; i < frames * channels; i++) {
    const s = Math.max(-1, Math.min(1, interleaved[i]));
    dv.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([header, pcm], { type: 'audio/wav' });
}

function writeStr(v: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
}
