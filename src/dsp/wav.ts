// WAV 编解码(PCM 16/24/32bit 与 float32),纯 TS,Node 与浏览器通用。

export interface WavData {
  sampleRate: number;
  channels: Float32Array[];
}

export function decodeWav(buf: ArrayBuffer | Uint8Array): WavData {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = (off: number, n: number) => String.fromCharCode(...u8.subarray(off, off + n));
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('不是 WAV 文件');
  let pos = 12;
  let fmt = { audioFormat: 1, numChannels: 1, sampleRate: 44100, bitsPerSample: 16 };
  let dataOff = -1, dataLen = 0;
  while (pos + 8 <= u8.length) {
    const id = str(pos, 4);
    const size = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: dv.getUint16(pos + 8, true),
        numChannels: dv.getUint16(pos + 10, true),
        sampleRate: dv.getUint32(pos + 12, true),
        bitsPerSample: dv.getUint16(pos + 22, true),
      };
    } else if (id === 'data') {
      dataOff = pos + 8;
      dataLen = Math.min(size, u8.length - dataOff);
    }
    pos += 8 + size + (size & 1);
  }
  if (dataOff < 0) throw new Error('WAV 中找不到 data 块');
  const { numChannels, bitsPerSample, audioFormat, sampleRate } = fmt;
  const bytes = bitsPerSample / 8;
  const frames = Math.floor(dataLen / (bytes * numChannels));
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(frames));
  let p = dataOff;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let v: number;
      if (audioFormat === 3 && bitsPerSample === 32) {
        v = dv.getFloat32(p, true);
      } else if (bitsPerSample === 16) {
        v = dv.getInt16(p, true) / 32768;
      } else if (bitsPerSample === 24) {
        let x = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16);
        if (x & 0x800000) x -= 0x1000000;
        v = x / 8388608;
      } else if (bitsPerSample === 32) {
        v = dv.getInt32(p, true) / 2147483648;
      } else if (bitsPerSample === 8) {
        v = (u8[p] - 128) / 128;
      } else {
        throw new Error(`不支持的 WAV 格式: format=${audioFormat} bits=${bitsPerSample}`);
      }
      channels[c][i] = v;
      p += bytes;
    }
  }
  return { sampleRate, channels };
}

export function encodeWav(channels: Float32Array[], sampleRate: number, bits: 16 | 24 | 32 = 24): Uint8Array {
  const numCh = channels.length;
  const frames = channels[0].length;
  const bytes = bits / 8;
  const dataLen = frames * numCh * bytes;
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const wr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); wr(8, 'WAVE');
  wr(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, numCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * numCh * bytes, true);
  dv.setUint16(32, numCh * bytes, true); dv.setUint16(34, bits, true);
  wr(36, 'data'); dv.setUint32(40, dataLen, true);
  let p = 44;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const v = clamp(channels[c][i]);
      if (bits === 16) {
        dv.setInt16(p, Math.round(v * 32767), true);
      } else if (bits === 24) {
        const x = Math.round(v * 8388607);
        out[p] = x & 0xff; out[p + 1] = (x >> 8) & 0xff; out[p + 2] = (x >> 16) & 0xff;
      } else {
        dv.setInt32(p, Math.round(v * 2147483647), true);
      }
      p += bytes;
    }
  }
  return out;
}
