import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

// Starts the real Python HTTP service; SQLite is opened read-only for assertions.
export async function startFastApiLogging(t,token){
 const service=fileURLToPath(new URL('../../services/logging-server/',import.meta.url));
 const dir=mkdtempSync(path.join(tmpdir(),'fastapi-logging-'));
 const database=path.join(dir,'inbox.sqlite');
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const url=`http://127.0.0.1:${port}`;
 const child=spawn(process.env.LOGGING_PYTHON||'python',['-m','logging_service'],{cwd:service,stdio:['ignore','ignore','pipe'],env:{...process.env,LOGGING_STORE:'sqlite',LOGGING_TOKEN:token,LOGGING_DB:database,LOGGING_EXPORT_DIR:path.join(dir,'objects'),LOGGING_PORT:String(port),LOGGING_FLUSH_MS:'30000'}});
 let db;
 let failure='';child.stderr.on('data',b=>{failure=(failure+b.toString()).slice(-4000);});
 let spawnError;child.on('error',error=>{spawnError=error;});
 t.after(async()=>{
  if(child.exitCode===null&&!spawnError){child.kill();await once(child,'exit');}
  db?.close();
  rmSync(dir,{recursive:true,force:true});
 });
 const deadline=Date.now()+15000;
 while(true){
  if(spawnError)throw spawnError;
  if(child.exitCode!==null)throw new Error(`FastAPI startup failed: ${failure}`);
  try{if((await fetch(url+'/health')).ok)break;}catch{}
  if(Date.now()>deadline)throw new Error(`FastAPI readiness timeout: ${failure}`);
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 db=new DatabaseSync(database,{readOnly:true});
 const store={
  getServed:id=>db.prepare('SELECT * FROM served_records WHERE impression_id=?').get(id),
  getAction:id=>db.prepare('SELECT * FROM action_records WHERE event_id=?').get(id),
  actions:()=>db.prepare('SELECT * FROM action_records ORDER BY received_at,event_id').all(),
  counts:()=>({served:db.prepare('SELECT count(*) n FROM served_records').get().n,actions:db.prepare('SELECT count(*) n FROM action_records').get().n}),
  async intakeActions(context,body){const response=await fetch(url+'/events',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','x-news-reader':context.readerId,'x-collection-enabled':String(context.collectionEnabled),'x-news-source':context.source??'browser'},body:JSON.stringify(body)});return response.json();}
 };
 return {url,store};
}
