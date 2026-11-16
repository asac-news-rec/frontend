import path from 'node:path';
import {mkdirSync,openSync,writeFileSync,readFileSync,closeSync,unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {openLoggingStore} from './repository.mjs';
import {createLocalSink} from './local-sink.mjs';
import {createExporter} from './exporter.mjs';
import {createLoggingHttp} from './http.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const token=process.env.LOGGING_TOKEN;if(!token||token.length<24)throw new Error('Set LOGGING_TOKEN (24+ characters)');
const database=process.env.LOGGING_DB||path.join(root,'data/inbox.sqlite');
mkdirSync(path.dirname(database),{recursive:true});
const lock=database+'.lock';
try{const fd=openSync(lock,'wx');writeFileSync(fd,String(process.pid));closeSync(fd);}catch(error){
 if(error.code!=='EEXIST')throw error;
 const pid=Number(readFileSync(lock,'utf8'));if(!Number.isInteger(pid)||pid<1)throw new Error('INVALID_LOCK_REQUIRES_OPERATOR');
 let alive=true;try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
 if(alive)throw new Error('LOGGING_ALREADY_RUNNING');unlinkSync(lock);const fd=openSync(lock,'wx');writeFileSync(fd,String(process.pid));closeSync(fd);
}
process.once('exit',()=>{try{unlinkSync(lock);}catch{}});
const store=openLoggingStore({database});
const exporter=createExporter({store,sink:createLocalSink(process.env.LOGGING_EXPORT_DIR||path.join(root,'data/objects'))});
const interval=Number(process.env.LOGGING_FLUSH_MS||30000);
if(!Number.isFinite(interval)||interval<100)throw new Error('INVALID_FLUSH_INTERVAL');
const server=createLoggingHttp({store,exporter,token,maxRecords:Number(process.env.LOGGING_MAX_RECORDS||100000)});
const timer=setInterval(()=>{try{exporter.flush();}catch(error){console.error('flush failed',error.code||error.name);}},interval);timer.unref();
server.requestTimeout=15000;server.headersTimeout=10000;
server.listen(Number(process.env.LOGGING_PORT||4195),process.env.LOGGING_HOST||'127.0.0.1',()=>console.log('Logging HTTP ready; local file sink only'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{clearInterval(timer);server.close(()=>{try{exporter.flush();}finally{store.close();}});server.closeIdleConnections();});
