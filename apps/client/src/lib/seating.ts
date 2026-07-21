/**
 * Relative seat placement: the viewer anchors the bottom, their partner
 * the top, opponents left and right — the same convention the lobby uses.
 */

export const SEAT_POSITIONS = ['bottom', 'left', 'top', 'right'] as const;

export type SeatPosition = (typeof SEAT_POSITIONS)[number];

export function seatPosition(seat: number, anchor: number): SeatPosition {
  return SEAT_POSITIONS[(((seat - anchor) % 4) + 4) % 4] as SeatPosition;
}
