import {fileURLToPath} from 'node:url';
import {createDevServer} from './server/dev-http.js';
const origin=process.env.PUBLIC_ORIGIN;
const url=process.env.LOGGING_URL,token=process.env.LOGGING_TOKEN,audience=process.env.LOGGING_AUDIENCE;
if(!origin||!url||!token||!audience)throw new Error('GATEWAY_CONFIGURATION_REQUIRED');
if(new URL(origin).protocol!=='https:'||new URL(origin).origin!==origin)throw new Error('GATEWAY_HTTPS_ORIGIN_REQUIRED');
const port=Number(process.env.PORT||4173);
if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('INVALID_GATEWAY_PORT');
// Call FastAPI directly. Routing through news-feed's Nginx would recurse back here.
const server=createDevServer({root:fileURLToPath(new URL('../',import.meta.url)),origin,
 backendBaseUrl:'http://127.0.0.1:8000/',backendApiPrefix:'',gatewayOnly:true,logging:{url,token,audience}});
server.listen(port,process.env.HOST||'0.0.0.0');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
