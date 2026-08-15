import { type Bid, DNULLA, NULLA, bidName } from '@five-hundred/engine';

/** HUD `<strong>` token: numbered `bidName`, Slam prefix, or lose-all wording. */
export function contractToken(contract: Bid, slam: boolean): string {
  if (contract.kind === NULLA) return 'Nulla 250';
  if (contract.kind === DNULLA) return 'Double Nulla 500';
  return slam ? `Slam ${bidName(contract)}` : bidName(contract);
}
