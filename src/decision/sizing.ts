import { rank, suit, validate } from "../core";
import type { ActionType, DecisionObservation, PublicPlayer } from "./engine";

/** Every row is a hypothetical range/runout sample, never the dealt hidden hand. */
export interface SizingSample {
  villainCards: number[];
  showdownShare: number;
}
export type SizingScenario = "base" | "tight" | "loose";
export interface SizingResponse {
  fold: number;
  call: number;
  raise: number;
  raiseTo?: number;
}
export interface SizingDetails {
  foldProbability: number;
  callProbability: number;
  raiseProbability: number;
  probeProbability: number;
  heroContinuesRaise: boolean;
  heroContinuesProbe: boolean;
  effectiveTotal?: number;
}
export interface SizingCandidate {
  action: ActionType;
  total?: number;
  ev: number;
  standardError: number;
  sensitivityLow: number;
  sensitivityHigh: number;
  reason: string;
  /** Paired, conditional expected payoffs, aligned with the same sample bank. */
  values: number[];
  scenarios: Record<SizingScenario, number>;
  details: SizingDetails;
  /** Large deep-stack overbets are evaluated but not trusted as recommendations. */
  trusted: boolean;
}
export interface SizingAnalysis {
  supported: boolean;
  unsupportedReason?: string;
  samples: readonly SizingSample[];
  sampleCount: number;
  candidates: SizingCandidate[];
  best?: SizingCandidate;
  assumptions: string[];
  protection: boolean;
}
export interface SizingFeedback {
  verdict: "good" | "reasonable" | "risky" | "mistake" | "uncertain";
  title: string;
  reason: string;
}
export interface SizingChoice {
  action: ActionType;
  total?: number;
  reason: string;
}

const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-clamp(x, -35, 35)));
const SCENARIOS: SizingScenario[] = ["base", "tight", "loose"];
const chips = (n: number) => Math.round(n).toLocaleString("ru-RU");
const currentPlayers = (o: DecisionObservation) => {
  const hero = o.players.find((p) => p.id === o.actorId)!;
  const villain = o.players.find((p) => p.id !== o.actorId && !p.folded)!;
  return { hero, villain };
};
const maximum = (p: PublicPlayer) => p.streetCommitted + p.stack;
const mean = (values: readonly number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
function standardError(values: readonly number[]) {
  if (values.length < 2) return Infinity;
  const m = mean(values);
  return Math.sqrt(
    values.reduce((sum, v) => sum + (v - m) ** 2, 0) /
      (values.length - 1) /
      values.length,
  );
}

function unsupported(o: DecisionObservation): string | undefined {
  const active = o.players.filter((p) => !p.folded);
  if (o.street === "preflop")
    return "Модель размеров пока рассчитана только для постфлопа.";
  if (active.length !== 2)
    return "Для нескольких соперников модель размеров пока не поддерживается.";
  if (!active.some((p) => p.id === o.actorId))
    return "Нет активного игрока, принимающего решение.";
  if (active.some((p) => p.allIn || p.stack <= 0))
    return "Разбор размеров при уже существующем олл-ине пока не поддерживается.";
  const prior = active.map((p) => p.committed - p.antePaid - p.streetCommitted);
  const cap = Math.min(
    ...active.map((p) => p.committed - p.antePaid + p.stack),
  );
  if (
    prior[0] !== prior[1] ||
    o.players.some((p) => p.folded && p.committed - p.antePaid > cap)
  )
    return "Для побочных банков нужен отдельный разбор размеров.";
  return undefined;
}

interface Made {
  strength: number;
  draw: number;
  vulnerable: boolean;
}
/** Current-card description for an authored policy, not a winning probability.
 * It sees only the owner of these two cards and the public board.
 */
function made(cards: readonly number[], board: readonly number[]): Made {
  const all = [...cards, ...board],
    counts = new Map<number, number>();
  for (const c of all) counts.set(rank(c), (counts.get(rank(c)) ?? 0) + 1);
  const own = cards.map(rank),
    br = board.map(rank),
    maxBoard = Math.max(...br);
  const pairs = [...counts]
    .filter(([, n]) => n >= 2)
    .map(([r]) => r)
    .sort((a, b) => b - a);
  const trips = [...counts]
    .filter(([, n]) => n >= 3)
    .map(([r]) => r)
    .sort((a, b) => b - a);
  const quads = [...counts].some(([, n]) => n === 4);
  const boardPairs = [...new Set(br)].filter(
    (r) => br.filter((v) => v === r).length >= 2,
  );
  const flushSuit = [0, 1, 2, 3].find(
    (s) => all.filter((c) => suit(c) === s).length >= 5,
  );
  const straight = (rs: number[]) => {
    const set = new Set(rs);
    if (set.has(14)) set.add(1);
    for (let high = 14; high >= 5; high--)
      if ([0, 1, 2, 3, 4].every((n) => set.has(high - n))) return true;
    return false;
  };
  let strength: number;
  if (
    flushSuit !== undefined &&
    straight(all.filter((c) => suit(c) === flushSuit).map(rank))
  )
    strength = 0.999;
  else if (quads)
    strength = own.some((r) => counts.get(r) === 4)
      ? 0.99
      : 0.25 + Math.max(...own) / 24;
  else if (trips.length && pairs.some((r) => r !== trips[0])) strength = 0.96;
  else if (flushSuit !== undefined) strength = 0.9;
  else if (straight(all.map(rank))) strength = 0.84;
  else if (trips.length)
    strength = own.includes(trips[0]) ? 0.86 : 0.2 + Math.max(...own) / 45;
  else if (pairs.length >= 2) {
    const privatePair = pairs.find(
      (r) => own.includes(r) && !boardPairs.includes(r),
    );
    strength =
      privatePair !== undefined && boardPairs.length
        ? 0.37 + (privatePair / 14) * 0.18
        : privatePair !== undefined
          ? 0.73
          : 0.18 + Math.max(...own) / 80;
  } else if (pairs.length) {
    const privatePair =
      own.includes(pairs[0]) && !boardPairs.includes(pairs[0]);
    strength = privatePair
      ? pairs[0] > maxBoard
        ? 0.72
        : pairs[0] === maxBoard
          ? 0.61 + Math.min(...own) / 200
          : 0.33 + (pairs[0] / 14) * 0.13
      : 0.15 +
        Math.max(...own) / 110 +
        (Math.min(...own) > maxBoard ? 0.04 : 0);
  } else
    strength =
      0.07 + Math.max(...own) / 100 + (Math.min(...own) > maxBoard ? 0.04 : 0);
  let draw = 0;
  if (board.length < 5) {
    if (
      [0, 1, 2, 3].some(
        (s) =>
          all.filter((c) => suit(c) === s).length === 4 &&
          cards.some((c) => suit(c) === s),
      )
    )
      draw += board.length === 3 ? 0.18 : 0.09;
    const rs = new Set(all.map(rank));
    if (rs.has(14)) rs.add(1);
    if (
      Array.from({ length: 10 }, (_, i) => i + 5).some((high) => {
        const window = [0, 1, 2, 3, 4].map((n) => high - n);
        return (
          window.filter((r) => rs.has(r)).length === 4 &&
          own.some(
            (r) =>
              !br.includes(r) &&
              (window.includes(r) || (r === 14 && window.includes(1))),
          )
        );
      })
    )
      draw += board.length === 3 ? 0.1 : 0.05;
  }
  return {
    strength: clamp(strength, 0, 1),
    draw: Math.min(draw, 0.25),
    vulnerable:
      board.length < 5 &&
      strength >= 0.3 &&
      strength < 0.76 &&
      pairs.some((r) => own.includes(r) && r < 14),
  };
}

function effectiveTarget(o: DecisionObservation, total: number) {
  const { hero, villain } = currentPlayers(o);
  return Math.min(total, maximum(hero), maximum(villain));
}

/** A royal flush on the board is an unconditional chop, independent of holes.
 * Quads with the highest possible board kicker are unconditional chops too.
 */
function sharedUnbeatableBoard(board: readonly number[]): boolean {
  if (board.length !== 5) return false;
  const rs = board.map(rank),
    sameSuit = board.every((c) => suit(c) === suit(board[0]));
  if (sameSuit && [10, 11, 12, 13, 14].every((r) => rs.includes(r)))
    return true;
  const quad = rs.find((r) => rs.filter((v) => v === r).length === 4);
  const kicker = rs.find((r) => r !== quad);
  return (
    quad !== undefined && (kicker === 14 || (quad === 14 && kicker === 13))
  );
}

/** Exact current-street accounting: prior contributions are sunk, not charged twice. */
export function currentStreetCallEV(
  o: DecisionObservation,
  share: number,
): number {
  const { hero, villain } = currentPlayers(o);
  const cost = Math.min(
    hero.stack,
    Math.max(0, o.currentBet - hero.streetCommitted),
  );
  const refund = Math.max(
    0,
    villain.streetCommitted - hero.streetCommitted - cost,
  );
  return share * (o.pot + cost - refund) - cost;
}
/** Raise was called; chips beyond the opponent's reachable stack are refunded. */
export function calledRaiseEV(
  o: DecisionObservation,
  share: number,
  total: number,
): number {
  const { hero, villain } = currentPlayers(o),
    target = effectiveTarget(o, total);
  const ownCost = Math.max(0, target - hero.streetCommitted),
    otherCost = Math.max(0, target - villain.streetCommitted);
  return share * (o.pot + ownCost + otherCost) - ownCost;
}

/** Opponent responses cannot read heroCards or the sampled runout/winner. */
export function sizingResponse(
  o: DecisionObservation,
  villainCards: number[],
  heroTotal: number,
  scenario: SizingScenario = "base",
): SizingResponse {
  if (sharedUnbeatableBoard(o.board)) return { fold: 0, call: 1, raise: 0 };
  const { hero, villain } = currentPlayers(o),
    target = effectiveTarget(o, heroTotal),
    f = made(villainCards, o.board);
  const cost = Math.max(0, target - villain.streetCommitted),
    potAtDecision = o.pot + Math.max(0, target - hero.streetCommitted);
  const odds = cost / Math.max(1, potAtDecision + cost),
    pressure = cost / Math.max(1, villain.stack);
  const position = o.dealerSeat === villain.seat ? -0.015 : 0.015;
  const profile =
    villain.profile === "tight"
      ? 0.045
      : villain.profile === "loose"
        ? -0.045
        : 0;
  const sensitivity =
    scenario === "tight" ? 0.075 : scenario === "loose" ? -0.075 : 0;
  const historyRaises = o.history.filter(
    (a) =>
      a.street === o.street && (a.action === "raise" || a.action === "all-in"),
  ).length;
  const cutoff =
    0.4 +
    0.55 * (odds - 0.2) +
    0.12 * pressure +
    profile +
    position +
    sensitivity +
    Math.min(0.08, historyRaises * 0.02);
  const drawValue = f.draw * clamp((0.48 - odds) / 0.28, 0, 1);
  // Price alone tends to 50% for an arbitrarily large overbet. The response
  // therefore also has explicit pot-relative elasticity, with no fixed call
  // floor that would invent profitable 50-pot value shoves against weak hands.
  const relativeSize =
    cost /
    Math.max(1, o.pot + Math.max(0, o.currentBet - hero.streetCommitted));
  const elasticity = f.strength >= 0.95 ? 0.35 : f.strength >= 0.84 ? 1.3 : 1.6;
  const continuing = clamp(
    sigmoid((f.strength + drawValue - cutoff) / 0.105) /
      Math.max(1, relativeSize) ** elasticity,
    0,
    1,
  );
  const minRaise = target + Math.max(o.minRaise, target - o.currentBet);
  const raiseTo = Math.min(
    maximum(villain),
    Math.max(minRaise, Math.round(target * 2.5)),
  );
  const canReraise =
    target < maximum(hero) && target < maximum(villain) && raiseTo > target;
  const aggression =
    scenario === "tight" ? 0.78 : scenario === "loose" ? 1.2 : 1;
  const raising = canReraise
    ? Math.min(
        continuing * 0.8,
        aggression *
          (0.009 +
            0.75 *
              sigmoid((f.strength - 0.79 - historyRaises * 0.025) / 0.075) +
            f.draw * 0.12),
      )
    : 0;
  return {
    fold: 1 - continuing,
    call: continuing - raising,
    raise: raising,
    ...(canReraise ? { raiseTo } : {}),
  };
}

function probe(
  o: DecisionObservation,
  cards: number[],
  scenario: SizingScenario,
) {
  if (sharedUnbeatableBoard(o.board)) return { probability: 0, total: 0 };
  const { hero, villain } = currentPlayers(o);
  const alreadyChecked = o.history.some(
    (a) =>
      a.street === o.street && a.actorId === villain.id && a.action === "check",
  );
  if (alreadyChecked) return { probability: 0, total: 0 };
  const f = made(cards, o.board),
    profile =
      villain.profile === "tight"
        ? 0.78
        : villain.profile === "loose"
          ? 1.22
          : 1;
  const sensitivity =
    scenario === "tight" ? 0.7 : scenario === "loose" ? 1.28 : 1;
  const probability = clamp(
    (0.08 + 0.58 * sigmoid((f.strength - 0.65) / 0.1) + f.draw * 0.45) *
      profile *
      sensitivity,
    0.02,
    0.92,
  );
  const total = Math.min(
    maximum(villain),
    Math.max(o.bigBlind, Math.round(o.pot * 0.33)),
  );
  return { probability, total: Math.min(total, maximum(hero)) };
}

interface Evaluated {
  values: number[];
  details: SizingDetails;
}
function evaluateScenario(
  o: DecisionObservation,
  bank: readonly SizingSample[],
  action: ActionType,
  total: number | undefined,
  scenario: SizingScenario,
): Evaluated {
  const { hero, villain } = currentPlayers(o);
  const details: SizingDetails = {
    foldProbability: 0,
    callProbability: 0,
    raiseProbability: 0,
    probeProbability: 0,
    heroContinuesRaise: false,
    heroContinuesProbe: false,
  };
  const aggressive =
    action === "raise" || (action === "all-in" && maximum(hero) > o.currentBet);
  if (action === "fold") return { values: bank.map(() => 0), details };
  if (!aggressive && action !== "check")
    return {
      values: bank.map((s) => currentStreetCallEV(o, s.showdownShare)),
      details,
    };
  if (action === "check") {
    const probes = bank.map((s) => probe(o, s.villainCards, scenario));
    const probeMass = probes.reduce((sum, p) => sum + p.probability, 0);
    const callValues = bank.map((s, i) =>
      calledRaiseEV(o, s.showdownShare, probes[i].total),
    );
    const callMean =
      probeMass > 0
        ? callValues.reduce((sum, v, i) => sum + v * probes[i].probability, 0) /
          probeMass
        : 0;
    // A single aggregate response at the information set, never per-runout maximization.
    details.heroContinuesProbe = probeMass > 0 && callMean > 0;
    details.probeProbability = probeMass / bank.length;
    return {
      values: bank.map(
        (s, i) =>
          (1 - probes[i].probability) * s.showdownShare * o.pot +
          probes[i].probability *
            (details.heroContinuesProbe ? callValues[i] : 0),
      ),
      details,
    };
  }
  const target = effectiveTarget(
    o,
    action === "all-in" ? maximum(hero) : total!,
  );
  details.effectiveTotal = target;
  const ownCost = Math.max(0, target - hero.streetCommitted);
  const responses = bank.map((s) =>
    sizingResponse(o, s.villainCards, target, scenario),
  );
  const raiseMass = responses.reduce((sum, p) => sum + p.raise, 0);
  const raiseCalls = bank.map((s, i) =>
    calledRaiseEV(o, s.showdownShare, responses[i].raiseTo ?? target),
  );
  const afterRaiseMean =
    raiseMass > 0
      ? raiseCalls.reduce((sum, v, i) => sum + v * responses[i].raise, 0) /
        raiseMass
      : -ownCost;
  details.heroContinuesRaise = raiseMass > 0 && afterRaiseMean > -ownCost;
  details.foldProbability = mean(responses.map((p) => p.fold));
  details.callProbability = mean(responses.map((p) => p.call));
  details.raiseProbability = raiseMass / bank.length;
  return {
    values: bank.map(
      (s, i) =>
        responses[i].fold * o.pot +
        responses[i].call * calledRaiseEV(o, s.showdownShare, target) +
        responses[i].raise *
          (details.heroContinuesRaise ? raiseCalls[i] : -ownCost),
    ),
    details,
  };
}

function candidate(
  o: DecisionObservation,
  bank: readonly SizingSample[],
  action: ActionType,
  total?: number,
): SizingCandidate {
  const base = evaluateScenario(o, bank, action, total, "base");
  const scenarios = {
    base: mean(base.values),
    tight: mean(evaluateScenario(o, bank, action, total, "tight").values),
    loose: mean(evaluateScenario(o, bank, action, total, "loose").values),
  };
  const aggressive =
    action === "raise" || (action === "all-in" && o.maxRaiseTo > o.currentBet);
  const { hero } = currentPlayers(o),
    toCall = Math.min(
      hero.stack,
      Math.max(0, o.currentBet - hero.streetCommitted),
    );
  const trusted =
    !aggressive ||
    effectiveTarget(o, action === "all-in" ? maximum(hero) : total!) -
      o.currentBet <=
      2 * Math.max(1, o.pot + toCall);
  return {
    action,
    ...(total !== undefined ? { total } : {}),
    ev: scenarios.base,
    standardError: standardError(base.values),
    sensitivityLow: Math.min(...Object.values(scenarios)),
    sensitivityHigh: Math.max(...Object.values(scenarios)),
    values: base.values,
    scenarios,
    details: base.details,
    trusted,
    reason: aggressive
      ? "Ожидаемые фолды, коллы и один ререйз в ограниченной модели текущей улицы."
      : action === "check"
        ? "Чек учитывает возможную ставку соперника и один общий ответ колл/фолд."
        : "Учтены только текущая цена и условное вскрытие после этой улицы.",
  };
}

const ASSUMPTIONS = [
  "Это авторская модель одной улицы для двух активных игроков без готовых олл-инов и побочных банков, не GTO и не полный постфлоп-солвер.",
  "Для каждого размера учитываются фолд, колл и один ререйз соперника; после чека — возможная ставка. Ответ героя выбирается по общему условному диапазону, а не по будущему исходу каждой выборки.",
  "Решения соперника используют только его гипотетические карты, открытый борд, профиль, позиции, историю и размер ставки; настоящие скрытые карты и будущий борд не читаются.",
  "После ограниченного дерева текущей улицы оставшийся борд доигрывается до условного вскрытия без новых ставок. Следующие улицы, точный ICM и полное дерево повышений не решены.",
  "Устойчивость проверяется при более узких и более широких ответах на той же выборке. Парная погрешность не измеряет ошибку самой стратегической модели.",
  "Повышения более чем на два банка после колла оцениваются как грубая экстраполяция. Они не используются как эталон или рекомендация боту; для такой глубокой ставки разбор остаётся неоднозначным. Короткие эффективные олл-ины внутри этой границы поддерживаются.",
];

export function analyzeSizing(
  o: DecisionObservation,
  samples: readonly SizingSample[],
): SizingAnalysis {
  const unsupportedReason = unsupported(o);
  const analysis: SizingAnalysis = {
    supported: !unsupportedReason,
    unsupportedReason,
    samples,
    sampleCount: samples.length,
    candidates: [],
    assumptions: [...ASSUMPTIONS],
    protection: false,
  };
  if (unsupportedReason) return analysis;
  if (!samples.length)
    return {
      ...analysis,
      supported: false,
      unsupportedReason: "Нет выборки предполагаемых рук и бордов.",
    };
  for (const sample of samples) {
    validate([...o.heroCards, ...o.board, ...sample.villainCards]);
    if (
      sample.villainCards.length !== 2 ||
      !Number.isFinite(sample.showdownShare) ||
      sample.showdownShare < 0 ||
      sample.showdownShare > 1
    )
      throw Error("Некорректная выборка для модели размеров.");
  }
  analysis.protection =
    o.street !== "river" && made(o.heroCards, o.board).vulnerable;
  const { hero } = currentPlayers(o);
  const toCall = Math.min(
    hero.stack,
    Math.max(0, o.currentBet - hero.streetCommitted),
  );
  if (toCall > 0) {
    analysis.candidates.push(
      candidate(o, samples, "fold"),
      candidate(o, samples, "call"),
    );
  } else analysis.candidates.push(candidate(o, samples, "check"));
  if (o.canRaise) {
    const seen = new Set<number>();
    for (const fraction of [0.25, 0.33, 0.5, 0.66, 1]) {
      const total = Math.min(
        maximum(hero),
        Math.max(
          o.minRaiseTo,
          o.currentBet + Math.round((o.pot + toCall) * fraction),
        ),
      );
      if (total <= o.currentBet || seen.has(total)) continue;
      seen.add(total);
      analysis.candidates.push(
        candidate(
          o,
          samples,
          total === maximum(hero) && o.legalActions.includes("all-in")
            ? "all-in"
            : "raise",
          total,
        ),
      );
    }
    if (o.legalActions.includes("all-in") && !seen.has(maximum(hero)))
      analysis.candidates.push(candidate(o, samples, "all-in", maximum(hero)));
  }
  analysis.best = analysis.candidates
    .filter((c) => c.trusted)
    .reduce((best, c) => (c.ev > best.ev ? c : best));
  return analysis;
}

/** Evaluate the exact entered amount on the same bank, never a nearest-size bucket. */
export function evaluateSizingAction(
  o: DecisionObservation,
  analysis: SizingAnalysis,
  action: ActionType,
  total?: number,
): SizingCandidate | undefined {
  if (!analysis.supported) return undefined;
  if (
    action === "raise" &&
    (!Number.isSafeInteger(total) ||
      total! <= o.currentBet ||
      total! > o.maxRaiseTo ||
      (total! < o.minRaiseTo && total !== o.maxRaiseTo))
  )
    return undefined;
  if (!o.legalActions.includes(action)) return undefined;
  const target = action === "all-in" ? o.maxRaiseTo : total;
  return (
    analysis.candidates.find(
      (c) => c.action === action && c.total === target,
    ) ?? candidate(o, analysis.samples, action, target)
  );
}

export function gradeSizing(
  o: DecisionObservation,
  analysis: SizingAnalysis,
  action: ActionType,
  total?: number,
): SizingFeedback | undefined {
  if (!analysis.supported || !analysis.best) return undefined;
  const actual = evaluateSizingAction(o, analysis, action, total);
  if (!actual) return undefined;
  const best = analysis.best,
    paired = standardError(
      actual.values.map((value, i) => best.values[i] - value),
    );
  const tolerance = Math.max(o.pot * 0.05, o.bigBlind * 0.25, paired * 2);
  const regrets = SCENARIOS.map((s) => best.scenarios[s] - actual.scenarios[s]);
  const scenarioBestRegrets = SCENARIOS.map(
    (s) =>
      Math.max(
        actual.scenarios[s],
        ...analysis.candidates
          .filter((c) => c.trusted)
          .map((c) => c.scenarios[s]),
      ) - actual.scenarios[s],
  );
  const loss = best.ev - actual.ev,
    robust = Math.min(...regrets) > Math.max(tolerance, o.pot * 0.1);
  const aggressive =
    action === "raise" || (action === "all-in" && o.maxRaiseTo > o.currentBet);
  const amount = action === "all-in" ? o.maxRaiseTo : total;
  const fraction = aggressive
    ? Math.max(0, amount! - o.currentBet) /
      Math.max(
        1,
        o.pot +
          Math.max(0, o.currentBet - currentPlayers(o).hero.streetCommitted),
      )
    : 0;
  const sizeText = aggressive
    ? `Размер до ${chips(amount!)} — около ${Math.round(fraction * 100)}% ${o.currentBet > 0 ? "банка после колла" : "банка"}. `
    : "";
  const protection =
    analysis.protection && aggressive && fraction <= 0.5
      ? "Небольшая ставка может лишить оверкарты части их шансов и иногда собрать оплату с более слабых рук; эффект зависит от того, какие руки ответят. "
      : "";
  if (analysis.sampleCount < 80)
    return {
      verdict: "uncertain",
      title: "Недостаточно данных для размера",
      reason:
        sizeText +
        "Для уверенного сравнения размеров выборка слишком мала; это не доказательство ошибки.",
    };
  if (!actual.trusted)
    return {
      verdict: "uncertain",
      title: "Слишком далеко за проверенной моделью размеров",
      reason:
        sizeText +
        "Эффективное повышение превышает два банка после колла. Ответы на такой глубокий овербет здесь лишь экстраполированы, поэтому модель не может надёжно одобрить или осудить размер.",
    };
  if (
    (action === "call" || (action === "all-in" && !aggressive)) &&
    o.street === "river" &&
    actual.sensitivityHigh + 2 * actual.standardError <
      -Math.max(o.pot * 0.1, o.bigBlind * 0.25)
  )
    return {
      verdict: "mistake",
      title: "Слишком дорогой колл",
      reason:
        "На ривере оценка колла существенно отрицательна при всех проверенных вариантах ответов и с учётом шума. Против предполагаемого диапазона лучше фолд; это не утверждение о реальных скрытых картах.",
    };
  if (
    loss <= tolerance &&
    Math.max(...scenarioBestRegrets) > Math.max(tolerance, o.pot * 0.1)
  )
    return {
      verdict: "uncertain",
      title: "Ответ соперника меняет выбор размера",
      reason:
        sizeText +
        protection +
        "При других правдоподобных ответах заметно лучше оказывается другой размер или действие. Одного выигрыша в базовой модели недостаточно, чтобы уверенно одобрить этот выбор.",
    };
  if (loss <= tolerance)
    return {
      verdict: "reasonable",
      title: aggressive ? "Допустимый размер ставки" : "Допустимое действие",
      reason:
        sizeText +
        protection +
        "В ограниченной модели действие близко к лучшим вариантам с учётом шума. Это не доказательство оптимального размера на всех следующих улицах.",
    };
  if (!robust)
    return {
      verdict: "uncertain",
      title: "Размер зависит от ответов соперника",
      reason:
        sizeText +
        protection +
        "Преимущество другого размера меняется при более узких или широких ответах соперника либо сравнимо с погрешностью; уверенной ошибки здесь нет.",
    };
  const bestAggressive =
    best.action === "raise" ||
    (best.action === "all-in" && o.maxRaiseTo > o.currentBet);
  if (aggressive && bestAggressive && best.total !== undefined) {
    const more = best.total > amount!;
    return {
      verdict: "risky",
      title: more
        ? "В этой модели можно поставить больше"
        : "В этой модели лучше меньший размер",
      reason:
        sizeText +
        `Сравнение фолдов, коллов и ререйзов устойчиво предпочитает размер до ${chips(best.total)} на этой улице. Предположения о диапазонах и следующих улицах могут изменить результат; это не точный GTO-сайзинг.`,
    };
  }
  return {
    verdict: "risky",
    title: aggressive
      ? "Ставка спорна против этого диапазона"
      : "Есть более подходящее действие",
    reason:
      sizeText +
      (aggressive
        ? "В ограниченной модели чек или колл сохраняет больше ожидаемых фишек, чем эта ставка. "
        : "Ограниченная модель предпочитает другой способ продолжить. ") +
      "Это сравнение авторских ответов на текущей улице, а не решение всей раздачи.",
  };
}

export function chooseSizingAction(
  o: DecisionObservation,
  analysis: SizingAnalysis,
): SizingChoice | undefined {
  if (!analysis.supported || !analysis.best) return undefined;
  const raises = o.history.filter(
    (a) =>
      a.street === o.street &&
      (a.action === "raise" || a.action === "all-in") &&
      a.total > 0,
  ).length;
  const available = analysis.candidates.filter(
    (c) =>
      c.trusted &&
      (raises < 3 ||
        c.action === "fold" ||
        c.action === "call" ||
        c.action === "check"),
  );
  if (!available.length) return undefined;
  let best = available.reduce((a, b) => (b.ev > a.ev ? b : a));
  const passive = available.find(
    (c) => c.action === "check" || c.action === "call",
  );
  if (
    passive &&
    best.ev - passive.ev <=
      Math.max(
        o.pot * 0.02,
        2 * standardError(best.values.map((v, i) => v - passive.values[i])),
      )
  )
    best = passive;
  return {
    action: best.action,
    ...(best.total !== undefined ? { total: best.total } : {}),
    reason:
      best.action === "raise" || best.action === "all-in"
        ? "Размер выбран сравнением ожидаемых ответов на текущей улице; дальнейшая игра не решена как GTO."
        : "Выбрано продолжение по цене банка и ограниченной модели ответов на текущей улице.",
  };
}
