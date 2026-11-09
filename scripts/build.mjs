import {mkdir,copyFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// Clean only this repository's generated output, including old server files.
const root=new URL('../',import.meta.url);
const output=new URL('dist/',root);
await rm(output,{recursive:true,force:true});
const compile=spawnSync(process.execPath,[fileURLToPath(new URL('node_modules/typescript/bin/tsc',root)),'-p','tsconfig.browser.json'],{cwd:fileURLToPath(root),stdio:'inherit'});
if(compile.status!==0)process.exit(compile.status||1);
await mkdir(new URL('src/',output),{recursive:true});
await copyFile(new URL('index.html',root),new URL('index.html',output));
await copyFile(new URL('src/style.css',root),new URL('src/style.css',output));
console.log('Browser-only deployment ready: dist/');
