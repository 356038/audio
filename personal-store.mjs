import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';

export class PersonalStore {
  constructor(path) {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    if(path!==':memory:')chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS saved(user_id INTEGER NOT NULL,track_key TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,track_key));
      CREATE TABLE IF NOT EXISTS plays(user_id INTEGER NOT NULL,session_id TEXT NOT NULL,track_key TEXT NOT NULL,payload TEXT NOT NULL,played_at INTEGER NOT NULL,seconds REAL NOT NULL,PRIMARY KEY(user_id,session_id));
      CREATE INDEX IF NOT EXISTS plays_recent ON plays(user_id,played_at DESC);`);
  }
  has(user,id){return Boolean(this.db.prepare('SELECT 1 FROM saved WHERE user_id=? AND track_key=?').get(user,id));}
  ids(user){return this.db.prepare('SELECT track_key FROM saved WHERE user_id=?').all(user).map(r=>r.track_key);}
  save(user,track,saved){
    if(saved)this.db.prepare('INSERT INTO saved VALUES(?,?,?,?) ON CONFLICT(user_id,track_key) DO UPDATE SET payload=excluded.payload').run(user,track.id,JSON.stringify(track),Date.now());
    else this.db.prepare('DELETE FROM saved WHERE user_id=? AND track_key=?').run(user,track.id);
    return saved;
  }
  list(user,offset=0){return this.db.prepare('SELECT payload FROM saved WHERE user_id=? ORDER BY created_at DESC,track_key LIMIT 50 OFFSET ?').all(user,offset).map(r=>JSON.parse(r.payload));}
  count(user){return this.db.prepare('SELECT count(*) AS count FROM saved WHERE user_id=?').get(user).count;}
  record(user,track,session,seconds){
    const result=this.db.prepare('INSERT OR IGNORE INTO plays VALUES(?,?,?,?,?,?)').run(user,session,track.id,JSON.stringify(track),Date.now(),seconds);
    this.db.prepare('DELETE FROM plays WHERE user_id=? AND session_id NOT IN (SELECT session_id FROM plays WHERE user_id=? ORDER BY played_at DESC,rowid DESC LIMIT 100)').run(user,user);
    return Boolean(result.changes);
  }
  recent(user){return this.db.prepare('SELECT payload,max(played_at) AS at FROM plays WHERE user_id=? GROUP BY track_key ORDER BY at DESC LIMIT 15').all(user).map(row=>({...JSON.parse(row.payload),played_at:row.at}));}
  close(){this.db.close();}
}
