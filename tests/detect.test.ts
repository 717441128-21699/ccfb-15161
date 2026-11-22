import { describe, it, expect } from 'vitest';
import { detectReferenceOrHum } from '../src/dsp/detect-tone';
import { Rng } from '../src/dsp/synthesis';

const SR = 48000;

describe('参考音/哼声检测', () => {
  it('在噪声中识别 1kHz 参考音，频率误差 <2Hz', () => {
    const n = SR * 6;
    const rng = new Rng(1);
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      sig[i] = 0.2 * Math.sin(2 * Math.PI * 1000 * (i / SR)) + 0.05 * rng.gaussian();
    }
    const d = detectReferenceOrHum(sig, SR, 1000);
    expect(d).not.toBeNull();
    expect(d!.kind).toBe('reference');
    expect(Math.abs(d!.frequency - 1000)).toBeLessThan(2);
    expect(d!.purity).toBeGreaterThan(0.35);
  });

  it('无参考音时回退到 50Hz 哼声', () => {
    const n = SR * 6;
    const rng = new Rng(2);
    const sig = new Float32Array(n);
    let white = 0;
    for (let i = 0; i < n; i++) {
      white = 0.95 * white + 0.05 * rng.gaussian();
      sig[i] = white + 0.08 * Math.sin(2 * Math.PI * 50 * (i / SR));
    }
    const d = detectReferenceOrHum(sig, SR, 1000);
    expect(d).not.toBeNull();
    expect(d!.kind).toBe('hum');
    expect(Math.abs(d!.frequency - 50)).toBeLessThan(1.5);
  });

  it('纯噪声无强谱线时返回 null', () => {
    const n = SR * 4;
    const rng = new Rng(3);
    const sig = Float32Array.from({ length: n }, () => 0.05 * rng.gaussian());
    const d = detectReferenceOrHum(sig, SR);
    expect(d).toBeNull();
  });
});
