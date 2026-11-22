import { defineConfig, type Plugin } from 'vite';
import { esbuild } from './scripts/worklet-plugin';

// 把 src/worklets/*.ts 以独立 bundle 形式提供给 audioWorklet.addModule()
function audioWorkletPlugin(): Plugin {
  const virtualIds = new Map<string, string>();
  const resolved = (id: string) => '\0worklet:' + id;

  return {
    name: 'audio-worklet-bundle',
    enforce: 'pre',
    resolveId(source) {
      if (source.endsWith('.worklet.ts')) {
        const id = source.replace(/^.*src\/worklets\//, 'src/worklets/');
        const v = resolved(id);
        virtualIds.set(v, id);
        return v;
      }
      return null;
    },
    async load(id) {
      const real = virtualIds.get(id);
      if (!real) return null;
      // dev: 每次请求实时打包；build: 产出稳定 URL 的静态产物
      const code = await esbuild(real);
      return { code, moduleSideEffects: 'no-treeshake' };
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0];
        if (!url || !url.endsWith('.worklet.ts')) return next();
        try {
          const file = url.replace(/^\/@fs\//, '').replace(/^\//, '');
          const code = await esbuild(file);
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(code);
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [audioWorkletPlugin()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
