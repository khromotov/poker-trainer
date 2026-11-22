import { seeded } from "../core";
import { combinationsFor, preflopMatrix } from "./hands";
import type { Action } from "./provider";

/** This is an explicit opponent-policy/checkdown model, not an equilibrium solver. */
export interface ModelPlayer {
  id: string;
  seat: number;
  stack: number;
  committed: number;
  streetCommitted: number;
  folded: boolean;
  allIn: boolean;
}
export interface ModelAction {
  playerId: string;
  type: string;
  total: number;
  paid: number;
}
export interface ModelContext {
  id?: string;
  heroId: string;
  heroSeat: number;
  dealerSeat: number;
  players: ModelPlayer[];
  actions: ModelAction[];
  smallBlind: number;
  bigBlind: number;
  ante: number;
  currentBet: number;
  minRaise: number;
  samples?: number;
  seed: number;
}
export interface HandAdvice {
  action: Action;
  raiseTo?: number;
  equity: number;
  ev: Partial<Record<Action, number>>;
  /** Monte Carlo standard error in chips, not strategic-model error. */
  error: number;
  uncertain: boolean;
}
export interface ModelResult {
  hands: Record<string, HandAdvice>;
  assumptions: string[];
  source: string;
  samples: number;
}

type Combo = { cards: [number, number]; type: string; strength: number };
type Candidate = { action: Action; total: number; cost: number };
const TYPES = preflopMatrix().flat();
const RANKS = "23456789TJQKA";
const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-clamp(x, -40, 40)));

/** Authored ordering only: percentiles below are NOT hand equity. */
function authoredStrength(type: string): number {
  const h = RANKS.indexOf(type[0]) + 2,
    l = RANKS.indexOf(type[1]) + 2;
  if (h === l) return 36 + h * 3.8;
  const gap = h - l - 1;
  return (
    h * 3 +
    l * 1.4 +
    (type[2] === "s" ? 5 : 0) +
    (gap === 0 ? 3 : gap === 1 ? 1.5 : 0) +
    (h === 14 ? 5 : 0) -
    Math.max(0, gap - 2) * 0.65
  );
}
const ORDERED = TYPES.slice().sort(
  (a, b) => authoredStrength(a) - authoredStrength(b),
);
const STRENGTH = new Map<string, number>();
let cumulative = 0;
for (const type of ORDERED) {
  const n = combinationsFor(type);
  STRENGTH.set(type, (cumulative + n / 2) / 1326);
  cumulative += n;
}
const COMBOS: Combo[] = [];
const BY_TYPE = new Map<string, Combo[]>();
for (let a = 0; a < 52; a++)
  for (let b = a + 1; b < 52; b++) {
    const ar = Math.floor(a / 4),
      br = Math.floor(b / 4),
      h = Math.max(ar, br),
      l = Math.min(ar, br);
    const type =
      RANKS[h] + RANKS[l] + (h === l ? "" : a % 4 === b % 4 ? "s" : "o");
    const combo: Combo = { cards: [a, b], type, strength: STRENGTH.get(type)! };
    COMBOS.push(combo);
    if (!BY_TYPE.has(type)) BY_TYPE.set(type, []);
    BY_TYPE.get(type)!.push(combo);
  }

function validateContext(c: ModelContext): void {
  if (
    !c ||
    !Array.isArray(c.players) ||
    c.players.length < 2 ||
    c.players.length > 10 ||
    !Array.isArray(c.actions) ||
    c.actions.length > 300
  )
    throw Error("Нужно от 2 до 10 игроков и корректная история префлопа.");
  const amount = (x: number) =>
    Number.isFinite(x) && Number.isSafeInteger(x) && x >= 0;
  if (
    !amount(c.smallBlind) ||
    !amount(c.bigBlind) ||
    c.smallBlind < 1 ||
    c.bigBlind < c.smallBlind ||
    !amount(c.ante) ||
    !amount(c.currentBet) ||
    !amount(c.minRaise) ||
    c.minRaise < 1 ||
    !Number.isInteger(c.seed)
  )
    throw Error("Некорректные блайнды, ставка или seed.");
  if (
    c.samples !== undefined &&
    (!Number.isInteger(c.samples) || c.samples < 50 || c.samples > 1000)
  )
    throw Error("Выберите от 50 до 1000 выборок на руку.");
  const ids = new Set<string>(),
    seats = new Set<number>();
  for (const p of c.players) {
    if (
      typeof p.id !== "string" ||
      !p.id ||
      ids.has(p.id) ||
      !Number.isInteger(p.seat) ||
      p.seat < 0 ||
      p.seat > 9 ||
      seats.has(p.seat) ||
      ![p.stack, p.committed, p.streetCommitted].every(amount) ||
      p.committed < p.streetCommitted ||
      p.streetCommitted > c.currentBet ||
      typeof p.folded !== "boolean" ||
      typeof p.allIn !== "boolean" ||
      (p.allIn && p.stack !== 0)
    )
      throw Error("Некорректные игроки, стеки или вклады.");
    ids.add(p.id);
    seats.add(p.seat);
  }
  if (
    !Number.isSafeInteger(
      c.players.reduce((sum, p) => sum + p.stack + p.committed, 0),
    )
  )
    throw Error("Сумма фишек слишком велика для точного учёта.");
  const hero = c.players.find((p) => p.id === c.heroId);
  if (
    !hero ||
    hero.seat !== c.heroSeat ||
    hero.folded ||
    hero.allIn ||
    hero.stack === 0 ||
    !seats.has(c.dealerSeat)
  )
    throw Error("Для матрицы нужен активный игрок со стеком и позиция дилера.");
  for (const a of c.actions)
    if (
      !ids.has(a.playerId) ||
      !amount(a.total) ||
      !amount(a.paid) ||
      ![
        "fold",
        "check",
        "call",
        "raise",
        "all-in",
        "small-blind",
        "big-blind",
        "ante",
      ].includes(a.type)
    )
      throw Error("Некорректная история действий.");
}

function openingFraction(c: ModelContext, p: ModelPlayer): number {
  const seats = c.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => p.seat),
    d = seats.indexOf(c.dealerSeat);
  const distance = (seats.indexOf(p.seat) - d + seats.length) % seats.length;
  if (seats.length === 2) return p.seat === c.dealerSeat ? 0.48 : 0.38;
  if (distance === 0) return 0.42;
  if (distance === 1) return 0.37;
  if (distance === 2) return 0.32;
  const early = (distance - 3) / Math.max(1, seats.length - 3);
  return 0.12 + 0.22 * early;
}

/** Posterior weights = prior physical-combo weight × authored action likelihoods. */
function rangeCdf(c: ModelContext, p: ModelPlayer): Float64Array {
  const likelihoods: Array<(combo: Combo) => number> = [];
  let raises = 0,
    previousBet = c.bigBlind;
  for (const a of c.actions) {
    const aggressive =
      (a.type === "raise" || a.type === "all-in") && a.total > previousBet;
    if (a.playerId === p.id) {
      if (aggressive) {
        let fraction =
          raises === 0
            ? openingFraction(c, p)
            : raises === 1
              ? 0.085
              : raises === 2
                ? 0.035
                : 0.018;
        const startStack = p.stack + p.committed;
        if (a.type === "all-in" && startStack / c.bigBlind <= 18)
          fraction = clamp(openingFraction(c, p) * 0.8, 0.1, 0.4);
        else fraction /= 1 + Math.max(0, a.total / c.bigBlind - 3) * 0.015;
        const cut = 1 - fraction;
        likelihoods.push(
          (combo) => 0.002 + 0.998 * sigmoid((combo.strength - cut) / 0.035),
        );
      } else if (a.type === "call" || a.type === "all-in") {
        const fraction =
          raises === 0
            ? 0.46
            : raises === 1
              ? 0.27
              : raises === 2
                ? 0.12
                : 0.055;
        likelihoods.push(
          (combo) =>
            0.008 + 0.992 * sigmoid((combo.strength - (1 - fraction)) / 0.065),
        );
      }
    }
    if (aggressive) {
      raises++;
      previousBet = a.total;
    }
  }
  const cdf = new Float64Array(COMBOS.length);
  let total = 0;
  COMBOS.forEach((combo, i) => {
    let w = 1;
    for (const f of likelihoods) w *= f(combo);
    total += w;
    cdf[i] = total;
  });
  return cdf;
}
function drawCombo(
  cdf: Float64Array,
  used: Uint8Array,
  random: () => number,
): Combo {
  // Conditioning each draw on removed cards keeps every sampled deal physically valid.
  for (let tries = 0; tries < 10000; tries++) {
    const x = random() * cdf[cdf.length - 1];
    let lo = 0,
      hi = cdf.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (cdf[m] < x) lo = m + 1;
      else hi = m;
    }
    const combo = COMBOS[lo];
    if (!used[combo.cards[0]] && !used[combo.cards[1]]) return combo;
  }
  throw Error("Не удалось выбрать непересекающиеся руки.");
}

function raiseCount(c: ModelContext): number {
  let n = 0,
    bet = c.bigBlind;
  for (const a of c.actions)
    if ((a.type === "raise" || a.type === "all-in") && a.total > bet) {
      n++;
      bet = a.total;
    }
  return n;
}
export function legalCandidates(c: ModelContext): Candidate[] {
  validateContext(c);
  const hero = c.players.find((p) => p.id === c.heroId)!,
    max = hero.streetCommitted + hero.stack;
  const call = Math.min(
    Math.max(0, c.currentBet - hero.streetCommitted),
    hero.stack,
  );
  const result: Candidate[] =
    call > 0
      ? [
          { action: "fold", total: hero.streetCommitted, cost: 0 },
          {
            action: call === hero.stack ? "all-in" : "call",
            total: hero.streetCommitted + call,
            cost: call,
          },
        ]
      : [{ action: "check", total: hero.streetCommitted, cost: 0 }];
  if (
    !c.players.some(
      (p) => p.id !== hero.id && !p.folded && !p.allIn && p.stack > 0,
    )
  )
    return result;
  const lastHero = c.actions
    .slice()
    .reverse()
    .find(
      (a) =>
        a.playerId === hero.id &&
        ["check", "call", "raise", "all-in"].includes(a.type),
    );
  const reopened =
    !lastHero ||
    (lastHero.type === "check" && lastHero.total === 0) ||
    c.currentBet - lastHero.total >= c.minRaise;
  if (max <= c.currentBet || !reopened) return result;
  const min = c.currentBet + c.minRaise;
  if (max >= min) {
    const seats = c.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => p.seat);
    const h =
      (seats.indexOf(hero.seat) - seats.indexOf(c.dealerSeat) + seats.length) %
      seats.length;
    const outOfPosition = h === 1 || h === 2;
    const target = Math.min(
      max,
      Math.max(
        min,
        Math.round(
          raiseCount(c) === 0
            ? 2.5 * c.bigBlind
            : c.currentBet * (outOfPosition ? 4 : 3),
        ),
      ),
    );
    result.push({
      action: target === max ? "all-in" : "raise",
      total: target,
      cost: target - hero.streetCommitted,
    });
  }
  if (!result.some((x) => x.action === "all-in"))
    result.push({ action: "all-in", total: max, cost: hero.stack });
  return result;
}

/** Deliberately simple average-opponent response; these are authored probabilities. */
function callProbability(
  combo: Combo,
  cost: number,
  stack: number,
  committed: number,
  pot: number,
  bb: number,
  aggression: number,
  effectiveStack: number,
): number {
  if (cost <= 0) return 1;
  const odds = cost / (pot + cost),
    pressure = cost / (stack || cost);
  // A 5 BB limper facing an effective 4 BB call must not react like a deep
  // player facing a 150 BB shove. Shallow effective stacks and money already
  // committed widen the authored continuation policy. This is an opponent
  // policy adjustment; the hero's hand is deliberately absent from it.
  const shallow = clamp((25 - effectiveStack / bb) / 20, 0, 1);
  const commitment = clamp(committed / Math.max(bb, effectiveStack), 0, 1);
  const threshold = clamp(
    0.7 +
      0.085 * Math.max(0, aggression - 1) +
      0.45 * (odds - 0.2) +
      0.13 * pressure * (1 - 0.65 * shallow) +
      0.012 * Math.log2(Math.max(1, cost / bb)) -
      0.18 * shallow -
      0.25 * commitment,
    0.25,
    0.965,
  );
  if (combo.type === "AA") return 1;
  return sigmoid((combo.strength - threshold) / 0.035);
}

const BASE = 15 ** 5;
function straight(mask: number): number {
  for (let high = 14; high >= 6; high--)
    if (((mask >>> (high - 4)) & 31) === 31) return high;
  return (mask & 0x403c) === 0x403c ? 5 : 0;
}
function bits(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
function score(category: number, rs: number[]): number {
  let value = category * BASE;
  for (let i = 0; i < rs.length; i++) value += rs[i] * 15 ** (4 - i);
  return value;
}
/** Numeric evaluator, independently checked against the application's public evaluator. */
export function evaluateShowdown(cards: readonly number[]): number {
  const counts = new Uint8Array(15);
  let mask = 0,
    b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0;
  for (const c of cards) {
    const r = (c >>> 2) + 2,
      b = 1 << r;
    counts[r]++;
    mask |= b;
    switch (c & 3) {
      case 0:
        b0 |= b;
        break;
      case 1:
        b1 |= b;
        break;
      case 2:
        b2 |= b;
        break;
      default:
        b3 |= b;
    }
  }
  const flush =
    bits(b0) >= 5
      ? b0
      : bits(b1) >= 5
        ? b1
        : bits(b2) >= 5
          ? b2
          : bits(b3) >= 5
            ? b3
            : 0;
  if (flush) {
    const s = straight(flush);
    if (s) return score(8, [s]);
  }
  let quad = 0;
  const trips: number[] = [],
    pairs: number[] = [],
    ranks: number[] = [];
  for (let r = 14; r >= 2; r--)
    if (counts[r]) {
      ranks.push(r);
      if (counts[r] === 4) quad = r;
      else if (counts[r] === 3) trips.push(r);
      else if (counts[r] === 2) pairs.push(r);
    }
  if (quad) return score(7, [quad, ranks.find((r) => r !== quad)!]);
  if (trips.length && (pairs.length || trips.length > 1))
    return score(6, [trips[0], Math.max(pairs[0] || 0, trips[1] || 0)]);
  if (flush) return score(5, ranks.filter((r) => flush & (1 << r)).slice(0, 5));
  const s = straight(mask);
  if (s) return score(4, [s]);
  if (trips.length)
    return score(3, [
      trips[0],
      ...ranks.filter((r) => r !== trips[0]).slice(0, 2),
    ]);
  if (pairs.length >= 2)
    return score(2, [
      pairs[0],
      pairs[1],
      ranks.find((r) => r !== pairs[0] && r !== pairs[1])!,
    ]);
  if (pairs.length)
    return score(1, [
      pairs[0],
      ...ranks.filter((r) => r !== pairs[0]).slice(0, 3),
    ]);
  return score(0, ranks.slice(0, 5));
}

/** All earlier contributions are sunk. Returns payout; the caller subtracts future cost. */
export function heroPayout(
  contributions: readonly number[],
  folded: readonly boolean[],
  values: readonly number[],
  heroIndex: number,
  dead = 0,
): number {
  const levels = [...new Set(contributions.filter((v) => v > 0))].sort(
    (a, b) => a - b,
  );
  let previous = 0,
    payout = 0,
    first = true;
  const anteOnly = contributions.some((v, i) => v === 0 && !folded[i]);
  if (anteOnly && dead > 0 && !folded[heroIndex]) {
    const eligible = values.map((_, i) => i).filter((i) => !folded[i]),
      best = Math.max(...eligible.map((i) => values[i]));
    const winners = eligible.filter((i) => values[i] === best);
    if (winners.includes(heroIndex)) payout += dead / winners.length;
  }
  for (const level of levels) {
    const contributors = contributions
      .map((v, i) => (v >= level ? i : -1))
      .filter((i) => i >= 0);
    let amount = (level - previous) * contributors.length;
    previous = level;
    if (first) {
      if (!anteOnly) amount += dead;
      first = false;
    }
    // A sole contributor receives their uncalled excess, even in an incomplete log.
    if (contributors.length === 1) {
      if (contributors[0] === heroIndex) payout += amount;
      continue;
    }
    const eligible = contributors.filter((i) => !folded[i]);
    if (!eligible.includes(heroIndex)) continue;
    const best = Math.max(...eligible.map((i) => values[i]));
    const winners = eligible.filter((i) => values[i] === best);
    if (winners.includes(heroIndex)) payout += amount / winners.length;
  }
  return payout;
}

export function solvePreflop(
  c: ModelContext,
  onProgress?: (done: number) => void,
): ModelResult {
  validateContext(c);
  const samples = c.samples ?? 160,
    heroIndex = c.players.findIndex((p) => p.id === c.heroId),
    hero = c.players[heroIndex];
  const opponents = c.players
    .map((p, i) => ({ p, i, cdf: rangeCdf(c, p) }))
    .filter((o) => o.i !== heroIndex && !o.p.folded);
  const aggression = raiseCount(c);
  const heroMax = hero.streetCommitted + hero.stack;
  const effectiveMax = Math.min(
    heroMax,
    Math.max(...opponents.map((o) => o.p.streetCommitted + o.p.stack), 0),
  );
  // A checkdown abstraction omits the value of later streets and overvalues deep
  // open shoves. Deliberately omit those sizes rather than present that artefact
  // as a useful strategic recommendation. This is candidate-set optimization.
  const modelJam =
    effectiveMax / c.bigBlind <= 25 ||
    c.currentBet >= effectiveMax * 0.25 ||
    aggression >= 3;
  const candidates = legalCandidates(c).filter(
    (a) => a.action !== "all-in" || a.total <= c.currentBet || modelJam,
  );
  const dead = c.players.reduce(
      (n, p) => n + p.committed - p.streetCommitted,
      0,
    ),
    hands: Record<string, HandAdvice> = {};
  TYPES.forEach((type, typeIndex) => {
    const random = seeded((c.seed + Math.imul(typeIndex + 1, 0x9e3779b9)) | 0),
      heroCombos = BY_TYPE.get(type)!;
    const sums = candidates.map(() => 0),
      squares = candidates.map(() => 0),
      trials: number[][] = [];
    let equity = 0;
    for (let sample = 0; sample < samples; sample++) {
      const used = new Uint8Array(52),
        heroCards = heroCombos[Math.floor(random() * heroCombos.length)].cards;
      used[heroCards[0]] = used[heroCards[1]] = 1;
      const selected = new Map<number, Combo>();
      // Rotate sampling order to avoid privileging a particular seat's range blockers.
      const offset = Math.floor(random() * Math.max(1, opponents.length));
      for (let j = 0; j < opponents.length; j++) {
        const o = opponents[(j + offset) % opponents.length],
          combo = drawCombo(o.cdf, used, random);
        used[combo.cards[0]] = used[combo.cards[1]] = 1;
        selected.set(o.i, combo);
      }
      const available: number[] = [];
      for (let card = 0; card < 52; card++)
        if (!used[card]) available.push(card);
      for (let j = 0; j < 5; j++) {
        const k = j + Math.floor(random() * (available.length - j));
        [available[j], available[k]] = [available[k], available[j]];
      }
      const board = available.slice(0, 5),
        values = c.players.map(() => -1),
        reactions = c.players.map(() => random());
      values[heroIndex] = evaluateShowdown([...heroCards, ...board]);
      for (const o of opponents)
        values[o.i] = evaluateShowdown([...selected.get(o.i)!.cards, ...board]);
      const best = Math.max(...values),
        winners = values.filter((v) => v === best).length;
      if (values[heroIndex] === best) equity += 1 / winners;
      const evs = candidates.map((candidate, k) => {
        if (candidate.action === "fold") return 0;
        const contributions = c.players.map((p) => p.streetCommitted),
          folded = c.players.map((p) => p.folded);
        contributions[heroIndex] += candidate.cost;
        const beforeResponses = contributions.slice();
        const target = Math.max(c.currentBet, candidate.total),
          candidateAggression =
            aggression + (candidate.total > c.currentBet ? 1 : 0);
        for (const o of opponents) {
          const cost = Math.min(
            o.p.stack,
            Math.max(0, target - o.p.streetCommitted),
          );
          if (cost === 0 || o.p.allIn) continue;
          // Only chips this opponent can actually win enter their pot odds;
          // a covering hero's uncalled excess is not an incentive to call.
          const ceiling = o.p.streetCommitted + cost;
          const contestablePot =
            dead +
            beforeResponses.reduce((sum, v) => sum + Math.min(v, ceiling), 0);
          const effectiveStack = Math.min(
            heroMax,
            o.p.streetCommitted + o.p.stack,
          );
          const call = callProbability(
            selected.get(o.i)!,
            cost,
            o.p.stack,
            o.p.streetCommitted,
            contestablePot,
            c.bigBlind,
            candidateAggression,
            effectiveStack,
          );
          if (reactions[o.i] < call) contributions[o.i] += cost;
          else folded[o.i] = true;
        }
        const value =
          heroPayout(contributions, folded, values, heroIndex, dead) -
          candidate.cost;
        sums[k] += value;
        squares[k] += value * value;
        return value;
      });
      trials.push(evs);
    }
    const means = sums.map((sum) => sum / samples),
      standardErrors = squares.map((sq, k) =>
        Math.sqrt(
          Math.max(0, (sq - sums[k] ** 2 / samples) / (samples - 1) / samples),
        ),
      );
    let best = 0;
    for (let i = 1; i < candidates.length; i++)
      if (means[i] > means[best]) best = i;
    let uncertain = false;
    for (let other = 0; other < candidates.length; other++)
      if (other !== best) {
        let sum = 0,
          sq = 0;
        for (const values of trials) {
          const d = values[best] - values[other];
          sum += d;
          sq += d * d;
        }
        const se = Math.sqrt(
          Math.max(0, (sq - (sum * sum) / samples) / (samples - 1) / samples),
        );
        if (means[best] - means[other] <= 1.96 * se) uncertain = true;
      }
    const ev: Partial<Record<Action, number>> = {};
    candidates.forEach((candidate, k) => {
      ev[candidate.action] = means[k];
    });
    const chosen = candidates[best];
    hands[type] = {
      action: chosen.action,
      ...(chosen.action === "raise" || chosen.action === "all-in"
        ? { raiseTo: chosen.total }
        : {}),
      equity: equity / samples,
      ev,
      error: standardErrors[best],
      uncertain,
    };
    if ((typeIndex + 1) % 13 === 0 || typeIndex === TYPES.length - 1)
      onProgress?.((typeIndex + 1) / TYPES.length);
  });
  return {
    hands,
    samples,
    source: "Приближённая модель chipEV v1",
    assumptions: [
      "Не GTO: диапазоны и реакции среднего соперника заданы приближёнными правилами, а не взяты из решённого равновесия.",
      "Сравниваются только выбранные размеры: один обычный рейз; олл-ин — при эффективном стеке до 25 BB, текущей ставке от четверти эффективного стека или после 4-бета. Глубокие опен-пуши исключены из модели, но доступны при ручном вводе.",
      "Соперники отвечают только фолдом или коллом; их ререйзы и последующие ставки не моделируются.",
      "При коротком эффективном стеке и уже вложенных фишках модель соперника коллирует шире. Его шансы банка исключают недоступные побочные банки и неуравненный излишек ставки.",
      "После текущего круга ставок борд раздаётся до ривера без новых ставок. Поэтому оценки колла и рейза особенно условны при глубоких стеках.",
      "Карты выбираются из диапазонов последовательно с удалением блокеров; скрытые карты уже сфолдивших игроков не учитываются.",
      "EV — фишки относительно фолда сейчас: прежние вклады уже потрачены. Учтены мёртвое анте, побочные банки и возврат неуравненного остатка.",
      "Нет ICM, рейтинга и рейка. Погрешность показывает только шум Монте-Карло, а не ошибку стратегической модели.",
    ],
  };
}
