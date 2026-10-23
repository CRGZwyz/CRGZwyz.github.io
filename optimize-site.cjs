const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const root = path.resolve(process.argv[2] || 'site');
if (!fs.existsSync(path.join(root, 'library/index.html'))) throw Error('Invalid site root');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const write = (p, text) => { fs.mkdirSync(path.dirname(path.join(root, p)), {recursive: true}); fs.writeFileSync(path.join(root, p), text); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const files = {};
const report = {models: [], thumbnails: {}, unchangedModelBytes: true, unchangedVideoBytes: true};
for (const name of ['hxd3b', 'cr400af']) {
  const source = `assets/${name}.glb`;
  const raw = fs.readFileSync(path.join(root, source));
  const packed = zlib.gzipSync(raw, {level: 9});
  if (!zlib.gunzipSync(packed).equals(raw)) throw Error('Non-lossless compression');
  write(source + '.bin', packed);
  files[source] = {packed: source + '.bin', bytes: raw.length, packedBytes: packed.length, sha256: sha(raw)};
  report.models.push({path: source, originalBytes: raw.length, downloadBytes: packed.length, sha256: sha(raw)});
}
files['hxd3b/assets/hxd3b.glb'] = files['assets/hxd3b.glb'];
write('rail/model-files.js', 'export const modelFiles = ' + JSON.stringify(files) + ';\n');
write('rail/model-loader.js', fs.readFileSync(path.join(__dirname, 'model-loader.js'), 'utf8'));
const loaderFiles = {
  'studio.js': './rail/model-loader.js',
  'hxd3b/studio.js': '../rail/model-loader.js',
  'wind-tunnel/scene.js': '../rail/model-loader.js',
  'hxd3b/wind-tunnel/scene.js': '../../rail/model-loader.js',
  'dead-haul/app.js': '../rail/model-loader.js',
  'cfd/app.js': '../rail/model-loader.js',
};
for (const [name, helper] of Object.entries(loaderFiles)) {
  let s = read(name);
  if (!s.includes('import {useCompressedModels}')) {
    s = `import {useCompressedModels} from '${helper}';\n` + s;
    if (name === 'cfd/app.js') {
      const before = 'return new GLTFLoader(manager).setDRACOLoader(decoder);';
      if (!s.includes(before)) throw Error('CFD loader changed');
      s = s.replace(before, 'return useCompressedModels(new GLTFLoader(manager).setDRACOLoader(decoder));');
    } else {
      const match = s.match(/loader\.setDRACOLoader\(draco\);|const loader=new GLTFLoader\(\)\.setDRACOLoader\(draco\);/);
      if (!match) throw Error('Missing GLTF loader hook: ' + name);
      s = s.replace(match[0], match[0] + '\nuseCompressedModels(loader);');
    }
  }
  if (name.startsWith('hxd3b/')) {
    const up = name.startsWith('hxd3b/wind-tunnel/') ? '../../' : '../';
    s = s.replaceAll("'./assets/hxd3b.glb'", "'../assets/hxd3b.glb'")
      .replaceAll("'../assets/hxd3b.glb'", `'${up}assets/hxd3b.glb'`)
      .replaceAll("'./vendor/addons/libs/draco/gltf/'", "'../vendor/addons/libs/draco/gltf/'");
    if (name.startsWith('hxd3b/wind-tunnel/')) {
      s = s.replaceAll("'../vendor/addons/libs/draco/gltf/'", "'../../vendor/addons/libs/draco/gltf/'");
    }
  }
  write(name, s);
}
for (const [name, up] of [['hxd3b/index.html', '../'], ['hxd3b/wind-tunnel/index.html', '../../']]) {
  let s = read(name);
  s = s.replace(/"three":"(?:\.\/|\.\.\/)vendor\/three\.module\.js"/, `"three":"${up}vendor/three.module.js"`)
    .replace(/"three\/addons\/":"(?:\.\/|\.\.\/)vendor\/addons\/"/, `"three/addons/":"${up}vendor/addons/"`);
  write(name, s);
}
const images = JSON.parse(fs.readFileSync(path.join(__dirname, 'image-assets.json'), 'utf8'));
for (const e of images) {
  if (!e.base64) continue;
  write(e.path, Buffer.from(e.base64, 'base64'));
  report.thumbnails[e.path] = {originalBytes: e.originalBytes, bytes: Buffer.byteLength(e.base64, 'base64')};
}
let portal = read('library/index.html');
if (!portal.includes('<picture>')) {
  let imageNumber = 0;
  portal = portal.replace(/<img\b[^>]*>/g, tag => {
    const src = tag.match(/src="(images\/[^\"]+\.png)"/);
    if (!src) return tag;
    const asset = images.find(e => e.original === 'library/' + src[1]);
    if (!asset) return tag;
    tag = tag.replace(/\s(?:loading|decoding|fetchpriority|width|height)="[^"]*"/g, '');
    tag = tag.replace('<img ', `<img width="${asset.width}" height="${asset.height}" decoding="async" loading="${imageNumber++ === 0 ? 'eager' : 'lazy'}" `);
    return asset.base64 ? `<picture><source type="image/webp" srcset="${src[1].replace(/\.png$/, '.webp')}">${tag}</picture>` : tag;
  });
  write('library/index.html', portal);
  write('library/style.css', read('library/style.css') + '\n.cover picture{display:block;width:100%;height:100%}\n');
}
for (const file of ['library/watch.html', 'dead-haul/watch.html']) {
  write(file, read(file).replaceAll('preload="metadata"', 'preload="none"'));
}
// These links originally assumed the CR400AF exhibit lived at the site root.
let cr = read('cr400af.html').replaceAll('href="./"', 'href="./cr400af.html"');
write('cr400af.html', cr);
let haul = read('dead-haul/index.html');
haul = haul.replace('href="../">复兴号完整拆装', 'href="../cr400af.html">复兴号完整拆装');
write('dead-haul/index.html', haul);
write('mobile-optimization-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
