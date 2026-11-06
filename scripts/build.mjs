import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await copyFile('index.html','dist/index.html');
await copyFile('src/style.css','dist/src/style.css');
console.log('Static build ready: dist/');
