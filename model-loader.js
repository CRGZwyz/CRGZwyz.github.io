import {modelFiles} from './model-files.js';

const CACHE_NAME = 'railway-model-bytes-v1';
const defaultRoot = new URL('../', import.meta.url);

// Start one request first: servers ignoring Range return their single full response.
// Servers supporting Range receive three more requests after headers arrive.
async function parallelModel(url, info, onProgress) {
  const count = 4, size = info.packedBytes, step = Math.ceil(size / count);
  const controllers = new Set(), reported = Array(count).fill(0);
  let stopping = false;
  async function part(i, initial) {
    const start = i * step, end = Math.min(size - 1, start + step - 1);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (stopping) throw new Error('Model download cancelled');
      const controller = initial?.controller || new AbortController();
      controllers.add(controller);
      let idle, loaded = 0;
      const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), 15000); };
      const deadline = setTimeout(() => controller.abort(), 90000);
      resetIdle();
      try {
        const response = initial?.response || await fetch(url, {
          headers: {Range: `bytes=${start}-${end}`}, signal: controller.signal,
        });
        initial = null;
        if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${size}` || !response.body) {
          throw Object.assign(new Error('Invalid range response'), {invalidRange: true});
        }
        const reader = response.body.getReader(), chunks = [];
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          resetIdle(); chunks.push(value); loaded += value.length;
          reported[i] = Math.max(reported[i], loaded);
          onProgress?.({loaded: reported.reduce((a, b) => a + b, 0), total: size, lengthComputable: true});
        }
        if (loaded !== end - start + 1) throw new Error('Truncated model range');
        return new Blob(chunks);
      } catch (error) {
        initial = null; controller.abort();
        if (error.invalidRange || attempt === 2 || stopping) throw error;
      } finally {
        clearTimeout(idle); clearTimeout(deadline); controllers.delete(controller);
      }
    }
  }
  const firstController = new AbortController(); controllers.add(firstController);
  let headersTimer = setTimeout(() => firstController.abort(), 15000);
  try {
    const response = await fetch(url, {headers: {Range: `bytes=0-${step - 1}`}, signal: firstController.signal});
    clearTimeout(headersTimer);
    // A server ignoring Range supplies its one full response without duplicate downloads.
    if (response.status === 200) return response;
    const parts = await Promise.all([
      part(0, {response, controller: firstController}),
      ...Array.from({length: count - 1}, (_, n) => part(n + 1)),
    ]);
    return new Response(new Blob(parts), {headers: {'content-length': String(size), 'x-rail-ranges': '4'}});
  } catch {
    stopping = true; controllers.forEach(c => c.abort());
    return fetch(url, {signal: AbortSignal.timeout(90000)});
  } finally { clearTimeout(headersTimer); }
}

async function cachedModel(info, root, onProgress) {
  const url = new URL(info.packed, root);
  url.searchParams.set('v', info.sha256.slice(0, 16));
  let cache;
  try { cache = await globalThis.caches?.open(CACHE_NAME); } catch {}
  let response;
  try { response = await cache?.match(url.href); } catch {}
  const fromCache = !!response;
  if (!response) response = await parallelModel(url, info, onProgress);
  if (!response.ok || !response.body) throw new Error('Packed model unavailable');
  const candidate = !fromCache && cache ? response.clone() : null;
  let loaded = 0;
  const total = Number(response.headers.get('content-length')) || info.packedBytes;
  const progress = new TransformStream({transform(chunk, controller) {
    loaded += chunk.byteLength;
    if (fromCache || !response.headers.get('x-rail-ranges')) onProgress?.({loaded, total, lengthComputable: total > 0});
    controller.enqueue(chunk);
  }});
  try {
    const bytes = await new Response(response.body.pipeThrough(progress)
      .pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    if (bytes.byteLength !== info.bytes) throw new Error('Model size mismatch');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
    if (hash !== info.sha256) throw new Error('Model integrity mismatch');
    if (candidate) {
      try {
        await cache.put(url.href, candidate);
        const keys = await cache.keys();
        await Promise.all(keys.filter(k => new URL(k.url).pathname === url.pathname && k.url !== url.href)
          .map(k => cache.delete(k)));
      } catch {} // Private browsing, storage pressure, or denied storage never blocks viewing.
    }
    return bytes;
  } catch (error) {
    try { await cache?.delete(url.href); } catch {}
    throw error;
  }
}

// GLTFLoader.loadAsync delegates to load(), so both existing calling styles stay intact.
export function useCompressedModels(loader, {root = defaultRoot} = {}) {
  const originalLoad = loader.load.bind(loader);
  loader.load = function(url, onLoad, onProgress, onError) {
    const absolute = new URL(url, globalThis.location?.href || root);
    const relative = absolute.href.startsWith(root.href)
      ? absolute.href.slice(root.href.length).split(/[?#]/)[0] : '';
    const info = modelFiles[relative];
    if (!info || !globalThis.isSecureContext || !globalThis.DecompressionStream ||
        !globalThis.TransformStream || !globalThis.crypto?.subtle) {
      return originalLoad(url, onLoad, onProgress, onError);
    }
    loader.manager.itemStart(url);
    cachedModel(info, root, onProgress)
      .then(bytes => loader.parseAsync(bytes, loader.resourcePath || new URL('.', absolute).href))
      .then(gltf => {
        try { onLoad?.(gltf); } finally { loader.manager.itemEnd(url); }
      }, () => {
        // Unsupported decoding, an unavailable packed file, or corrupt storage falls back
        // to the original, unchanged GLB and the original Three.js error handling.
        originalLoad(url, onLoad, onProgress, onError);
        loader.manager.itemEnd(url);
      });
  };
  return loader;
}
