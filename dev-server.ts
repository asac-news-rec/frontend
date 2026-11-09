import {fileURLToPath} from 'node:url';
import {createDevServer} from './server/dev-http.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const port=Number(process.env.PORT||4173);
const origin=process.env.PUBLIC_ORIGIN||`http://127.0.0.1:${port}`;
const server=createDevServer({root,origin,backendBaseUrl:process.env.NEWS_BACKEND_URL||'http://127.0.0.1:8000/'});
server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`Local frontend: ${origin}`));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
