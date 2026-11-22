import { rank, seeded, suit, validate } from "../core";
import type {
  ActionType,
  DecisionObservation,
  OpponentProfile,
  PublicPlayer,
  Street,
  TournamentStage,
} from "./engine";
import { analyzeSizing, chooseSizingAction, gradeSizing } from "./sizing";
import type { SizingAnalysis, SizingChoice, SizingSample } from "./sizing";

/** An authored teaching policy, NOT an equilibrium solver or a full-game EV predictor.
 * The only input boundary is DecisionObservation; no actual opponent cards or
 * undealt cards are accepted. Equity samples hypothetical action-conditioned ranges.
 */
export interface Analysis {
  equity: number;
  standardError: number;
  potOdds: number | null;
  contestablePot: number;
  toCall: number;
  samples: number;
  /** Players who still owe money and may fold before any showdown. */
  pendingResponders: number;
  expectedShowdownOpponents: number;
  allowed: ActionType[];
  preferred: ActionType[];
  suggestedRaiseTo?: number;
  reason: string;
  assumptions: string[];
  /** Authored categories are policy inputs, not measured winning chances. */
  strength: number;
  draw: boolean;
  strong: boolean;
  marginal: boolean;
  tournamentStage: TournamentStage;
  /** Authored caution factor, not an ICM-derived equity adjustment. */
  riskPremium: number;
  callMargin: number;
  survivalRisk: boolean;
  fatalRisk: boolean;
  stackRiskFraction: number;
  survivalAdjusted: boolean;
  effectiveDepth: number;
  shortStackPush: boolean;
  /** Transient hypothetical sample bank; never part of saved decision feedback. */
  sizing?: SizingAnalysis;
}
export interface Feedback {
  verdict: "good" | "reasonable" | "risky" | "mistake" | "uncertain";
  title: string;
  reason: string;
}
export interface BotDecision {
  action: ActionType;
  total?: number;
  reason: string;
}
export interface AnalysisOptions {
  seed: number;
  samples?: number;
  profile?: OpponentProfile;
}

const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-clamp(x, -35, 35)));
const RANKS = "23456789TJQKA";
const BASE = 15 ** 5;
const pct = (value: number) => `${(value * 100).toFixed(1).replace(".", ",")}%`;

function handType(cards: readonly number[]): string {
  const high = Math.max(rank(cards[0]), rank(cards[1]));
  const low = Math.min(rank(cards[0]), rank(cards[1]));
  return (
    RANKS[high - 2] +
    RANKS[low - 2] +
    (high === low ? "" : suit(cards[0]) === suit(cards[1]) ? "s" : "o")
  );
}

// Transparent ordering for the authored preflop policy. It is not equity.
function ordering(cards: readonly number[]): number {
  const high = Math.max(rank(cards[0]), rank(cards[1]));
  const low = Math.min(rank(cards[0]), rank(cards[1]));
  if (high === low) return 32 + high * 4.3;
  const gap = high - low - 1;
  return (
    high * 3 +
    low * 1.5 +
    (suit(cards[0]) === suit(cards[1]) ? 6 : 0) +
    (gap === 0 ? 3 : gap === 1 ? 1 : 0) +
    (high === 14 ? 5 : 0) -
    Math.max(0, gap - 2) * 0.8
  );
}
interface Combo {
  a: number;
  b: number;
  strength: number;
}
const COMBOS: Combo[] = [];
for (let a = 0; a < 52; a++)
  for (let b = a + 1; b < 52; b++) COMBOS.push({ a, b, strength: 0 });
const ordered = [...COMBOS].sort(
  (a, b) => ordering([a.a, a.b]) - ordering([b.a, b.b]),
);
for (let index = 0; index < ordered.length;) {
  let end = index + 1;
  while (
    end < ordered.length &&
    ordering([ordered[end].a, ordered[end].b]) ===
      ordering([ordered[index].a, ordered[index].b])
  )
    end++;
  for (let i = index; i < end; i++)
    ordered[i].strength = (index + end) / (2 * ordered.length);
  index = end;
}
const preflopStrength = (cards: readonly number[]) => {
  const a = Math.min(cards[0], cards[1]),
    b = Math.max(cards[0], cards[1]);
  return COMBOS[(a * (103 - a)) / 2 + b - a - 1].strength;
};

function straight(mask: number): number {
  for (let high = 14; high >= 6; high--)
    if (((mask >>> (high - 4)) & 31) === 31) return high;
  return (mask & 0x403c) === 0x403c ? 5 : 0;
}
function countBits(value: number): number {
  let count = 0;
  while (value) {
    value &= value - 1;
    count++;
  }
  return count;
}
function score(category: number, ranks: number[]): number {
  let result = category * BASE;
  for (let i = 0; i < ranks.length; i++) result += ranks[i] * 15 ** (4 - i);
  return result;
}
/** Best-five score for five, six or seven cards. Tested against the core evaluator. */
export function policyHandValue(cards: readonly number[]): number {
  if (cards.length < 5 || cards.length > 7)
    throw Error("Для оценки нужно от пяти до семи карт.");
  const counts = new Uint8Array(15),
    suits = [0, 0, 0, 0];
  let mask = 0;
  for (const card of cards) {
    const r = rank(card);
    counts[r]++;
    mask |= 1 << r;
    suits[suit(card)] |= 1 << r;
  }
  const flush = suits.find((value) => countBits(value) >= 5) ?? 0;
  const flushStraight = flush ? straight(flush) : 0;
  if (flushStraight) return score(8, [flushStraight]);
  const ranks: number[] = [],
    trips: number[] = [],
    pairs: number[] = [];
  let quad = 0;
  for (let r = 14; r >= 2; r--)
    if (counts[r]) {
      ranks.push(r);
      if (counts[r] === 4) quad = r;
      else if (counts[r] === 3) trips.push(r);
      else if (counts[r] === 2) pairs.push(r);
    }
  if (quad) return score(7, [quad, ranks.find((r) => r !== quad)!]);
  if (trips.length && (pairs.length || trips.length > 1))
    return score(6, [trips[0], Math.max(pairs[0] ?? 0, trips[1] ?? 0)]);
  if (flush) return score(5, ranks.filter((r) => flush & (1 << r)).slice(0, 5));
  const run = straight(mask);
  if (run) return score(4, [run]);
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

interface Features {
  strength: number;
  draw: boolean;
  strong: boolean;
}
function features(
  cards: readonly number[],
  board: readonly number[],
): Features {
  if (!board.length)
    return {
      strength: preflopStrength(cards),
      draw: false,
      strong: ["AA", "KK", "QQ", "AKs", "AKo"].includes(handType(cards)),
    };
  const all = [...cards, ...board],
    value = policyHandValue(all);
  const category = Math.floor(value / BASE);
  const first = Math.floor((value % BASE) / 15 ** 4);
  const boardRanks = board.map(rank),
    highBoard = Math.max(...boardRanks);
  const ownRanks = cards.map(rank);
  let strength = [0.12, 0.36, 0.66, 0.78, 0.86, 0.91, 0.96, 0.985, 0.999][
    category
  ];
  if (category === 1) {
    const ownPair = ownRanks.includes(first);
    strength = ownPair
      ? first > highBoard
        ? 0.67
        : first === highBoard
          ? 0.6
          : first >= [...boardRanks].sort((a, b) => b - a)[1]
            ? 0.45
            : 0.31
      : 0.18 + Math.max(...ownRanks) / 100;
  }
  if (category === 0)
    strength =
      0.06 +
      Math.max(...ownRanks) / 120 +
      (Math.min(...ownRanks) > highBoard ? 0.05 : 0);
  // Shared paired boards and board-only made hands do not confer private value.
  if (category === 3 && !ownRanks.includes(first))
    strength = 0.25 + Math.max(...ownRanks) / 100;
  if (board.length === 5 && policyHandValue(board) === value) strength = 0.1;
  let draw = false;
  if (board.length < 5) {
    for (let s = 0; s < 4; s++)
      if (
        all.filter((c) => suit(c) === s).length === 4 &&
        cards.some((c) => suit(c) === s)
      )
        draw = true;
    const rs = new Set(all.map(rank));
    if (rs.has(14)) rs.add(1);
    for (let high = 5; high <= 14; high++) {
      const window = Array.from({ length: 5 }, (_, i) => high - i);
      if (
        window.filter((r) => rs.has(r)).length === 4 &&
        cards.some(
          (c) =>
            !boardRanks.includes(rank(c)) &&
            (window.includes(rank(c)) ||
              (rank(c) === 14 && window.includes(1))),
        )
      )
        draw = true;
    }
  }
  return {
    strength: clamp(strength, 0, 1),
    draw,
    strong: category >= 3 && strength >= 0.7,
  };
}

function openingFraction(o: DecisionObservation, player: PublicPlayer): number {
  const seats = o.players.map((p) => p.seat).sort((a, b) => a - b),
    dealer = seats.indexOf(o.dealerSeat);
  const distance =
    (seats.indexOf(player.seat) - dealer + seats.length) % seats.length;
  let fraction: number;
  if (seats.length === 2) fraction = distance === 0 ? 0.48 : 0.38;
  else if (distance === 0) fraction = 0.4;
  else if (distance === 1) fraction = 0.32;
  else if (distance === 2) fraction = 0.3;
  else fraction = 0.13 + (0.2 * (distance - 3)) / Math.max(1, seats.length - 3);
  return clamp(
    fraction *
      (player.profile === "tight"
        ? 0.74
        : player.profile === "loose"
          ? 1.34
          : 1),
    0.09,
    0.65,
  );
}
const boardAt = (o: DecisionObservation, street: Street) =>
  o.board.slice(
    0,
    street === "preflop"
      ? 0
      : street === "flop"
        ? 3
        : street === "turn"
          ? 4
          : 5,
  );

/** Physical combinations start equally likely. Only public actions update the prior. */
function rangeCdf(o: DecisionObservation, player: PublicPlayer): Float64Array {
  const cdf = new Float64Array(COMBOS.length);
  const observations: Array<{
    action: string;
    aggressive: boolean;
    raises: number;
    street: Street;
    size: number;
  }> = [];
  const bets = { preflop: o.bigBlind, flop: 0, turn: 0, river: 0 };
  const raises = { preflop: 0, flop: 0, turn: 0, river: 0 };
  for (const action of o.history) {
    const aggressive =
      (action.action === "raise" || action.action === "all-in") &&
      action.total > bets[action.street];
    if (
      action.actorId === player.id &&
      !["ante", "small-blind", "big-blind"].includes(action.action)
    )
      observations.push({
        action: action.action,
        aggressive,
        raises: raises[action.street],
        street: action.street,
        size: action.total,
      });
    if (aggressive) {
      bets[action.street] = action.total;
      raises[action.street]++;
    }
  }
  let total = 0;
  const open = openingFraction(o, player);
  for (let i = 0; i < COMBOS.length; i++) {
    const combo = COMBOS[i],
      own = [combo.a, combo.b];
    if (
      o.heroCards.includes(combo.a) ||
      o.heroCards.includes(combo.b) ||
      o.board.includes(combo.a) ||
      o.board.includes(combo.b)
    ) {
      cdf[i] = total;
      continue;
    }
    let weight = 1;
    for (const action of observations) {
      let likelihood: number;
      if (action.street === "preflop") {
        const fraction =
          action.raises === 0
            ? open
            : action.raises === 1
              ? open * 0.34
              : open * 0.13;
        const sizePressure = Math.max(0, action.size / o.bigBlind - 4) * 0.003;
        const aggressive =
          0.015 +
          0.92 *
            sigmoid(
              (combo.strength - (1 - fraction + Math.min(0.15, sizePressure))) /
                0.045,
            );
        const continuing =
          0.03 +
          0.93 *
            sigmoid(
              (combo.strength -
                (1 -
                  Math.min(0.76, open * (action.raises === 0 ? 2.2 : 1.3)))) /
                0.095,
            );
        likelihood = action.aggressive
          ? aggressive
          : action.action === "call" || action.action === "all-in"
            ? continuing * (1 - aggressive * 0.55)
            : action.action === "fold"
              ? Math.max(0.015, 1 - continuing)
              : 1 - aggressive * 0.65;
      } else {
        const f = features(own, boardAt(o, action.street));
        const aggressive = clamp(
          0.025 +
            0.82 * sigmoid((f.strength - 0.65 - action.raises * 0.09) / 0.1) +
            (f.draw ? 0.15 : 0),
          0.02,
          0.96,
        );
        const continuing = clamp(
          0.03 +
            0.86 * sigmoid((f.strength - 0.38 - action.raises * 0.05) / 0.12) +
            (f.draw ? 0.27 : 0),
          0.03,
          0.97,
        );
        likelihood = action.aggressive
          ? aggressive
          : action.action === "call" || action.action === "all-in"
            ? continuing * (1 - aggressive * 0.4)
            : action.action === "fold"
              ? 1 - continuing
              : 1 - aggressive * 0.65;
      }
      weight *= Math.max(0.003, likelihood);
    }
    total += Math.max(weight, 1e-12);
    cdf[i] = total;
  }
  return cdf;
}

function drawCombo(
  cdf: Float64Array,
  used: Uint8Array,
  random: () => number,
): Combo {
  for (let tries = 0; tries < 5000; tries++) {
    const target = random() * cdf[cdf.length - 1];
    let lo = 0,
      hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid] <= target) lo = mid + 1;
      else hi = mid;
    }
    const combo = COMBOS[lo];
    if (!used[combo.a] && !used[combo.b]) return combo;
  }
  // Direct conditional draw avoids a rare stall for heavily overlapping tight ranges.
  let total = 0;
  for (let i = 0; i < COMBOS.length; i++)
    if (!used[COMBOS[i].a] && !used[COMBOS[i].b])
      total += cdf[i] - (cdf[i - 1] ?? 0);
  if (total <= 0)
    throw Error("Не удалось построить непересекающиеся диапазоны.");
  let target = random() * total;
  for (let i = 0; i < COMBOS.length; i++)
    if (!used[COMBOS[i].a] && !used[COMBOS[i].b]) {
      target -= cdf[i] - (cdf[i - 1] ?? 0);
      if (target <= 0) return COMBOS[i];
    }
  return COMBOS.find((combo) => !used[combo.a] && !used[combo.b])!;
}

/** Exact current price: remove side-pot layers the observer cannot contest. */
export function callPrice(o: DecisionObservation): {
  toCall: number;
  potOdds: number | null;
  contestablePot: number;
} {
  const actor = o.players.find((player) => player.id === o.actorId);
  if (!actor) throw Error("Нет игрока, принимающего решение.");
  const toCall = Math.min(
    actor.stack,
    Math.max(0, o.currentBet - actor.streetCommitted),
  );
  const cap = actor.committed - actor.antePaid + toCall;
  const contestablePot = o.players.reduce(
    (sum, player) =>
      sum +
      player.antePaid +
      Math.min(
        cap,
        player.committed -
          player.antePaid +
          (player.id === actor.id ? toCall : 0),
      ),
    0,
  );
  return {
    toCall,
    contestablePot,
    potOdds: toCall > 0 ? toCall / Math.max(toCall, contestablePot) : null,
  };
}

function equityEstimate(
  o: DecisionObservation,
  samples: number,
  random: () => number,
): {
  equity: number;
  standardError: number;
  expectedShowdownOpponents: number;
  sizingSamples?: SizingSample[];
} {
  const opponents = o.players.filter((player) => player.id !== o.actorId);
  const ranges = opponents.map((player) => rangeCdf(o, player));
  const continuation = opponents.map((player) => responderPolicy(o, player));
  const liveOpponents = opponents
    .map((player, index) => ({ player, index }))
    .filter(({ player }) => !player.folded);
  const sizingSamples: SizingSample[] | undefined =
    o.street !== "preflop" && liveOpponents.length === 1 ? [] : undefined;
  let sum = 0,
    squared = 0,
    participants = 0;
  for (let trial = 0; trial < samples; trial++) {
    const used = new Uint8Array(52);
    for (const card of [...o.heroCards, ...o.board]) used[card] = 1;
    const holes = opponents.map((_, index) => {
      const combo = drawCombo(ranges[index], used, random);
      used[combo.a] = used[combo.b] = 1;
      return [combo.a, combo.b];
    });
    // Every player's hypothetical cards remain removed even when they fold.
    // A player behind who still owes the current bet is not a guaranteed caller.
    const contesting = opponents.map((player, index) => {
      if (player.folded) return false;
      if (player.allIn || player.streetCommitted >= o.currentBet) return true;
      return random() < continuation[index](holes[index]);
    });
    participants += contesting.filter(Boolean).length;
    const board = [...o.board];
    while (board.length < 5) {
      const card = Math.floor(random() * 52);
      if (!used[card]) {
        used[card] = 1;
        board.push(card);
      }
    }
    const ownValue = policyHandValue([...o.heroCards, ...board]);
    if (sizingSamples) {
      const villainCards = holes[liveOpponents[0].index];
      const villainValue = policyHandValue([...villainCards, ...board]);
      sizingSamples.push({
        villainCards: [...villainCards],
        // Sizing models the response separately. Do not mix a sampled fold into
        // this unconditional showdown outcome or count fold equity twice.
        showdownShare:
          ownValue > villainValue ? 1 : ownValue === villainValue ? 0.5 : 0,
      });
    }
    let ties = 1,
      beaten = false;
    for (let index = 0; index < opponents.length; index++)
      if (contesting[index]) {
        const value = policyHandValue([...holes[index], ...board]);
        if (value > ownValue) {
          beaten = true;
          break;
        }
        if (value === ownValue) ties++;
      }
    const share = beaten ? 0 : 1 / ties;
    sum += share;
    squared += share * share;
  }
  const equity = sum / samples;
  return {
    equity,
    standardError: Math.sqrt(
      Math.max(0, squared / samples - equity * equity) / samples,
    ),
    expectedShowdownOpponents: participants / samples,
    ...(sizingSamples ? { sizingSamples } : {}),
  };
}

function raiseCount(o: DecisionObservation): number {
  let count = 0,
    bet = o.street === "preflop" ? o.bigBlind : 0;
  for (const action of o.history)
    if (
      action.street === o.street &&
      (action.action === "raise" || action.action === "all-in") &&
      action.total > bet
    ) {
      count++;
      bet = action.total;
    }
  return count;
}
function aggressiveAction(o: DecisionObservation): ActionType | undefined {
  return o.legalActions.includes("raise") && o.maxRaiseTo >= o.minRaiseTo
    ? "raise"
    : o.legalActions.includes("all-in") && o.maxRaiseTo > o.currentBet
      ? "all-in"
      : undefined;
}
function passiveAction(o: DecisionObservation): ActionType {
  return o.toCall > 0 ? "call" : "check";
}

/** Stage is public context. This is a deliberately authored caution rule, not ICM:
 * no payouts, other-table stacks or money-equity are available. In true heads-up
 * no extra premium is applied; two survivors of a larger dealt table are not HU.
 */
function survivalCaution(
  o: DecisionObservation,
  actor: PublicPlayer,
  toCall: number,
) {
  const tournamentStage = o.tournamentStage ?? "early";
  const stackRiskFraction = actor.stack > 0 ? toCall / actor.stack : 0;
  const actorAvailable = actor.stack + actor.committed - actor.antePaid;
  const covered = o.players.some(
    (player) =>
      player.id !== actor.id &&
      !player.folded &&
      player.stack + player.committed - player.antePaid >= actorAvailable,
  );
  const survivalRisk =
    tournamentStage !== "early" &&
    o.players.length > 2 &&
    covered &&
    stackRiskFraction > 0.4;
  const scale = { early: 0, middle: 0.025, late: 0.06, final: 0.1 }[
    tournamentStage
  ];
  const riskPremium = survivalRisk
    ? scale * clamp((stackRiskFraction - 0.4) / 0.6, 0, 1)
    : 0;
  return {
    tournamentStage,
    stackRiskFraction,
    survivalRisk,
    riskPremium,
    fatalRisk: survivalRisk && toCall >= actor.stack,
  };
}

/** Keep the existing authored stage caution when the chip-only sizing tree is
 * used. This is a teaching preference, not a computed tournament utility. */
function stageAwareSizingChoice(
  o: DecisionObservation,
  sizing: SizingAnalysis,
  context: Pick<Analysis, "strong" | "marginal" | "survivalAdjusted">,
): SizingChoice | undefined {
  const choice = chooseSizingAction(o, sizing);
  if (!choice || context.strong) return choice;
  const actor = o.players.find((player) => player.id === o.actorId)!;
  const costOf = (action: ActionType, total?: number) =>
    action === "raise" || (action === "all-in" && o.maxRaiseTo > o.currentBet)
      ? (action === "all-in" ? o.maxRaiseTo : total!) - actor.streetCommitted
      : action === "call" || action === "all-in"
        ? Math.min(
            actor.stack,
            Math.max(0, o.currentBet - actor.streetCommitted),
          )
        : 0;
  const caution = survivalCaution(
    o,
    actor,
    costOf(choice.action, choice.total),
  );
  if (!caution.survivalRisk) return choice;
  const bankEquity =
    sizing.samples.reduce((sum, sample) => sum + sample.showdownShare, 0) /
    Math.max(1, sizing.sampleCount);
  if (bankEquity >= 0.97) return choice;
  const aggressive =
    choice.action === "raise" ||
    (choice.action === "all-in" && o.maxRaiseTo > o.currentBet);
  const marginalRisk =
    context.survivalAdjusted ||
    context.marginal ||
    (aggressive && bankEquity < 0.7);
  if (!marginalRisk) return choice;
  const raises = raiseCount(o);
  const safer = sizing.candidates.filter(
    (candidate) =>
      candidate.trusted &&
      (raises < 3 || ["fold", "call", "check"].includes(candidate.action)) &&
      !survivalCaution(o, actor, costOf(candidate.action, candidate.total))
        .survivalRisk,
  );
  if (!safer.length) return choice;
  const best = safer.reduce((a, b) => (b.ev > a.ev ? b : a));
  return {
    action: best.action,
    ...(best.total !== undefined ? { total: best.total } : {}),
    reason:
      "На поздней стадии выбран более умеренный вклад против покрывающего стека: дорогое продолжение погранично по учебной модели. Это авторская осторожность, а не расчёт ICM или доказательство оптимальной турнирной стратегии.",
  };
}

/** Authored continuation likelihood for a hypothetical pending responder.
 * It models possible folds, not future raise sizes, optimal play or extra EV.
 * Calls already paid and all-in hands are handled as certain participants above.
 */
function responderPolicy(
  o: DecisionObservation,
  player: PublicPlayer,
): (cards: number[]) => number {
  const price = callPrice({ ...o, actorId: player.id });
  const odds = price.potOdds ?? 0;
  const pressure = price.toCall / Math.max(1, player.stack);
  const caution = survivalCaution(o, player, price.toCall);
  const aggression = raiseCount(o);
  const fraction = clamp(
    openingFraction(o, player) *
      (aggression === 0 ? 1.25 : aggression === 1 ? 0.78 : 0.32),
    0.05,
    0.65,
  );
  const preflopCutoff = clamp(
    1 -
      fraction +
      0.2 * (odds - 0.22) +
      0.06 * pressure +
      0.01 * Math.log2(Math.max(1, price.toCall / o.bigBlind)) +
      0.45 * caution.riskPremium,
    0.4,
    0.985,
  );
  const postflopCutoff = clamp(
    0.42 +
      0.45 * (odds - 0.2) +
      0.18 * pressure +
      0.5 * caution.riskPremium +
      (player.profile === "tight"
        ? 0.06
        : player.profile === "loose"
          ? -0.05
          : 0),
    0.25,
    0.93,
  );
  return (cards) => {
    if (o.street === "preflop") {
      if (handType(cards) === "AA") return 1;
      return (
        0.003 +
        0.994 * sigmoid((preflopStrength(cards) - preflopCutoff) / 0.035)
      );
    }
    const f = features(cards, o.board);
    const drawAllowance = f.draw
      ? (o.street === "flop" ? 0.18 : 0.09) * clamp((0.45 - odds) / 0.25, 0, 1)
      : 0;
    return (
      0.003 +
      0.994 * sigmoid((f.strength + drawAllowance - postflopCutoff) / 0.08)
    );
  };
}

export function analyzeDecision(
  o: DecisionObservation,
  options: AnalysisOptions,
): Analysis {
  validate([...o.heroCards, ...o.board]);
  if (o.heroCards.length !== 2 || ![0, 3, 4, 5].includes(o.board.length))
    throw Error("Нужны две собственные карты и корректный борд.");
  if (!Number.isSafeInteger(options.seed))
    throw Error("Некорректный seed анализа.");
  const samples = options.samples ?? 1400;
  if (!Number.isInteger(samples) || samples < 80 || samples > 20_000)
    throw Error("Число выборок должно быть от 80 до 20 000.");
  const actor = o.players.find((player) => player.id === o.actorId);
  if (!actor || actor.folded || !o.legalActions.length)
    throw Error("Нет доступного решения.");
  const { sizingSamples, ...equity } = equityEstimate(
    o,
    samples,
    seeded(options.seed),
  );
  const sizing =
    o.street !== "preflop" ? analyzeSizing(o, sizingSamples ?? []) : undefined;
  const price = callPrice(o),
    f = features(o.heroCards, o.board);
  const active = o.players.filter((player) => !player.folded).length;
  const pendingResponders = o.players.filter(
    (player) =>
      player.id !== o.actorId &&
      !player.folded &&
      !player.allIn &&
      player.streetCommitted < o.currentBet,
  ).length;
  const aggression = raiseCount(o),
    passive = passiveAction(o),
    aggressive = aggressiveAction(o);
  const ownProfile = options.profile ?? actor.profile;
  const baseMargin =
    (o.street === "river" ? 0.02 : 0.055) + Math.max(0, active - 2) * 0.006;
  const caution = survivalCaution(o, actor, price.toCall);
  const margin = baseMargin + caution.riskPremium;
  const edge = equity.equity - (price.potOdds ?? 0);
  const survivalAdjusted =
    caution.riskPremium > 0 && edge > baseMargin && edge <= margin;
  const marginal =
    price.potOdds !== null &&
    Math.abs(edge - margin) < 2 * equity.standardError + 0.035;
  let preferred: ActionType[];
  let reason: string;
  const empirical = `Модель equity против предполагаемых диапазонов: ${pct(equity.equity)}${price.potOdds === null ? "." : `; для колла по текущей цене нужно ${pct(price.potOdds)} без последующих ставок.`}`;
  const preflopOpen = o.street === "preflop" && aggression === 0;
  const strong =
    f.strong ||
    (o.street !== "preflop" &&
      equity.equity > (active > 2 ? 0.65 : 0.76) &&
      f.strength >= 0.6);
  if (preflopOpen) {
    const cutoff = 1 - openingFraction(o, { ...actor, profile: ownProfile });
    const limpers = o.history.filter(
      (action) => action.street === "preflop" && action.action === "call",
    ).length;
    if (f.strength >= cutoff + Math.min(0.09, limpers * 0.025) || f.strong) {
      preferred = aggressive ? [aggressive] : [passive];
      reason =
        "Рука входит в учебный диапазон открытия для этой позиции. Повышение собирает банк с сильной частью диапазона и даёт шанс забрать блайнды.";
    } else if (price.potOdds === null) {
      preferred = ["check"];
      reason =
        "Бесплатный чек сохраняет участие в раздаче. Для повышения эта рука слишком слаба по выбранной учебной модели.";
    } else if (
      limpers > 0 &&
      f.strength > cutoff - 0.16 &&
      edge > margin + 0.05 &&
      price.toCall <= o.bigBlind
    ) {
      preferred = ["call"];
      reason =
        "После лимпов небольшая доплата со связной или достаточно сильной рукой допустима; несколько соперников требуют осторожности после флопа.";
    } else {
      preferred = ["fold"];
      reason =
        "Для этой позиции рука вне учебного диапазона продолжения. Не стоит оплачивать вход только потому, что ставка небольшая.";
    }
  } else if (price.potOdds === null) {
    preferred = strong && aggressive ? [aggressive, "check"] : ["check"];
    reason = strong
      ? "Сильная рука позволяет ставить на добор; чек также может сохранить слабые руки соперника в банке. Натс не требует обязательного чек/колла."
      : "Чек позволяет увидеть следующее действие бесплатно. Слабая рука сама по себе не обосновывает ставку в нескольких соперников.";
  } else if (
    strong &&
    (edge > margin ||
      (o.street === "preflop" && handType(o.heroCards) === "AA"))
  ) {
    preferred = aggressive ? [aggressive, "call"] : ["call"];
    reason =
      "Сильная рука и достаточный запас над ценой колла допускают продолжение. Колл и повышение могут быть разумны: выбор зависит от того, какие худшие руки ответят.";
  } else if (edge > margin) {
    preferred = ["call"];
    reason =
      "Колл выглядит допустимым против предполагаемых диапазонов по текущей цене. На ранних улицах это ещё не гарантия прибыли: впереди могут быть новые ставки.";
  } else {
    preferred = ["fold"];
    reason = f.draw
      ? "Есть дро, но текущая цена не даёт достаточного запаса против предполагаемых диапазонов. Имплайд-оддсы здесь не считаются доказанной прибылью."
      : "Цена продолжения высока относительно оценки силы руки против предполагаемых диапазонов. В учебной модели предпочтителен фолд.";
  }
  const effectiveDepth = o.maxRaiseTo / o.bigBlind;
  const canPush =
    o.legalActions.includes("all-in") && o.maxRaiseTo > o.currentBet;
  const type = handType(o.heroCards),
    pair = rank(o.heroCards[0]) === rank(o.heroCards[1]);
  const openPush =
    preflopOpen &&
    effectiveDepth <= 15 &&
    canPush &&
    preferred.some((action) => action === "raise" || action === "all-in") &&
    (effectiveDepth <= 12 ||
      (pair && rank(o.heroCards[0]) <= 11) ||
      ["AKs", "AKo", "AQs", "AQo", "AJs"].includes(type));
  const reshoveCutoff = Math.max(
    0.86,
    1 - openingFraction(o, { ...actor, profile: ownProfile }) * 0.4,
  );
  const reshove =
    o.street === "preflop" &&
    aggression > 0 &&
    aggression <= 2 &&
    effectiveDepth <= 15 &&
    canPush &&
    o.currentBet <= o.maxRaiseTo * 0.45 &&
    o.players.some(
      (player) => player.id !== actor.id && !player.folded && !player.allIn,
    ) &&
    (f.strong || f.strength >= reshoveCutoff);
  const shortStackPush = openPush || reshove;
  if (openPush) {
    preferred = [
      "all-in",
      ...(o.legalActions.includes("raise") ? ["raise" as const] : []),
    ];
    reason =
      "При коротком стеке пуш с подходящей рукой — практичный способ забрать блайнды или получить оплату; небольшое открытие также возможно. Поздняя стадия не требует пассивности: первым повышая, вы сохраняете шанс на фолд соперников.";
  } else if (reshove) {
    preferred = [
      "all-in",
      ...(strong && edge > margin ? ["call" as const] : []),
    ];
    reason =
      "При коротком стеке эта рука подходит для учебного ререйза олл-ин против обычного открытия. В отличие от колла, пуш может выиграть банк без вскрытия; это предположение о реакции соперника, а не расчёт точного EV.";
  }
  if (caution.survivalRisk)
    reason += caution.fatalRisk
      ? " На кону турнирная жизнь: на поздней стадии одного преимущества в фишках недостаточно для уверенной оценки колла; это поправка учебных правил, не ICM."
      : " На поздней стадии против покрывающего стека крупная доплата требует дополнительной осторожности; эта учебная поправка не является ICM.";
  preferred = preferred.filter((action) => o.legalActions.includes(action));
  if (!preferred.length)
    preferred = [
      o.legalActions.includes(passive) ? passive : o.legalActions[0],
    ];
  let suggestedRaiseTo: number | undefined;
  if (aggressive) {
    const target =
      o.street === "preflop"
        ? aggression === 0
          ? Math.round(
              o.bigBlind *
                (2.5 +
                  o.history.filter(
                    (a) => a.street === "preflop" && a.action === "call",
                  ).length),
            )
          : o.currentBet * 3
        : o.currentBet + Math.round((o.pot + price.toCall) * 0.66);
    suggestedRaiseTo = shortStackPush
      ? o.maxRaiseTo
      : Math.min(o.maxRaiseTo, Math.max(o.minRaiseTo, target));
  }
  if (sizing?.supported) {
    const choice = stageAwareSizingChoice(o, sizing, {
      strong,
      marginal,
      survivalAdjusted,
    });
    if (choice) {
      preferred = [choice.action];
      suggestedRaiseTo =
        choice.action === "raise"
          ? choice.total
          : choice.action === "all-in" && o.maxRaiseTo > o.currentBet
            ? o.maxRaiseTo
            : suggestedRaiseTo;
      reason = choice.reason;
    }
  }
  return {
    ...equity,
    ...price,
    samples,
    pendingResponders,
    allowed: [...o.legalActions],
    preferred,
    suggestedRaiseTo,
    reason: `${reason} ${empirical}`,
    strength: f.strength,
    draw: f.draw,
    strong,
    marginal,
    ...caution,
    callMargin: margin,
    survivalAdjusted,
    effectiveDepth,
    shortStackPush,
    ...(sizing ? { sizing } : {}),
    assumptions: [
      ...(sizing?.assumptions ?? []),
      "Учебные правила и профили соперников заданы вручную; это не GTO и не расчёт оптимального EV.",
      "Equity на условном вскрытии оценено только по своим картам, открытому борду и публичным действиям. Реальные карты соперников и будущий борд не используются.",
      "Диапазоны — вероятностные предположения, обновляемые по действиям и позициям; конкретные комбинации выбираются с учётом занятых карт.",
      "Не уравнявшие ставку соперники могут сфолдить: участие определяется авторской вероятностью по предполагаемой руке, цене, позиции и стилю. Уже уравнявшие и олл-ин участвуют обязательно; карты сфолдивших остаются удалёнными из колоды.",
      sizing?.supported
        ? "Для постфлопа один на один сравниваются размеры в ограниченном дереве текущей улицы. Предполагаемые ответы заданы моделью; следующие улицы и полная стратегия не решены."
        : "Последующие ререйзы и дополнительные вклады не решены как дерево ставок. Возможность фолда ожидающих соперников не является расчётом точной прибыли.",
      "Цена колла учитывает доступные слои банка. На ранних улицах будущие ставки и реализация equity требуют отдельной осторожности.",
      "Стандартная ошибка характеризует только случайную выборку, а не достоверность учебной стратегии.",
      "Поздняя стадия добавляет авторскую осторожность к крупным коллам против покрывающего стека, но не вычисляет ICM: нет выплат и стеков всего турнира. В настоящем хедз-апе эта поправка равна нулю.",
      "С коротким стеком учебная модель допускает открытия пушем и ререйзы олл-ин. Предполагаемое фолд-эквити не является гарантией прибыльности.",
    ],
  };
}

export function gradeDecision(
  o: DecisionObservation,
  analysis: Analysis,
  action: ActionType,
  total?: number,
): Feedback {
  if (action === "fold" && analysis.toCall === 0)
    return {
      verdict: "mistake",
      title: "Лучше бесплатный чек",
      reason:
        "Ничего доплачивать не нужно. Чек сохраняет шанс выиграть банк, тогда как фолд сразу отдаёт его.",
    };
  if (!analysis.allowed.includes(action))
    return {
      verdict: "mistake",
      title: "Недоступное действие",
      reason: "Это действие не разрешено текущей ставкой или порядком торгов.",
    };
  const aggressive =
    action === "raise" || (action === "all-in" && o.maxRaiseTo > o.currentBet);
  const normalized: ActionType =
    action === "all-in" && !aggressive
      ? "call"
      : action === "all-in" && analysis.allowed.includes("raise")
        ? "raise"
        : action;
  if (
    action === "raise" &&
    (!Number.isSafeInteger(total) ||
      total! > o.maxRaiseTo ||
      total! <= o.currentBet ||
      (total! < o.minRaiseTo && total !== o.maxRaiseTo))
  )
    return {
      verdict: "mistake",
      title: "Неверный размер",
      reason:
        "Повышение должно соответствовать минимальному рейзу и доступному стеку; короткое повышение допустимо только на весь стек.",
    };
  if (aggressive && o.street === "preflop") {
    const target = action === "all-in" ? o.maxRaiseTo : total!;
    const cost =
      target -
      o.players.find((player) => player.id === o.actorId)!.streetCommitted;
    if (
      cost > Math.max(o.pot + analysis.toCall, o.bigBlind * 3) * 3 &&
      cost >
        o.players.find((player) => player.id === o.actorId)!.stack * 0.45 &&
      o.maxRaiseTo / o.bigBlind > 25
    )
      return {
        verdict: "risky",
        title: "Слишком крупно для обычного добора",
        reason:
          "Такой размер резко увеличивает риск и может выбить слабые руки, от которых хотелось получить оплату. Учебный ориентир — обычный размер повышения, а не глубокий олл-ин.",
      };
  }
  const active = o.players.filter((player) => !player.folded);
  const hasSidePotLayers =
    active.length > 2 &&
    active.some((player) => player.allIn) &&
    new Set(active.map((player) => player.committed - player.antePaid)).size >
      1;
  if (hasSidePotLayers && normalized !== "check")
    return {
      verdict: "uncertain",
      title: "Нужен разбор отдельных банков",
      reason:
        "Здесь есть олл-ин и разные доступные слои банка. Цена колла учитывает ваш доступ к банкам, но общая оценка equity не заменяет отдельный стратегический разбор каждого слоя; уверенно оценивать действие нельзя.",
    };
  const actor = o.players.find((player) => player.id === o.actorId)!;
  if (o.street !== "preflop") {
    const sizingFeedback = analysis.sizing?.supported
      ? gradeSizing(o, analysis.sizing, action, total)
      : undefined;
    if (sizingFeedback) {
      const actionCost = aggressive
        ? (action === "all-in" ? o.maxRaiseTo : total!) - actor.streetCommitted
        : normalized === "call"
          ? analysis.toCall
          : 0;
      const caution = survivalCaution(o, actor, actionCost);
      if (!caution.survivalRisk) return sizingFeedback;
      const bank = analysis.sizing!.samples;
      const allSamplesWin =
        bank.length > 0 && bank.every((sample) => sample.showdownShare === 1);
      return {
        ...sizingFeedback,
        verdict:
          sizingFeedback.verdict === "good" ||
          sizingFeedback.verdict === "reasonable"
            ? allSamplesWin
              ? "reasonable"
              : "uncertain"
            : sizingFeedback.verdict,
        reason: `${sizingFeedback.reason} На поздней стадии крупный вклад против покрывающего стека дополнительно рискует турнирной жизнью. Модель сравнивает фишки, а не турнирную ценность; без выплат и стеков всего турнира это не расчёт ICM.`,
      };
    }
    return {
      verdict: "uncertain",
      title: "Недостаточно данных для уверенной оценки",
      reason: `${analysis.sizing?.unsupportedReason ?? "Для этой ситуации пока нет сравнения размеров ставок и ответов соперников."} Общая сила комбинации сама по себе не определяет качество конкретной ставки. Это не доказывает ошибку выбранного действия.`,
    };
  }
  // A clear shortfall in the chip-price test remains a mistake even late in a
  // tournament. The authored survival premium alone never supplies this verdict.
  if (
    normalized === "call" &&
    analysis.potOdds !== null &&
    analysis.equity + 2 * analysis.standardError < analysis.potOdds - 0.1 &&
    !analysis.draw &&
    analysis.toCall >= actor.stack
  )
    return {
      verdict: "mistake",
      title: "Слишком дорогой колл",
      reason: `Модель equity даёт ${pct(analysis.equity)}, а для текущего колла требуется ${pct(analysis.potOdds)}. Против предполагаемых диапазонов запас отрицателен даже с учётом шума; в выбранной модели лучше фолд.`,
    };
  if (analysis.survivalRisk && normalized === "call")
    return {
      verdict:
        (o.street === "preflop" && handType(o.heroCards) === "AA") ||
        analysis.equity >= 0.97
          ? "reasonable"
          : "uncertain",
      title: analysis.fatalRisk
        ? "Колл на турнирную жизнь"
        : "Крупный колл на поздней стадии",
      reason:
        "Текущая цена в фишках сама по себе не доказывает разумность риска: покрывающий стек может лишить вас большой части стека или выбить. Точная турнирная ценность не рассчитана, поэтому учебная поправка не превращает такой колл в доказанную ошибку.",
    };
  if (analysis.survivalAdjusted && normalized === "fold")
    return {
      verdict: "reasonable",
      title: "Осторожный турнирный фолд",
      reason:
        "По цене в фишках продолжение возможно, но учебные правила учитывают риск крупной потери против покрывающего стека. Без выплат и стеков всего турнира нельзя утверждать, что этот фолд оптимален по ICM.",
    };
  if (analysis.marginal && !analysis.strong && normalized !== "check")
    return {
      verdict: "uncertain",
      title: "Пограничное решение",
      reason:
        "Оценка близка к границе продолжения; шум выборки и предположения о диапазонах могут изменить вывод. Уверенно объявлять это ошибкой нельзя.",
    };
  if (
    normalized === "call" &&
    analysis.pendingResponders > 0 &&
    !analysis.strong
  )
    return {
      verdict: "reasonable",
      title: "Колл с учётом игроков позади",
      reason:
        "Игроки, ещё не уравнявшие ставку, могут сбросить: оценка не считает их обязательными участниками вскрытия. Но они также могут коллировать или повысить; дальнейшее дерево ставок не рассчитано, поэтому прибыльность не доказана.",
    };
  if (
    normalized === "call" &&
    !analysis.strong &&
    analysis.toCall < actor.stack &&
    analysis.preferred.includes("call")
  )
    return {
      verdict: "reasonable",
      title: "Колл допустим по текущей цене",
      reason:
        "Против предполагаемых диапазонов текущая цена позволяет рассмотреть колл. Но дальнейшие ставки и возможность реализовать equity не рассчитаны, поэтому это учебный ориентир, а не доказанная прибыльность.",
    };
  if (
    analysis.preferred.includes(normalized) ||
    analysis.preferred.includes(action)
  )
    return {
      verdict: "good",
      title: "Разумное решение",
      reason: analysis.reason,
    };
  if (normalized === "check")
    return {
      verdict: "reasonable",
      title: "Допустимый чек",
      reason:
        "Чек сохраняет участие без затрат. С сильной рукой ставка тоже заслуживает внимания, если соперники могут ответить хуже.",
    };
  if (normalized === "call" && analysis.strong)
    return {
      verdict: "reasonable",
      title: "Допустимый колл",
      reason:
        "Колл оставляет слабые руки и блефы в диапазоне соперника. Сильная рука также позволяет рассмотреть повышение на добор.",
    };
  if (
    aggressive &&
    (analysis.strong || (analysis.draw && analysis.equity > 0.33))
  )
    return {
      verdict: "reasonable",
      title:
        analysis.draw && !analysis.strong
          ? "Возможный полублеф"
          : "Допустимое повышение",
      reason:
        analysis.draw && !analysis.strong
          ? "У руки есть шансы усилиться, поэтому полублеф возможен. Он требует, чтобы соперники иногда сбрасывали; одной вероятности усиления недостаточно."
          : "Сильная рука может повышать на добор. Это не означает, что рейз лучше колла против любого диапазона.",
    };
  if (normalized === "fold" && analysis.strong)
    return {
      verdict: "risky",
      title: "Вероятно слишком осторожно",
      reason:
        "По доступной информации это сильная рука с приемлемой ценой продолжения. Фолд может отдать слишком много; скрытые карты соперника при оценке не использовались.",
    };
  if (normalized === "fold")
    return {
      verdict: "reasonable",
      title: "Осторожный фолд",
      reason:
        "Фолд ограничивает потери. Учебная модель допускает продолжение, но предположения о диапазонах и будущих ставках не дают строгого доказательства.",
    };
  return {
    verdict: "risky",
    title: aggressive ? "Рискованное повышение" : "Рискованное продолжение",
    reason: aggressive
      ? "Для этого повышения не хватает явного добора или сильного дро. Блеф возможен, но модель не доказывает, что соперники будут достаточно часто сбрасывать."
      : analysis.reason,
  };
}

export function chooseBotAction(
  o: DecisionObservation,
  profile: OpponentProfile,
  seed: number,
  suppliedAnalysis?: Analysis,
): BotDecision {
  const analysis =
    suppliedAnalysis ?? analyzeDecision(o, { seed, samples: 240, profile });
  if (o.street !== "preflop" && analysis.sizing?.supported) {
    const sized = stageAwareSizingChoice(o, analysis.sizing, analysis);
    if (sized) return sized;
  }
  const random = seeded(seed ^ 0x52c73a1b),
    r = random();
  const passive = passiveAction(o),
    aggressive = aggressiveAction(o);
  const raises = raiseCount(o),
    headsUp = o.players.filter((player) => !player.folded).length === 2;
  let action = analysis.preferred[0];
  // Three raises per street bound the bot tree; the engine still validates every move.
  if (
    analysis.shortStackPush &&
    raises < 3 &&
    o.legalActions.includes("all-in")
  )
    action = "all-in";
  else if (aggressive && raises < 3 && analysis.preferred.includes(aggressive))
    action = r < (profile === "loose" ? 0.83 : 0.72) ? aggressive : passive;
  else if (action === "fold") {
    const continueChance =
      (profile === "loose" ? 0.15 : profile === "tight" ? 0.025 : 0.07) *
      (1 - 0.85 * clamp(analysis.riskPremium / 0.1, 0, 1));
    if (
      r < continueChance &&
      (analysis.marginal || analysis.draw || analysis.strength > 0.65)
    )
      action = passive;
  } else if (action === "check" && aggressive && raises < 3) {
    const bluffChance = analysis.draw
      ? 0.25
      : headsUp
        ? profile === "loose"
          ? 0.09
          : 0.035
        : 0.008;
    if (r < bluffChance) action = aggressive;
  }
  if (
    (action === "raise" ||
      (action === "all-in" && o.maxRaiseTo > o.currentBet)) &&
    raises >= 3
  )
    action =
      analysis.toCall === 0
        ? "check"
        : analysis.preferred.includes("call") || analysis.strong
          ? "call"
          : "fold";
  if (!o.legalActions.includes(action))
    action = o.legalActions.includes(passive) ? passive : o.legalActions[0];
  const isRaise =
    action === "raise" || (action === "all-in" && o.maxRaiseTo > o.currentBet);
  let reason: string;
  if (isRaise)
    reason = analysis.shortStackPush
      ? "Пуш с коротким стеком: подходящая рука и возможность забрать банк фолдом соперников; поздняя стадия не требует обязательной пассивности."
      : analysis.strong
        ? "Повышение на добор с сильной рукой против предполагаемого диапазона."
        : analysis.draw
          ? "Полублеф: есть возможность усилиться и забрать банк фолдом соперника."
          : analysis.preferred.includes(action)
            ? "Рука входит в учебный диапазон повышения для этой позиции."
            : "Редкий блеф по вероятностной политике; успех не гарантирован.";
  else if (action === "fold")
    reason = analysis.survivalRisk
      ? "Осторожный фолд на поздней стадии: крупный колл против покрывающего стека требует большего запаса, чем одна цена банка. Это учебное правило, не точный ICM."
      : "Цена продолжения или позиция не подходят силе руки по учебной модели.";
  else if (action === "check")
    reason = analysis.strong
      ? "Чек с сильной рукой сохраняет слабые руки соперника в раздаче."
      : "Бесплатный чек: нет достаточного основания раздувать банк.";
  else
    reason = analysis.strong
      ? "Колл с сильной рукой сохраняет блефы и слабую часть диапазона соперника."
      : "Колл по текущей цене с учётом предполагаемого диапазона и возможности усиления.";
  return {
    action,
    ...(action === "raise" ? { total: analysis.suggestedRaiseTo } : {}),
    reason,
  };
}
