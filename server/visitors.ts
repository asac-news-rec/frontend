import {DatabaseSync} from 'node:sqlite';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import path from 'node:path';

export interface VisitorRow {token_hash:string;reader_id:string;created_at:number;last_seen_at:number;expires_at:number}

export const lifetimeSeconds = 30 * 24 * 60 * 60;
const hash = (token:string) => createHash('sha256').update(token).digest('hex');

export function openVisitors(database:string, now:()=>number = Date.now) {
  mkdirSync(path.dirname(database), {recursive:true});
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS visitors (
      token_hash TEXT PRIMARY KEY, reader_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );`);
  db.exec(`CREATE TABLE IF NOT EXISTS likes (
    reader_id TEXT NOT NULL REFERENCES visitors(reader_id) ON DELETE CASCADE,
    article_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(reader_id, article_id)
  );`);
  if (db.prepare('PRAGMA table_info(visitors)').all().some(column => column.name === 'interests')) db.exec('ALTER TABLE visitors DROP COLUMN interests');
  const prune = () => db.prepare('DELETE FROM visitors WHERE expires_at <= ?').run(now());
  prune();
  function find(token:string|null):VisitorRow|null {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return db.prepare('SELECT * FROM visitors WHERE token_hash = ? AND expires_at > ?').get(hash(token), now()) as unknown as VisitorRow|null;
  }
  function profile(row:VisitorRow) {
    return {reader_id:row.reader_id, reader_type:'anonymous',
      created_at:new Date(row.created_at).toISOString(), last_seen_at:new Date(row.last_seen_at).toISOString(),
      expires_at:new Date(row.expires_at).toISOString()};
  }
  return {
    find, profile,
    likes(row:VisitorRow):string[] {return db.prepare('SELECT article_id FROM likes WHERE reader_id = ? ORDER BY created_at').all(row.reader_id).map(item => String(item.article_id));},
    setLike(row:VisitorRow, articleId:string, liked:boolean) {
      if (liked) db.prepare('INSERT OR IGNORE INTO likes(reader_id,article_id,created_at) VALUES(?,?,?)').run(row.reader_id,articleId,now());
      else db.prepare('DELETE FROM likes WHERE reader_id = ? AND article_id = ?').run(row.reader_id,articleId);
      return {article_id:articleId, liked};
    },
    bootstrap(token:string|null) {
      prune();
      let row = find(token);
      const isNew = !row;
      if (!row) {
        token = randomBytes(32).toString('base64url');
        const time = now();
        db.prepare('INSERT INTO visitors(token_hash, reader_id, created_at, last_seen_at, expires_at) VALUES(?,?,?,?,?)')
          .run(hash(token), randomUUID(), time, time, time + lifetimeSeconds * 1000);
      } else db.prepare('UPDATE visitors SET last_seen_at = ? WHERE token_hash = ?').run(now(), row.token_hash);
      row = find(token);
      return {token:token!, isNew, data:profile(row!)};
    },
    remove(token:string|null) {if (find(token)) db.prepare('DELETE FROM visitors WHERE token_hash = ?').run(hash(token!));},
    close() {db.close();}
  };
}
