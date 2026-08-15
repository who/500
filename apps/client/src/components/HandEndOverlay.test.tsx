// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { NULLA, NUM, bid, type HandResult } from '@five-hundred/engine';
import {
  applyEvent,
  botSeatView,
  env,
  gameViewFixture,
  humanSeatView,
  installFakeLocalStorage,
  makeClient,
  renderApp,
  roomViewFixture,
  type TestClient,
} from '../screens/test-helpers.tsx';
import { handEndHeadline } from './HandEndOverlay.tsx';

beforeEach(() => {
  installFakeLocalStorage();
  history.replaceState(null, '', '/');
});

const ROOM = roomViewFixture({
  started: true,
  hostSeat: 0,
  seats: [
    humanSeatView(0, 'Ana'),
    humanSeatView(1, 'Ben'),
    humanSeatView(2, 'Cleo'),
    botSeatView(3, 'hard'),
  ],
});

/** 8H by Cleo (seat 2, viewer's side), made with 8 tricks: +300 / +20. */
const MADE_8H: HandResult = {
  contract: bid(NUM, 8, 3),
  declarer: 2,
  slam: false,
  made: true,
  declarerDelta: 300,
  defenderDelta: 20,
  declarerSideTricks: 8,
  defenderSideTricks: 2,
};

/** Nulla by Ben (seat 1) forced to take 2 tricks: -250, defenders +20. */
const FAILED_NULLA: HandResult = {
  contract: bid(NULLA),
  declarer: 1,
  slam: false,
  made: false,
  declarerDelta: -250,
  defenderDelta: 20,
  declarerSideTricks: 2,
  defenderSideTricks: 8,
};

function renderHandEnd(
  result: HandResult,
  scores: readonly [number, number],
): { client: TestClient; app: ReturnType<typeof renderApp> } {
  const client = makeClient();
  const app = renderApp(client);
  applyEvent(client, env(0, { t: 'roomState', room: ROOM }));
  applyEvent(client, env(1, { t: 'handScored', result, scores: [...scores] as [number, number] }));
  applyEvent(
    client,
    env(2, {
      t: 'gameView',
      view: gameViewFixture(0, {
        phase: 'handScored',
        contract: result.contract,
        declarer: result.declarer,
        handResult: result,
        scores: [...scores] as [number, number],
        toAct: null,
        hand: [],
        sideTricks: [result.declarerSideTricks, result.defenderSideTricks],
        tricksPlayed: 10,
      }),
    }),
  );
  return { client, app };
}

describe('handEndHeadline', () => {
  it('spells out slam and nulla results in words', () => {
    const slam = { ...MADE_8H, slam: true, made: false, declarerDelta: -500 };
    expect(handEndHeadline(slam)).toBe('Slam failed: -500');
    expect(handEndHeadline({ ...slam, made: true, declarerDelta: 500 })).toBe('Slam made: +500');
    expect(handEndHeadline(FAILED_NULLA)).toBe('Nulla failed: -250');
    expect(
      handEndHeadline({ ...FAILED_NULLA, contract: bid('DNULLA'), made: true, declarerDelta: 500 }),
    ).toBe('Double nulla made: +500');
  });

  it('reads made/set for number contracts', () => {
    expect(handEndHeadline(MADE_8H)).toBe('8H made: +300');
    expect(handEndHeadline({ ...MADE_8H, made: false, declarerDelta: -300 })).toBe('8H set: -300');
  });
});

describe('HandEndOverlay', () => {
  it('renders contract, made headline, both deltas, and running totals (AC-1)', () => {
    const { app } = renderHandEnd(MADE_8H, [480, -20]);
    expect(app.getByTestId('hand-end-headline').textContent).toBe('8H made: +300');
    expect(app.getByTestId('hand-end-contract').textContent).toContain('8H by Cleo');
    expect(app.getByTestId('hand-end-contract').textContent).toContain('tricks 8 to 2');
    // Viewer (seat 0) is on the declarer side: Us gets the contract delta.
    expect(app.getByTestId('hand-end-us').textContent).toBe('Us+300 — total 480');
    expect(app.getByTestId('hand-end-them').textContent).toBe('Them+20 — total -20');
  });

  it('shows defender points on a failed lose-all contract (AC-1)', () => {
    // Ben's nulla failed: his side -250, the defenders (viewer's side) score
    // 10 per trick forced onto the bidders.
    const { app } = renderHandEnd(FAILED_NULLA, [40, -210]);
    expect(app.getByTestId('hand-end-headline').textContent).toBe('Nulla failed: -250');
    expect(app.getByTestId('hand-end-contract').textContent).toContain(
      'defenders score 20 for tricks forced on the bidders',
    );
    expect(app.getByTestId('hand-end-us').textContent).toBe('Us+20 — total 40');
    expect(app.getByTestId('hand-end-them').textContent).toBe('Them-250 — total -210');
  });

  it('ticks bots immediately and humans as handReady events land', () => {
    const { client, app } = renderHandEnd(MADE_8H, [480, -20]);
    const ready = app.getByTestId('hand-end-ready');
    const tickedSeats = () =>
      [...ready.querySelectorAll('[data-ready]')].map((el) => el.getAttribute('data-seat'));
    // Only the bot (seat 3) is ready before anyone sends nextHand.
    expect(tickedSeats()).toEqual(['3']);
    expect(app.getByTestId('hand-end-waiting').textContent).toBe('Waiting for Ana, Ben, Cleo');

    applyEvent(client, env(3, { t: 'handReady', ready: [0, 3] }));
    expect(tickedSeats()).toEqual(['0', '3']);
    expect(app.getByTestId('hand-end-waiting').textContent).toBe('Waiting for Ben, Cleo');
  });

  it('sends nextHand once from the Ready button, then locks it', () => {
    const { client, app } = renderHandEnd(MADE_8H, [480, -20]);
    const button = app.getByTestId('hand-end-ready-button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(client.sent).toEqual([{ t: 'nextHand' }]);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(client.sent).toEqual([{ t: 'nextHand' }]);
  });

  it('peeks at the table beneath without losing state, then returns', () => {
    const { app } = renderHandEnd(MADE_8H, [480, -20]);
    fireEvent.click(app.getByTestId('hand-end-peek-button'));
    expect(app.queryByTestId('hand-end-overlay')).toBeNull();
    // The table (final trick beneath) is still mounted while peeking.
    expect(app.container.querySelector('[data-screen="table"]')).not.toBeNull();
    fireEvent.click(app.getByTestId('hand-end-peek').querySelector('button') as HTMLElement);
    expect(app.queryByTestId('hand-end-overlay')).not.toBeNull();
  });

  it('marks a disconnected blocker by name', () => {
    const client = makeClient();
    const app = renderApp(client);
    const room = roomViewFixture({
      started: true,
      hostSeat: 0,
      seats: [
        humanSeatView(0, 'Ana'),
        humanSeatView(1, 'Ben', false),
        botSeatView(2),
        botSeatView(3),
      ],
    });
    applyEvent(client, env(0, { t: 'roomState', room }));
    applyEvent(client, env(1, { t: 'handScored', result: MADE_8H, scores: [480, -20] }));
    applyEvent(
      client,
      env(2, {
        t: 'gameView',
        view: gameViewFixture(0, { phase: 'handScored', handResult: MADE_8H, hand: [] }),
      }),
    );
    const ben = app
      .getByTestId('hand-end-ready')
      .querySelector('[data-seat="1"]') as HTMLElement;
    expect(ben.textContent).toContain('(disconnected)');
    expect(ben.getAttribute('data-ready')).toBeNull();
  });
});
