import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Conversation, DrawingScene, HistoryTurn, Retention, SearchHit } from '../shared/app'

const EMPTY_SCENE: DrawingScene = { version: 1, beats: [] }

export class HistoryRepository {
  readonly db: DatabaseSync
  constructor(path = ':memory:') {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      closeSync(openSync(path, 'a', 0o600))
      chmodSync(path, 0o600)
    }
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;')
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version > 1) throw new Error('This history was created by a newer NimboGuide version.')
    if (version < 1) this.db.exec(`
      BEGIN;
      CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE turns(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, created INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('voice','text')), question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL CHECK(state IN ('complete','interrupted','error')), error TEXT, scene TEXT NOT NULL, screen_context_used INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX turns_conversation ON turns(conversation_id, created);
      CREATE VIRTUAL TABLE turn_search USING fts5(title, question, answer, conversation_id UNINDEXED, turn_id UNINDEXED);
      CREATE TRIGGER turn_insert AFTER INSERT ON turns BEGIN
        INSERT INTO turn_search VALUES((SELECT title FROM conversations WHERE id=new.conversation_id),new.question,new.answer,new.conversation_id,new.id);
      END;
      CREATE TRIGGER turn_update AFTER UPDATE ON turns BEGIN
        DELETE FROM turn_search WHERE turn_id=old.id;
        INSERT INTO turn_search VALUES((SELECT title FROM conversations WHERE id=new.conversation_id),new.question,new.answer,new.conversation_id,new.id);
      END;
      CREATE TRIGGER turn_delete AFTER DELETE ON turns BEGIN DELETE FROM turn_search WHERE turn_id=old.id; END;
      CREATE TRIGGER conversation_title AFTER UPDATE OF title ON conversations BEGIN UPDATE turn_search SET title=new.title WHERE conversation_id=new.id; END;
      PRAGMA user_version=1;
      COMMIT;
    `)
  }
  create(now = Date.now()): string {
    const id = randomUUID()
    this.db.prepare('INSERT INTO conversations(id,title,created,updated) VALUES(?,?,?,?)').run(id, 'New conversation', now, now)
    return id
  }
  list(): Conversation[] {
    const rows = this.db.prepare(`SELECT c.*, COALESCE((SELECT CASE WHEN answer='' THEN question ELSE answer END FROM turns WHERE conversation_id=c.id ORDER BY created DESC,rowid DESC LIMIT 1),'') AS preview
      FROM conversations c WHERE archived=0 ORDER BY pinned DESC, updated DESC, rowid DESC`).all()
    return rows.map(row => ({ ...row, pinned: Boolean(row.pinned), archived: Boolean(row.archived) })) as unknown as Conversation[]
  }
  exists(id: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(id)) }
  turns(id: string): HistoryTurn[] {
    return this.db.prepare('SELECT * FROM turns WHERE conversation_id=? ORDER BY created,rowid').all(id).map(row => ({
      id: String(row.id), conversationId: String(row.conversation_id), created: Number(row.created), mode: row.mode,
      question: String(row.question), answer: String(row.answer), state: row.state, error: row.error,
      scene: JSON.parse(String(row.scene)), screenContextUsed: Boolean(row.screen_context_used),
    })) as HistoryTurn[]
  }
  begin(conversationId: string, question: string, mode: HistoryTurn['mode'], now = Date.now()): string {
    const id = randomUUID()
    this.db.exec('BEGIN')
    try {
      const first = !this.db.prepare('SELECT 1 FROM turns WHERE conversation_id=? LIMIT 1').get(conversationId)
      if (first) this.rename(conversationId, question.trim().slice(0, 100))
      this.db.prepare(`INSERT INTO turns(id,conversation_id,created,mode,question,state,scene) VALUES(?,?,?,?,?,'interrupted',?)`).run(id, conversationId, now, mode, question, JSON.stringify(EMPTY_SCENE))
      this.db.prepare('UPDATE conversations SET updated=? WHERE id=?').run(now, conversationId)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return id
  }
  update(id: string, answer: string, scene: DrawingScene, screenUsed: boolean): void {
    this.db.prepare('UPDATE turns SET answer=?,scene=?,screen_context_used=? WHERE id=?').run(answer, JSON.stringify(scene), Number(screenUsed), id)
  }
  finish(id: string, state: HistoryTurn['state'], error: string | null = null): void {
    this.db.prepare('UPDATE turns SET state=?,error=? WHERE id=?').run(state, error, id)
  }
  rename(id: string, title: string): void { this.db.prepare('UPDATE conversations SET title=? WHERE id=?').run(title.trim().slice(0, 100) || 'Untitled conversation', id) }
  pin(id: string, pinned: boolean): void { this.db.prepare('UPDATE conversations SET pinned=? WHERE id=?').run(Number(pinned), id) }
  delete(id: string): void { this.db.prepare('DELETE FROM conversations WHERE id=?').run(id); this.checkpoint() }
  deleteAll(): void { this.db.exec('DELETE FROM conversations'); this.checkpoint() }
  search(query: string): SearchHit[] {
    const words = query.trim().match(/[\p{L}\p{N}]+/gu)
    if (!words?.length) return []
    const match = words.map(word => `"${word}"*`).join(' AND ')
    return this.db.prepare(`SELECT conversation_id AS conversationId,turn_id AS turnId,title,snippet(turn_search,-1,'[',']','…',20) AS snippet
      FROM turn_search WHERE turn_search MATCH ? ORDER BY rank LIMIT 100`).all(match) as unknown as SearchHit[]
  }
  prune(retention: Retention, now = Date.now()): void {
    if (retention === 0 || retention === 'forever') return
    this.db.prepare('DELETE FROM conversations WHERE updated < ?').run(now - retention * 86400000)
    this.checkpoint()
  }
  private checkpoint(): void { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') }
  close(): void { this.checkpoint(); this.db.close() }
}
