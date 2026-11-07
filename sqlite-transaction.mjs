// Savepoints compose: ingestion can run alone or inside a complete reparse.
export function transaction(db, work) {
  db.exec('savepoint feedmerge_write');
  try {
    const result = work();
    db.exec('release feedmerge_write');
    return result;
  } catch (error) {
    db.exec('rollback to feedmerge_write; release feedmerge_write');
    throw error;
  }
}
