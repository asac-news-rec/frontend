import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createBackendProxy} from './backend-proxy.js';
import {createSyntheticBridge, type SyntheticConfig} from './synthetic-bridge.js';
import {createBehaviorBridge,type LoggingConfig} from './behavior-bridge.js';

// Local development only. The optional synthetic bridge uses an in-memory session;
// visitor APIs and SQLite are not initialized here.
export function createDevServer({root,origin,backendBaseUrl,synthetic,logging}:{root:string;origin:string;backendBaseUrl?:string;synthetic?:SyntheticConfig;logging?:LoggingConfig}) {
  const bridge=createSyntheticBridge(origin,synthetic);
  const behavior=createBehaviorBridge(origin,backendBaseUrl,synthetic?undefined:logging);
  const proxy=createBackendProxy({baseUrl:backendBaseUrl,origin,onReaderIssued:behavior.onReaderIssued,onFeed:async(req,input,payload)=>{await bridge.onFeed(req,input,payload);return behavior.onFeed(req,input,payload);}});
  return http.createServer(async(req,res)=>{
    try {
      const pathname=new URL(req.url??'/',origin).pathname;
      if(await bridge.handle(req,res,pathname))return;
      if(await behavior.handle(req,res,pathname))return;
      if(await proxy(req,res,pathname))return;
      if(pathname.startsWith('/images/')) {
        if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
        if(!backendBaseUrl){res.writeHead(503);res.end();return;}
        try {
          const upstream=await fetch(new URL(pathname+new URL(req.url??'/',origin).search,backendBaseUrl),{method:req.method,signal:AbortSignal.timeout(8000)});
          res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')??'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
          res.end(req.method==='HEAD'?undefined:Buffer.from(await upstream.arrayBuffer()));
        } catch {if(!res.headersSent)res.writeHead(503);res.end();}
        return;
      }
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
