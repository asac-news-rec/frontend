export const readerStorageKey = 'sai-news.reader_id';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getPersistentReaderId({storage, generate=()=>crypto.randomUUID(), locks=globalThis.window?.navigator?.locks}={}) {
  const readOrCreate = () => {
    try {
      const target=storage ?? globalThis.window?.localStorage;
      if(!target)throw new Error('NO_STORAGE');
      const stored=target.getItem(readerStorageKey);
      if(stored!==null){
        if(!uuid.test(stored))throw new Error('INVALID_STORED_READER');
        return stored;
      }
      const id=generate();
      if(!uuid.test(id))throw new Error('INVALID_READER');
      target.setItem(readerStorageKey,id);
      if(target.getItem(readerStorageKey)!==id)throw new Error('READER_NOT_STORED');
      return id;
    } catch {
      throw new Error('독자 정보를 유지할 수 없습니다. 브라우저의 사이트 저장소 설정을 확인해 주세요.');
    }
  };
  return locks ? locks.request('sai-news-reader-identity',async()=>readOrCreate()) : readOrCreate();
}
