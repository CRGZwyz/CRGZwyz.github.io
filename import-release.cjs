// Fetch the user's published canonical site, verify every byte, then prepare Pages.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const manifest=require('./release-manifest.json');
const primary='https://www.crgzwyz.ddnsfree.com',secondary='https://crgzwyz-railway.netlify.app';
const origin=new URL(process.env.SOURCE_SITE_URL||primary);
if(![primary,secondary].includes(origin.origin))throw Error('Use an existing railway host');
const dest=path.resolve('site');fs.mkdirSync(dest,{recursive:true});
const media=/^library\/videos\/(df4d|hxd2|nd5|ss9|hxd3d)-(pure|wind)\.mp4$/;
const rows=manifest.files.filter(f=>!media.test(f.path));let next=0,done=0;
async function fetchOne(e){
 if(e.path.startsWith('/')||e.path.split('/').includes('..'))throw Error('Invalid relative path');
 const target=path.resolve(dest,e.path);if(!target.startsWith(dest+path.sep))throw Error('Invalid target');
 for(let attempt=0;attempt<3;attempt++)try{
  const u=new URL('/'+e.path,origin);u.searchParams.set('release',manifest.version);
  const res=await fetch(u,{signal:AbortSignal.timeout(180000)});
  if(!res.ok)throw Error('HTTP '+res.status+' '+e.path);
  const data=Buffer.from(await res.arrayBuffer());
  if(data.length!==e.bytes||crypto.createHash('sha256').update(data).digest('hex')!==e.sha256)throw Error('Release mismatch '+e.path);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);console.log('Verified '+(++done)+'/'+rows.length+' '+e.path);return;
 }catch(err){if(attempt===2||/mismatch/.test(err.message))throw err}
}
async function worker(){while(next<rows.length)await fetchOne(rows[next++])}
async function main(){
 await Promise.all(Array.from({length:4},worker));
 const list=path.join(dest,'library/videos.json'),videos=JSON.parse(fs.readFileSync(list,'utf8'));
 for(const [key,v]of Object.entries(videos))if(/^(df4d|hxd2|nd5|ss9|hxd3d)-(pure|wind)$/.test(key))v.src=primary+'/library/videos/'+key+'.mp4';
 fs.writeFileSync(list,JSON.stringify(videos,null,2)+'\n');
 const watch=path.join(dest,'library/watch.js');
 fs.appendFileSync(watch,`\n// Retain the original video bytes on the two existing media hosts.\nif(item&&/^(df4d|hxd2|nd5|ss9|hxd3d)-(pure|wind)$/.test(key)){let tried=false;const previous=v.onerror;v.onerror=()=>{if(!tried){tried=true;const wasPlaying=!v.paused;v.src=${JSON.stringify(secondary)}+'/library/videos/'+key+'.mp4';document.querySelector('#download').href=v.src;if(wasPlaying)v.play().catch(()=>{});}else if(previous)previous();};}\n`);
 fs.writeFileSync(path.join(dest,'.nojekyll'),'');
 const total=rows.reduce((s,x)=>s+x.bytes,0);if(total>=1_000_000_000)throw Error('Pages artifact too large');
 console.log('Pages snapshot: '+rows.length+' verified assets, '+total+' bytes; 10 videos served from existing media hosts.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
