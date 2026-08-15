/**
 * Human-readable play-by-play for a GameRecord JSONL.
 *
 *   pnpm --filter @five-hundred/bots exec tsx scripts/summarize-corpus.mts <jsonl>
 *
 * Stdout: one winner line per game. Set FH_PLAY_LOG to also write the full
 * trick listing there (local-sim.sh does this).
 */
import { writeFileSync } from 'node:fs';
import { bidName, cardName } from '../packages/engine/src/index.ts';
import {
  readGameRecordsSync,
  type GameRecord,
  type HandRecord,
} from '../packages/learn/src/index.ts';

const jsonl = process.argv[2];
if (jsonl === undefined || jsonl === '') {
  console.error('usage: summarize-corpus.mts <corpus.jsonl>');
  process.exit(2);
}

const records = readGameRecordsSync(jsonl);
if (records.length === 0) {
  console.log('corpus is empty');
  process.exit(0);
}

function contractLabel(hand: HandRecord): string {
  const bid = hand.result.contract;
  const name = bidName(bid);
  return hand.result.slam ? `Slam ${name}` : name;
}

function formatHand(hand: HandRecord): string[] {
  const r = hand.result;
  const lines = [
    `  hand ${hand.handNumber}  ${contractLabel(hand)} by seat ${r.declarer}` +
      `  ${r.made ? 'made' : 'SET'}  tricks ${r.declarerSideTricks}-${r.defenderSideTricks}` +
      `  Δ ${r.declarerDelta}/${r.defenderDelta}  scores ${hand.scoresAfter[0]}/${hand.scoresAfter[1]}`,
  ];
  hand.tricks.forEach((trick, i) => {
    const plays = trick.plays.map((p) => `s${p.seat}:${cardName(p.card)}`).join(' ');
    lines.push(`    T${i} ${plays}  winner=s${trick.winner}`);
  });
  return lines;
}

function formatGame(rec: GameRecord): { summary: string; body: string } {
  const kinds = rec.players.map((p) => `s${p.seat}=${p.kind}`).join(' ');
  const winner =
    rec.winner === null
      ? 'undecided'
      : `side${rec.winner} (seats ${rec.winner}+${rec.winner + 2})`;
  const summary =
    `game ${rec.gameId}  winner=${winner}  scores=[${rec.finalScores[0]},${rec.finalScores[1]}]` +
    `  hands=${rec.hands.length}  ${kinds}`;
  const body = [summary, ...rec.hands.flatMap(formatHand)].join('\n');
  return { summary, body };
}

const blocks: string[] = [];
for (const rec of records) {
  const { summary, body } = formatGame(rec);
  console.log(summary);
  blocks.push(body);
}

const playLog = process.env.FH_PLAY_LOG;
if (playLog !== undefined && playLog !== '') {
  writeFileSync(playLog, `${blocks.join('\n\n')}\n`);
  console.log(`play-by-play -> ${playLog}`);
}
