import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('.',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
http.createServer(async(req,res)=>{
  try {
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const target=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!target.startsWith(root)||!['.html','.css','.js'].includes(path.extname(target))) {res.writeHead(404);res.end();return;}
    const data=await readFile(target);res.writeHead(200,{'Content-Type':mime[path.extname(target)],'Cache-Control':'no-store'});res.end(data);
  }catch {res.writeHead(404);res.end('Not found');}
}).listen(4173,'127.0.0.1',()=>console.log('News prototype: http://127.0.0.1:4173'));
