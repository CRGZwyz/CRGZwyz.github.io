const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const manifest=require('./source-manifest.json'),dest=path.resolve('site');
const base=new URL(process.env.SOURCE_PREVIEW_URL||'');
if(base.protocol!=='https:'||!base.hostname.endsWith('.edgeone.cool'))throw Error('Expected the Tencent preview URL');
fs.mkdirSync(dest,{recursive:true});
let next=0,done=0;
async function one(e){
 if(e.path.startsWith('/')||e.path.split('/').includes('..'))throw Error('Unsafe path');
 const target=path.resolve(dest,e.path);if(!target.startsWith(dest+path.sep))throw Error('Unsafe target');
 const u=new URL('/'+e.path,base.origin);u.search=base.search;
 for(let i=0;i<3;i++)try{
  const res=await fetch(u,{signal:AbortSignal.timeout(120000)});if(!res.ok)throw Error('HTTP '+res.status+' '+e.path);
  const raw=Buffer.from(await res.arrayBuffer()),canonical=e.text?Buffer.from(raw.toString('utf8').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n')):raw;
  if(crypto.createHash('sha256').update(canonical).digest('hex')!==e.sha256)throw Error('Snapshot hash mismatch '+e.path);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,raw);console.log('Verified '+(++done)+'/'+manifest.files.length+' '+e.path);return;
 }catch(err){if(i===2||/hash mismatch|HTTP 401/.test(err.message))throw err;}
}
async function worker(){while(next<manifest.files.length){let i=next++;await one(manifest.files[i]);}}
Promise.all(Array.from({length:4},worker)).then(()=>{fs.writeFileSync(path.join(dest,'.nojekyll'),'');console.log('Complete verified static snapshot: '+done);}).catch(e=>{console.error(e.message);process.exitCode=1;});
