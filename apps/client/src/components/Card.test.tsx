// @vitest-environment jsdom

/**
 * Cream-gold marking on trump faces (fh-8z0): the shared trump test and the
 * class it puts on a face. The tint itself is CSS (jsdom does no painting),
 * so the observable surface here is exactly which faces carry .card-trump —
 * natural trumps, the left bower, and the joker under a trump contract;
 * nothing under NT/nulla; and never a face-down back. There is no foil layer.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { JOKER, makeCard } from '@five-hundred/engine';
import { isTrumpCard, trumpFaceClass } from '../lib/trumpMark.ts';
import { CardBack, CardFace } from './Card.tsx';

const CSS = readFileSync(join(import.meta.dirname, '../App.css'), 'utf8');

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

describe('CardFace / CardBack trump class', () => {
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

  /* Membership is the class; the cream-gold fill is CSS on .card-ground.
     There is no foil layer to pin. */
  it('keeps the trump class and has no foil sheen markup', () => {
    const face = render(<CardFace card={AH} className={trumpFaceClass(AH, HEARTS)} />);
    const svg = face.container.querySelector('svg.card') as SVGElement;
    expect(svg.classList.contains('card-trump')).toBe(true);
    expect(svg.querySelector('.card-ground')).not.toBeNull();
    expect(svg.querySelector('.card-foil')).toBeNull();
    expect(svg.querySelector('.card-foil-sheen')).toBeNull();
  });

  it('leaves a non-trump face unmarked and without foil markup', () => {
    const face = render(<CardFace card={KS} className={trumpFaceClass(KS, HEARTS)} />);
    const svg = face.container.querySelector('svg.card') as SVGElement;
    expect(svg.classList.contains('card-trump')).toBe(false);
    expect(svg.querySelector('.card-foil')).toBeNull();
  });
});

describe('CardFace suit sizes stay on the px rules (fh-ba7)', () => {
  let style: HTMLStyleElement;
  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
  });
  afterEach(() => {
    style.remove();
  });

  it('does not put suit-glyph on SVG text, so .card-pip stays 38px', () => {
    const face = render(<CardFace card={AH} />);
    const pip = face.container.querySelector('.card-pip') as SVGTextElement;
    const corner = face.container.querySelector('.card-corner-suit') as SVGTextElement;
    expect(pip.classList.contains('suit-glyph')).toBe(false);
    expect(corner.classList.contains('suit-glyph')).toBe(false);
    expect(pip.classList.contains('suit-red')).toBe(true);
    expect(corner.classList.contains('suit-red')).toBe(true);
    expect(getComputedStyle(pip).fontSize).toBe('38px');
    expect(getComputedStyle(corner).fontSize).toBe('18px');

    // The chrome bump is scoped to HTML spans so it cannot override those px rules.
    expect(CSS).toMatch(/span\.suit-glyph \{[^}]*font-size: 1\.12em;/);
    expect(CSS).not.toMatch(/(?<!span)\.suit-glyph \{[^}]*font-size:/);
  });
});
