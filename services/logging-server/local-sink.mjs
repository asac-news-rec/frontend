import {mkdirSync,existsSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {digest} from './partition.mjs';
export function createLocalSink(root){
 root=path.resolve(root);mkdirSync(root,{recursive:true});
 const target=name=>{const p=path.resolve(root,name);if(!p.startsWith(root+path.sep))throw new Error('INVALID_OBJECT_PATH');return p;};
 return {
  put(name,content){const file=target(name),hash=digest(content);mkdirSync(path.dirname(file),{recursive:true});
   if(existsSync(file)){if(digest(readFileSync(file,'utf8'))!==hash)throw new Error('OBJECT_CONTENT_CONFLICT');return;}
   const tmp=file+'.tmp';const fd=openSync(tmp,'w');try{writeFileSync(fd,content,'utf8');fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);if(process.platform!=='win32'){const dir=openSync(path.dirname(file),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
  },
  remove(name){const file=target(name);for(const p of [file,file+'.tmp'])if(existsSync(p))unlinkSync(p);}
 };
}
