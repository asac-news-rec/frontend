// Compatibility entry point: npm start now launches the FastAPI service.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const child=spawn(process.env.LOGGING_PYTHON||'python',['-m','logging_service'],{
 cwd:fileURLToPath(new URL('.',import.meta.url)),stdio:'inherit',env:process.env
});
child.on('error',error=>{console.error('Python service could not start:',error.code);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(!child.killed)child.kill(signal);});
