/**
 * 极简 WAV 编解码（16-bit PCM，立体声/单声道）。
 * 编码支持流式分块写入，避免长音频整盘驻留多个副本。
 */

export function encodeWavHeader(numSamplesPerChannel: number, sampleRate: number, channels: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = numSamplesPerChannel * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44);
  const dv = new DataView(buffer);
  writeString(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeString(dv, 8, 'WAVE');
  writeString(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * bytesPerSample, true);
  dv.setUint16(32, channels * bytesPerSample, true);
  dv.setUint16(34, 16, true);
  writeString(dv, 36, 'data');
  dv.setUint32(40, dataSize, true);
  return buffer;
}

function writeString(dv: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i));
}

/** 交错浮点样本 → 16-bit PCM 块。 */
export function encodePcmBlock(channels: Array<ArrayLike<number>>, frameCount: number): Uint8Array {
  const ch = channels.length;
  const out = new Uint8Array(frameCount * ch * 2);
  const dv = new DataView(out.buffer);
  let p = 0;
  for (let n = 0; n < frameCount; n++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][n]));
      dv.setInt16(p, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      p += 2;
    }
  }
  return out;
}

/** 完整编码一段立体声信号为 WAV Blob。 */
export function encodeStereoWav(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  sampleRate: number,
): Blob {
  const frames = Math.min(left.length, right.length);
  const parts: BlobPart[] = [encodeWavHeader(frames, sampleRate, 2)];
  const chunk = 1 << 18;
  for (let start = 0; start < frames; start += chunk) {
    const take = Math.min(chunk, frames - start);
    const lc = new Float64Array(take);
    const rc = new Float64Array(take);
    for (let i = 0; i < take; i++) {
      lc[i] = left[start + i];
      rc[i] = right[start + i];
    }
    parts.push(encodePcmBlock([lc, rc], take));
  }
  return new Blob(parts, { type: 'audio/wav' });
}

/** 解码 WAV（支持 16/24/32-bit PCM 与 IEEE float）为交错 Float32 + 元信息。 */
export interface DecodedWav {
  sampleRate: number;
  channels: number;
  frames: number;
  interleaved: Float32Array;
}

export async function decodeWav(blob: Blob): Promise<DecodedWav> {
  const buf = await blob.arrayBuffer();
  const dv = new DataView(buf);
  if (decodeStr(dv, 0, 4) !== 'RIFF' || decodeStr(dv, 8, 4) !== 'WAVE') {
    throw new Error('不是合法 WAV 文件');
  }
  let offset = 12;
  let fmt = { sampleRate: 48000, channels: 2, bitsPerSample: 16, audioFormat: 1 };
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= dv.buffer.byteLength) {
    const id = decodeStr(dv, offset, 4);
    const size = dv.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bitsPerSample: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error('WAV 缺少 data 块');

  const frameBytes = (fmt.bitsPerSample / 8) * fmt.channels;
  const frames = Math.floor(dataLength / frameBytes);
  const interleaved = new Float32Array(frames * fmt.channels);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < fmt.channels; c++) {
      const p = dataOffset + (f * fmt.channels + c) * (fmt.bitsPerSample / 8);
      let v = 0;
      if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
        v = dv.getFloat32(p, true);
      } else if (fmt.bitsPerSample === 16) {
        v = dv.getInt16(p, true) / 0x8000;
      } else if (fmt.bitsPerSample === 24) {
        const u = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16);
        v = (u > 0x7fffff ? u - 0x1000000 : u) / 0x800000;
      } else if (fmt.bitsPerSample === 32) {
        v = dv.getInt32(p, true) / 0x80000000;
      }
      interleaved[f * fmt.channels + c] = v;
    }
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, frames, interleaved };
}

function decodeStr(dv: DataView, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(offset + i));
  return s;
}

/** 交错 Float32 → 分声道 Float64Array。 */
export function deinterleave(interleaved: Float32Array, channels: number): Float64Array[] {
  const frames = Math.floor(interleaved.length / channels);
  const out = Array.from({ length: channels }, () => new Float64Array(frames));
  for (let n = 0; n < frames; n++) {
    for (let c = 0; c < channels; c++) out[c][n] = interleaved[n * channels + c];
  }
  return out;
}
