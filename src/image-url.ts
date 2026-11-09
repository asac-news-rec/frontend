// Match the backend's web/app.js imageURL: only legacy local :8001 URLs
// are mapped to its existing Nginx /images/ route.
export function backendImageUrl(value?:string|null,origin=globalThis.location?.origin??'http://localhost'):string|null {
  if(!value)return null;
  try {
    const url=new URL(value,origin);
    if(!['http:','https:'].includes(url.protocol))return null;
    if(['localhost','127.0.0.1'].includes(url.hostname)&&url.port==='8001')return `/images${url.pathname}${url.search}`;
    return value;
  } catch {return null;}
}
