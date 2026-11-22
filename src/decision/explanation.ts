import { compare, rank, suit } from "../core";
import type { DecisionObservation } from "./engine";

type HandObservation = Pick<
  DecisionObservation,
  "heroCards" | "board" | "street"
>;
type Category = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Facts from this player's cards and the visible board, never hidden cards. */
export interface DecisionHandSummary {
  category: Category;
  madeText: string;
  drawText?: string;
  protectionCandidate: boolean;
  straightDrawOuts: number;
  flushDrawOuts: number;
  boardOnly: boolean;
  hasPair: boolean;
}

const label = (value: number) => "23456789TJQKA"[value - 2] ?? "?";
const ranks = (cards: readonly number[]) => cards.map(rank);
const countRanks = (cards: readonly number[]) => {
  const counts = new Map<number, number>();
  for (const card of cards)
    counts.set(rank(card), (counts.get(rank(card)) ?? 0) + 1);
  return counts;
};
function straightHigh(values: readonly number[]): number {
  const distinct = new Set(values);
  if (distinct.has(14)) distinct.add(1);
  for (let high = 14; high >= 5; high--)
    if ([0, 1, 2, 3, 4].every((n) => distinct.has(high - n))) return high;
  return 0;
}

/** The same best-five ordering as core.evaluate, also accepting five/six cards. */
function value(cards: readonly number[]): number[] {
  const counts = countRanks(cards);
  const distinct = [...counts.keys()].sort((a, b) => b - a);
  const flush = [0, 1, 2, 3]
    .map((s) => cards.filter((card) => suit(card) === s))
    .find((group) => group.length >= 5);
  if (flush) {
    const high = straightHigh(ranks(flush));
    if (high) return [8, high];
  }
  const quads = distinct.find((r) => counts.get(r) === 4);
  if (quads) return [7, quads, distinct.find((r) => r !== quads)!];
  const trips = distinct.filter((r) => counts.get(r)! >= 3);
  if (trips.length) {
    const pair = distinct.find((r) => r !== trips[0] && counts.get(r)! >= 2);
    if (pair) return [6, trips[0], pair];
  }
  if (flush)
    return [
      5,
      ...ranks(flush)
        .sort((a, b) => b - a)
        .slice(0, 5),
    ];
  const high = straightHigh(distinct);
  if (high) return [4, high];
  if (trips.length)
    return [3, trips[0], ...distinct.filter((r) => r !== trips[0]).slice(0, 2)];
  const pairs = distinct.filter((r) => counts.get(r)! >= 2);
  if (pairs.length >= 2)
    return [
      2,
      ...pairs.slice(0, 2),
      distinct.find((r) => !pairs.slice(0, 2).includes(r))!,
    ];
  if (pairs.length)
    return [1, pairs[0], ...distinct.filter((r) => r !== pairs[0]).slice(0, 3)];
  return [0, ...distinct.slice(0, 5)];
}

function highestPossibleFlush(
  heroCards: readonly number[],
  board: readonly number[],
  current: readonly number[],
): boolean {
  const used = new Set([...heroCards, ...board]);
  // Only flushes in the already completed suit can outrank a made flush.
  const flushSuit = [0, 1, 2, 3].find(
    (s) => [...heroCards, ...board].filter((c) => suit(c) === s).length >= 5,
  )!;
  const available = Array.from({ length: 52 }, (_, c) => c).filter(
    (c) => !used.has(c) && suit(c) === flushSuit,
  );
  // The two highest unavailable-to-hero suited cards give the strongest
  // possible opposing flush. Board cards and our own cards remain blocked.
  const strongest = available.sort((a, b) => rank(b) - rank(a)).slice(0, 2);
  const opposingFlush = [...board, ...strongest].filter(
    (c) => suit(c) === flushSuit,
  );
  if (opposingFlush.length < 5) return true;
  return (
    compare(
      current.slice(1),
      ranks(opposingFlush)
        .sort((a, b) => b - a)
        .slice(0, 5),
    ) >= 0
  );
}

function madeDescription(
  o: HandObservation,
  hand: readonly number[],
  boardOnly: boolean,
) {
  const own = ranks(o.heroCards);
  const br = ranks(o.board);
  const boardCounts = countRanks(o.board);
  const pocket = own.length === 2 && own[0] === own[1];
  const category = hand[0];
  const pairLabel = (r: number) => `${label(r)}${label(r)}`;
  if (boardOnly)
    return [
      "Лучшая старшая карта лежит на борде; ваши карты её не усиливают",
      "Пара на борде общая; ваши карты не улучшают лучшие пять карт",
      "Две пары на борде общие; ваши карты не улучшают лучшие пять карт",
      "Тройка на борде общая; ваши карты не улучшают лучшие пять карт",
      "Стрит на борде общий; ваши карты его не усиливают",
      "Флеш на борде общий; ваши карты его не усиливают",
      "Фулл-хаус на борде общий",
      "Каре на борде общее; ваши карты не улучшают кикер",
      "Стрит-флеш на борде общий",
    ][category];
  switch (category) {
    case 0:
      return "Сейчас нет пары";
    case 1:
      if (pocket) {
        const higher = Math.max(...br);
        return `Карманная пара ${pairLabel(own[0])}${higher > own[0] ? ` ниже ${label(higher)} на борде` : br.length ? ": оверпара" : ""}`;
      }
      if ((boardCounts.get(hand[1]) ?? 0) >= 2)
        return `Пара ${pairLabel(hand[1])} на борде общая; своей пары у вас нет`;
      return `Пара ${pairLabel(hand[1])}${hand[1] === Math.max(...br) ? ": топ-пара" : ""}`;
    case 2:
      if (pocket && hand.slice(1, 3).includes(own[0])) {
        const shared = hand.slice(1, 3).find((r) => r !== own[0])!;
        return `Карманная пара ${pairLabel(own[0])}${shared > own[0] ? ` ниже ${pairLabel(shared)} на борде` : ""}; пара ${pairLabel(shared)} на борде общая`;
      }
      if (hand.slice(1, 3).every((r) => (boardCounts.get(r) ?? 0) >= 2))
        return `Две пары ${pairLabel(hand[1])} и ${pairLabel(hand[2])} на борде общие`;
      {
        const shared = hand
          .slice(1, 3)
          .find((r) => (boardCounts.get(r) ?? 0) >= 2);
        if (shared) {
          const personal = hand.slice(1, 3).find((r) => r !== shared)!;
          return `Пара ${pairLabel(personal)} с вашей картой; пара ${pairLabel(shared)} на борде общая`;
        }
      }
      return `Две пары: ${pairLabel(hand[1])} и ${pairLabel(hand[2])}`;
    case 3:
      return `${pocket && own[0] === hand[1] ? "Сет" : (boardCounts.get(hand[1]) ?? 0) >= 3 ? "Общая тройка на борде:" : "Тройка"} ${label(hand[1])}${label(hand[1])}${label(hand[1])}`;
    case 4:
      return `Готовый стрит до ${label(hand[1])}`;
    case 5:
      return highestPossibleFlush(o.heroCards, o.board, hand)
        ? "Готов старший возможный флеш"
        : "Готовый флеш";
    case 6:
      return `Фулл-хаус: ${label(hand[1])}${label(hand[1])}${label(hand[1])}${pairLabel(hand[2])}`;
    case 7:
      return (boardCounts.get(hand[1]) ?? 0) === 4
        ? `Каре ${label(hand[1])}${label(hand[1])}${label(hand[1])}${label(hand[1])} на борде общее; ваш кикер ${label(hand[2])}`
        : `Каре ${label(hand[1])}${label(hand[1])}${label(hand[1])}${label(hand[1])}`;
    default:
      return `Готовый стрит-флеш до ${label(hand[1])}`;
  }
}

export function summarizeDecisionHand(o: HandObservation): DecisionHandSummary {
  const cards = [...o.heroCards, ...o.board];
  const current = value(cards);
  const category = current[0] as Category;
  const boardOnly =
    o.board.length === 5 && compare(current, value(o.board)) === 0;
  const madeText = madeDescription(o, current, boardOnly);
  const future = o.street === "flop" || o.street === "turn";
  let straightDrawOuts = 0;
  let flushDrawOuts = 0;
  const parts: string[] = [];
  const known = new Set(cards);
  if (future && category < 4) {
    const completing = Array.from({ length: 52 }, (_, c) => c).filter(
      (card) => {
        if (known.has(card)) return false;
        const high = straightHigh(ranks([...cards, card]));
        return high > 0 && high > straightHigh(ranks([...o.board, card]));
      },
    );
    straightDrawOuts = completing.length;
    if (straightDrawOuts) {
      const needed = [...new Set(ranks(completing))].sort((a, b) => a - b);
      const present = new Set(ranks(cards));
      if (present.has(14)) present.add(1);
      const open =
        needed.length === 2 &&
        Array.from({ length: 10 }, (_, i) => i + 2).some(
          (low) =>
            [0, 1, 2, 3].every((n) => present.has(low + n)) &&
            needed.includes(low - 1 === 1 ? 14 : low - 1) &&
            needed.includes(low + 4),
        );
      const name =
        needed.length === 1
          ? "Гатшот"
          : open
            ? "Двустороннее стрит-дро"
            : "Двойной гатшот";
      parts.push(
        `${name}: ${needed.map(label).join(" или ")} завершает стрит (${straightDrawOuts} ${straightDrawOuts === 4 ? "карты" : "карт"})`,
      );
    }
  }
  if (future && category < 5) {
    const drawSuit = [0, 1, 2, 3].find(
      (s) =>
        cards.filter((c) => suit(c) === s).length === 4 &&
        o.heroCards.some((c) => suit(c) === s),
    );
    if (drawSuit !== undefined) {
      flushDrawOuts = 13 - cards.filter((c) => suit(c) === drawSuit).length;
      parts.push(`Флеш-дро: ${flushDrawOuts} карт завершают флеш`);
    } else if (
      o.street === "flop" &&
      [0, 1, 2, 3].some(
        (s) =>
          cards.filter((c) => suit(c) === s).length === 3 &&
          o.heroCards.some((c) => suit(c) === s),
      )
    )
      parts.push("бэкдорный флеш требует двух подходящих карт подряд");
  }
  const own = ranks(o.heroCards);
  const boardCounts = countRanks(o.board);
  const playingPairs = current.slice(1, category === 2 ? 3 : 2);
  const ownPair =
    own.length === 2 &&
    playingPairs.some(
      (r) =>
        own.includes(r) &&
        (own[0] === own[1] || o.board.some((c) => rank(c) === r)),
    );
  // A shared board pair is not itself a hero holding needing protection.
  const protectionCandidate =
    future &&
    category >= 1 &&
    category <= 2 &&
    ownPair &&
    !boardOnly &&
    ![...boardCounts.values()].some((count) => count >= 3);
  return {
    category,
    madeText,
    drawText: parts.length
      ? `${parts.join("; ")}; эти карты не гарантируют победу`
      : undefined,
    protectionCandidate,
    straightDrawOuts,
    flushDrawOuts,
    boardOnly,
    hasPair:
      category >= 1 && category !== 4 && category !== 5 && category !== 8,
  };
}

export function describeDecisionHand(o: HandObservation): string {
  const summary = summarizeDecisionHand(o);
  return `${summary.madeText}.${summary.drawText ? ` ${summary.drawText}.` : ""}`;
}
