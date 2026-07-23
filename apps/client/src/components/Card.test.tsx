// @vitest-environment jsdom

/**
 * Foil marking on trump faces (fh-wye): the shared trump test and the class
 * it puts on a face. The sheen itself is CSS (jsdom does no painting), so the
 * observable surface here is exactly which faces carry .card-trump — natural
 * trumps, the left bower, and the joker under a trump contract; nothing under
 * NT/nulla; and never a face-down back.
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JOKER, makeCard } from '@five-hundred/engine';
import { isTrumpCard, trumpFaceClass } from '../lib/trumpMark.ts';
import { CardBack, CardFace } from './Card.tsx';

const HEARTS = 3;
const AH = makeCard(HEARTS, 14);
const JH = makeCard(HEARTS, 11); // right bower under hearts
const JD = makeCard(2, 11); // left bower under hearts
const KS = makeCard(0, 13);

describe('isTrumpCard (fh-wye)', () => {
  it('marks natural trumps, both bowers, and the joker', () => {
    for (const card of [AH, JH, JD, JOKER]) expect(isTrumpCard(card, HEARTS)).toBe(true);
  });

  it('leaves off-suit cards alone', () => {
    expect(isTrumpCard(KS, HEARTS)).toBe(false);
    expect(isTrumpCard(makeCard(2, 14), HEARTS)).toBe(false); // AD is not the left bower
  });

  it('marks nothing under NT/nulla (no trump)', () => {
    for (const card of [AH, JH, JD, KS, JOKER]) expect(isTrumpCard(card, null)).toBe(false);
  });

  it('yields the face class only for trump', () => {
    expect(trumpFaceClass(AH, HEARTS)).toBe('card-trump');
    expect(trumpFaceClass(KS, HEARTS)).toBeUndefined();
    expect(trumpFaceClass(AH, null)).toBeUndefined();
  });
});

describe('CardFace / CardBack foil class', () => {
  it('carries the class onto the face svg, joker included', () => {
    const face = render(<CardFace card={AH} className={trumpFaceClass(AH, HEARTS)} />);
    expect(face.container.querySelector('svg.card')?.classList.contains('card-trump')).toBe(true);
    const joker = render(<CardFace card={JOKER} className={trumpFaceClass(JOKER, HEARTS)} />);
    const jokerSvg = joker.container.querySelector('svg.card');
    expect(jokerSvg?.classList.contains('card-joker')).toBe(true);
    expect(jokerSvg?.classList.contains('card-trump')).toBe(true);
  });

  it('leaves a face-down back unmarked', () => {
    const back = render(<CardBack />);
    const svg = back.container.querySelector('svg.card');
    expect(svg?.classList.contains('card-back')).toBe(true);
    expect(svg?.classList.contains('card-trump')).toBe(false);
  });
});
