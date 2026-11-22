import { describe, it, expect } from 'vitest';
import { FFT, hannWindow, magnitudeSpectrum } from '../src/dsp/fft';

describe('FFT', () => {
  it('正变换后单频正弦落在正确 bin 上', () => {
    const n = 1024;
    const sr = 48000;
    const f0 = 1000;
    const sig = new Float64Array(n);
    for (let i = 0; i < n; i++) sig[i] = Math.sin(2 * Math.PI * f0 * (i / sr));
    const fft = new FFT(n);
    const mag = magnitudeSpectrum(fft, sig, hannWindow(n));
    const expectedBin = Math.round((f0 * n) / sr);
    let peak = 0;
    for (let k = 1; k < mag.length; k++) if (mag[k] > mag[peak]) peak = k;
    expect(Math.abs(peak - expectedBin)).toBeLessThanOrEqual(1);
    expect(mag[peak]).toBeGreaterThan(0.5);
  });

  it('逆变换能还原信号（往返误差 < 1e-10）', () => {
    const n = 256;
    const fft = new FFT(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const orig = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      orig[i] = Math.sin(0.13 * i) + 0.3 * Math.cos(0.031 * i + 1);
      re[i] = orig[i];
    }
    fft.run(re, im);
    fft.run(re, im, true);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(re[i] - orig[i]));
    expect(err).toBeLessThan(1e-10);
  });
});
