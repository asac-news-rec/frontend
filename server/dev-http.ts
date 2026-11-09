import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createBackendProxy} from './backend-proxy.js';

// Local development only. No visitor API, cookies or SQLite are initialized.
export function createDevServer({root,origin,backendBaseUrl}:{root:string;origin:string;backendBaseUrl?:string}) {
  const proxy=createBackendProxy({baseUrl:backendBaseUrl,origin});
  return http.createServer(async(req,res)=>{
    try {
      const pathname=new URL(req.url??'/',origin).pathname;
      if(await proxy(req,res,pathname))return;
      if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
      if(!['/','/index.html'].includes(pathname)&&!/^\/src\/[a-zA-Z0-9_-]+\.(js|css)$/.test(pathname)){res.writeHead(404);res.end();return;}
      const filename=pathname==='/'?'index.html':pathname.slice(1);
      const body=await readFile(path.join(root,'dist',filename));
      const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
      res.writeHead(200,{'Content-Type':`${mime[path.extname(filename)]}; charset=utf-8`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(req.method==='HEAD'?undefined:body);
    } catch(error) {
      const missing=error instanceof Error&&'code' in error&&error.code==='ENOENT';
      if(!res.headersSent)res.writeHead(missing?404:500);
      res.end();
    }
  });
}
