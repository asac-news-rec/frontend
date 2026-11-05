import {createHash} from 'node:crypto';
export const digest = text => createHash('sha256').update(text).digest('hex');
export function partitionPath(iso){
 const date=new Date(Date.parse(iso)+9*3600000);
 return `date=${date.toISOString().slice(0,10)}/hour=${String(date.getUTCHours()).padStart(2,'0')}/minute=${String(Math.floor(date.getUTCMinutes()/5)*5).padStart(2,'0')}`;
}
