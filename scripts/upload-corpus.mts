/**
 * putGame every GameRecord in a JSONL into the env-configured store.
 *
 *   FH_UPLOAD_JSONL=/path/to/games.jsonl tsx scripts/upload-corpus.mts
 */
import { createGameStore, readGameRecordsSync } from '../packages/learn/src/index.ts';

const file = process.env.FH_UPLOAD_JSONL;
if (file === undefined || file === '') {
  console.error('FH_UPLOAD_JSONL is unset');
  process.exit(2);
}
const store = createGameStore(process.env);
if (store === null) {
  console.error(
    'no game store: AWS_ENDPOINT_URL / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_S3_BUCKET_NAME / AWS_DEFAULT_REGION must all be set',
  );
  process.exit(1);
}
const records = readGameRecordsSync(file);
for (const rec of records) {
  await store.putGame(rec);
}
console.log(`uploaded ${records.length} games to store`);
