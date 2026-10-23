import {modelFiles} from './model-files.js';

const CACHE_NAME = 'railway-model-bytes-v1';
const defaultRoot = new URL('../', import.meta.url);

async function cachedModel(info, root, onProgress) {
  const url = new URL(info.packed, root);
  url.searchParams.set('v', info.sha256.slice(0, 16));
  let cache;
  try { cache = await globalThis.caches?.open(CACHE_NAME); } catch {}
  let response;
  try { response = await cache?.match(url.href); } catch {}
  const fromCache = !!response;
  if (!response) response = await fetch(url);
  if (!response.ok || !response.body) throw new Error('Packed model unavailable');
  const candidate = !fromCache && cache ? response.clone() : null;
  let loaded = 0;
  const total = Number(response.headers.get('content-length')) || info.packedBytes;
  const progress = new TransformStream({transform(chunk, controller) {
    loaded += chunk.byteLength;
    onProgress?.({loaded, total, lengthComputable: total > 0});
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
