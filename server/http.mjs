import {createVisitorFeed} from './feed.mjs';
import {categories,articles} from '../src/data.js';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {openVisitors} from './visitors.mjs';
import {createBackendProxy} from './backend-proxy.mjs';

export function createNewsServer({root, origin, database, now, backendBaseUrl}) {
  const backendProxy=createBackendProxy({baseUrl:backendBaseUrl,origin});
  const visitors = openVisitors(database, now);
  const secure = new URL(origin).protocol === 'https:';
  const cookieName = secure ? '__Host-news_visitor' : 'news_visitor';
  const cookie = (value, seconds) => `${cookieName}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const respond = (res, status, data) => {res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'private, no-store'}); res.end(JSON.stringify(data));};
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, origin).pathname;
      if (pathname.startsWith('/api/')) {
        if(await backendProxy(req,res,pathname))return;
        res.setHeader('Cache-Control', 'private, no-store');
        if (req.method === 'GET' && pathname === '/api/v1/categories') return respond(res, 200, {data:categories});
        const mutations = new Set(['/api/v1/visitors/bootstrap', '/api/v1/visitors/reset', '/api/v1/likes']);
        if (req.method !== 'GET' && req.method !== 'POST') return respond(res, 405, {error:'METHOD_NOT_ALLOWED'});
        if (req.method === 'POST' && req.headers.origin !== origin) return respond(res, 403, {error:'ORIGIN_REJECTED'});
        const pairs = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
        const token = pairs.length === 1 ? pairs[0].slice(cookieName.length + 1) : null;
        if (req.method === 'GET' && pathname === '/api/v1/feed') {
          const row=visitors.find(token);
          return respond(res,200,{data:createVisitorFeed({readerId:row?.reader_id||null,likedIds:row?visitors.likes(row):[],now:now?now():Date.now()})});
        }
        if (req.method === 'GET' && pathname === '/api/v1/likes') {
          const row=visitors.find(token);
          return respond(res,row?200:401,row?{data:visitors.likes(row)}:{error:'VISITOR_NOT_FOUND'});
        }
        if (req.method === 'GET' && pathname === '/api/v1/visitors/me') {
          const row = visitors.find(token);
          return respond(res, row ? 200 : 401, row ? {data:visitors.profile(row)} : {error:'VISITOR_NOT_FOUND'});
        }
        if (req.method !== 'POST' || !mutations.has(pathname)) return respond(res, 404, {error:'NOT_FOUND'});
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return respond(res, 415, {error:'JSON_REQUIRED'});
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) return respond(res, 413, {error:'BODY_TOO_LARGE'});
          chunks.push(chunk);
        }
        let input;
        try {input = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {return respond(res, 400, {error:'INVALID_JSON'});}
        if (!input || Array.isArray(input) || typeof input !== 'object') return respond(res, 400, {error:'INVALID_BODY'});
        const expectedKeys = pathname === '/api/v1/likes' ? ['article_id','liked'] : [];
        if (Object.keys(input).some(key => !expectedKeys.includes(key))) return respond(res, 400, {error:'UNKNOWN_FIELD'});
        if (pathname === '/api/v1/likes') {
          const row=visitors.find(token);
          if(!row)return respond(res,401,{error:'VISITOR_NOT_FOUND'});
          if(typeof input.liked !== 'boolean' || typeof input.article_id !== 'string')return respond(res,400,{error:'INVALID_LIKE'});
          if(!articles.some(article=>article.id===input.article_id))return respond(res,404,{error:'ARTICLE_NOT_FOUND'});
          return respond(res,200,{data:visitors.setLike(row,input.article_id,input.liked)});
        }
        if (pathname.endsWith('/bootstrap')) {
          const result = visitors.bootstrap(token);
          const seconds = Math.max(0, Math.floor((Date.parse(result.data.expires_at) - (now ? now() : Date.now())) / 1000));
          res.setHeader('Set-Cookie', cookie(result.token, seconds));
          return respond(res, result.isNew ? 201 : 200, {data:result.data});
        }
        if (pathname.endsWith('/reset')) {
          visitors.remove(token);
          res.setHeader('Set-Cookie', cookie('', 0));
          return respond(res, 200, {data:null});
        }

      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405); return res.end();}
      const decoded = decodeURIComponent(pathname);
      const allowed = decoded === '/' || decoded === '/index.html' || /^\/src\/[a-zA-Z0-9_-]+\.(js|css)$/.test(decoded);
      if (!allowed) {res.writeHead(404); return res.end('Not found');}
      const target = path.join(root, decoded === '/' ? 'index.html' : decoded.slice(1));
      const data = await readFile(target);
      const mime = {'.html':'text/html', '.css':'text/css', '.js':'text/javascript'};
      res.writeHead(200, {'Content-Type':`${mime[path.extname(target)]}; charset=utf-8`, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (error.code === 'ENOENT') {res.writeHead(404); res.end('Not found');}
      else if (!res.headersSent) respond(res, 500, {error:'SERVER_ERROR'});
      else res.end();
    }
  });
  return {server, close:() => visitors.close()};
}
