import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {articles} from '../src/data.js';

const personas=JSON.parse(readFileSync(fileURLToPath(new URL('../examples/synthetic-personas.json',import.meta.url)),'utf8'));
const candidateArticles=articles.map((article,index)=>({article_id:article.id,position:index+1,title:article.title}));
console.log(JSON.stringify(personas.map(({reader_id,persona})=>({reader_id,persona,articles:candidateArticles})),null,2));
