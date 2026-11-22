import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * AudioWorklet 运行在独立的 WorkletGlobalScope 中，不能走主 bundle。
 * 这里把每个 *.worklet.ts（连同它 import 的 DSP 内核）打成单个 IIFE 脚本。
 */
export async function esbuild(entry: string): Promise<string> {
  const entryPoints = [path.isAbsolute(entry) ? entry : path.join(root, entry)];
  const result = await build({
    entryPoints,
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    sourcemap: 'inline',
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}
