import { describe, expect, it } from "vitest";
import { compare, evaluate } from "../src/core";
import { applyAction, createTrainingHand, observe, type DecisionObservation } from "../src/decision/engine";
import { analyzeDecision, chooseBotAction, gradeDecision } from "../src/decision/policy";
import {
  analyzeSizing,
  calledRaiseEV,
  chooseSizingAction,
  currentStreetCallEV,
  evaluateSizingAction,
  gradeSizing,
  sizingResponse,
  type SizingSample,
} from "../src/decision/sizing";

const card = (rank: number, suit = 0) => (rank - 2) * 4 + suit;

/** A physically possible HU flop after both players put in 400 live chips,
 * plus the BB's 200 dead ante. The opponent has checked to the button. */
function flop(): DecisionObservation {
  return {
    tournamentStage: "early",
    street: "flop",
    board: [card(12), card(12, 1), card(3, 2)],
    heroCards: [card(5, 2), card(5, 3)],
    actorId: "hero",
    dealerSeat: 0,
    smallBlind: 100,
    bigBlind: 200,
    ante: 200,
    currentBet: 0,
    minRaise: 200,
    canRaise: true,
    pot: 1000,
    toCall: 0,
    minRaiseTo: 200,
    maxRaiseTo: 10000,
    legalActions: ["check", "raise", "all-in"],
    history: [
      { street: "preflop", actorId: "villain", action: "ante", total: 200, paid: 200 },
      { street: "preflop", actorId: "hero", action: "small-blind", total: 100, paid: 100 },
      { street: "preflop", actorId: "villain", action: "big-blind", total: 200, paid: 200 },
      { street: "preflop", actorId: "hero", action: "raise", total: 400, paid: 300 },
      { street: "preflop", actorId: "villain", action: "call", total: 400, paid: 200 },
      { street: "flop", actorId: "villain", action: "check", total: 0, paid: 0 },
    ],
    players: [
      { id: "hero", name: "Вы", seat: 0, startStack: 10400, stack: 10000, committed: 400,
        streetCommitted: 0, antePaid: 0, folded: false, allIn: false, profile: "balanced" },
      { id: "villain", name: "Бот", seat: 1, startStack: 10600, stack: 10000, committed: 600,
        streetCommitted: 0, antePaid: 200, folded: false, allIn: false, profile: "balanced" },
    ],
  };
}

function facingBet(villainTotal: number, heroLive = 0): DecisionObservation {
  const o = flop();
  const hero = o.players[0], villain = o.players[1];
  hero.stack -= heroLive;
  hero.committed += heroLive;
  hero.streetCommitted = heroLive;
  villain.stack -= villainTotal;
  villain.committed += villainTotal;
  villain.streetCommitted = villainTotal;
  o.currentBet = villainTotal;
  o.minRaise = Math.max(o.bigBlind, villainTotal);
  o.minRaiseTo = o.currentBet + o.minRaise;
  o.toCall = Math.min(hero.stack, villainTotal - heroLive);
  o.pot += heroLive + villainTotal;
  o.legalActions = ["fold", "call", "raise", "all-in"];
  o.history[o.history.length - 1] = {
    street: "flop", actorId: "villain", action: "raise", total: villainTotal, paid: villainTotal,
  };
  return o;
}

/** Independent complete enumeration of the remaining turn/river pairs. Used
 * only for test beliefs, not the implementation's response or hand ordering. */
function exactOutcomes(o: DecisionObservation, villainCards: number[]): number[] {
  const known = new Set([...o.heroCards, ...o.board, ...villainCards]);
  const remaining = Array.from({ length: 52 }, (_, index) => index).filter(c => !known.has(c));
  const shares: number[] = [];
  const score = (board: number[]) => {
    const result = compare(evaluate([...o.heroCards, ...board]), evaluate([...villainCards, ...board]));
    shares.push(result > 0 ? 1 : result === 0 ? .5 : 0);
  };
  if (o.board.length === 5) score(o.board);
  else if (o.board.length === 4) remaining.forEach(c => score([...o.board, c]));
  else for (let a = 0; a < remaining.length; a++)
    for (let b = a + 1; b < remaining.length; b++) score([...o.board, remaining[a], remaining[b]]);
  return shares;
}

function bank(o: DecisionObservation, combos = [
  [card(14), card(13, 1)], [card(14, 1), card(11, 3)],
  [card(13, 2), card(10, 3)], [card(11), card(10, 1)],
]): SizingSample[] {
  return combos.flatMap(villainCards => exactOutcomes(o, villainCards).map(showdownShare => ({ villainCards, showdownShare })));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("bounded postflop sizing: chip accounting", () => {
  it("compares legal pot-fraction sizes and the shove without non-finite scores", () => {
    const o = flop();
    const sizing = analyzeSizing(o, bank(o));
    const totals = sizing.candidates.filter(candidate => candidate.action === "raise").map(candidate => candidate.total!);
    expect(totals).toContain(250);
    expect(totals.some(total => total >= 320 && total <= 340)).toBe(true);
    expect(totals).toContain(500);
    expect(totals.some(total => total >= 650 && total <= 680)).toBe(true);
    expect(totals).toContain(1000);
    expect(sizing.candidates.some(candidate => candidate.action === "all-in")).toBe(true);
    for (const candidate of sizing.candidates) {
      expect(Number.isFinite(candidate.ev)).toBe(true);
      expect(Number.isFinite(candidate.standardError)).toBe(true);
      expect(candidate.standardError).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(candidate.sensitivityLow)).toBe(true);
      expect(Number.isFinite(candidate.sensitivityHigh)).toBe(true);
      expect(candidate.sensitivityLow).toBeLessThanOrEqual(candidate.ev);
      expect(candidate.sensitivityHigh).toBeGreaterThanOrEqual(candidate.ev);
    }
  });

  it("values a free check as raw showdown share of the current pot, with no sunk-cost charge", () => {
    const o = flop();
    o.canRaise = false;
    o.legalActions = ["check"];
    const samples: SizingSample[] = [
      { villainCards: [card(14), card(13, 1)], showdownShare: 1 },
      { villainCards: [card(12, 2), card(14, 1)], showdownShare: 0 },
      { villainCards: [card(7), card(8, 1)], showdownShare: .5 },
    ];
    const sizing = analyzeSizing(o, samples);
    expect(sizing.supported).toBe(true);
    const check = evaluateSizingAction(o, sizing, "check")!;
    expect(check.ev).toBeCloseTo(500, 10);
    expect(check.ev).not.toBeCloseTo(500 - o.players[0].committed, 10);
    expect(sizing.candidates.every(candidate => candidate.action === "check")).toBe(true);
  });

  it("charges only the remaining call and keeps folding at zero relative to this decision", () => {
    const o = facingBet(400, 100);
    o.canRaise = false;
    o.legalActions = ["fold", "call"];
    const samples: SizingSample[] = [
      { villainCards: [card(14), card(13, 1)], showdownShare: 1 },
      { villainCards: [card(12, 2), card(14, 1)], showdownShare: 0 },
    ];
    const sizing = analyzeSizing(o, samples);
    expect(evaluateSizingAction(o, sizing, "fold")!.ev).toBe(0);
    // Pot 1 500, another 300 to call: 0.5 * 1 800 - 300 = 600.
    expect(evaluateSizingAction(o, sizing, "call")!.ev).toBeCloseTo(600, 10);
  });

  it("never represents a check as a positive-cost call or supplies a raise without raise rights", () => {
    const o = facingBet(400);
    o.canRaise = false;
    o.legalActions = ["fold", "call"];
    const sizing = analyzeSizing(o, bank(o));
    expect(evaluateSizingAction(o, sizing, "check")).toBeUndefined();
    expect(evaluateSizingAction(o, sizing, "raise", 800)).toBeUndefined();
    expect(sizing.candidates.some(candidate => candidate.action === "check" || candidate.action === "raise")).toBe(false);
  });

  it("refunds a rival's unmatched overbet before pricing a short-stack call", () => {
    const o = facingBet(2000);
    Object.assign(o.players[0], { stack: 300, startStack: 700 });
    Object.assign(o, { toCall: 300, maxRaiseTo: 300, canRaise: false, legalActions: ["fold", "call", "all-in"] });
    // Current 3 000 includes the opponent's 2 000. Only 300 is matchable;
    // 1 700 returns, then hero pays 300. At half equity: 800 - 300 = 500.
    expect(currentStreetCallEV(o, .5)).toBeCloseTo(500, 10);
    expect(currentStreetCallEV(o, 1)).toBeCloseTo(1300, 10);
    expect(currentStreetCallEV(o, 0)).toBeCloseTo(-300, 10);
  });

  it("caps both called contributions at the effective stack instead of burning uncalled chips", () => {
    const o = flop();
    Object.assign(o.players[1], { stack: 1000, startStack: 1600 });
    // Hero may shove 10 000, but only 1 000 each can enter this HU pot.
    for (const total of [1000, 5000, 10000]) {
      expect(calledRaiseEV(o, .5, total)).toBeCloseTo(500, 10);
      expect(calledRaiseEV(o, 1, total)).toBeCloseTo(2000, 10);
      expect(calledRaiseEV(o, 0, total)).toBeCloseTo(-1000, 10);
    }
  });

  it("interprets a raise total as the current street total, charging only the added chips", () => {
    const o = facingBet(400, 100);
    // Hero adds 900, villain adds 600: final pot 1 500 + 900 + 600.
    expect(calledRaiseEV(o, .5, 1000)).toBeCloseTo(600, 10);
    expect(currentStreetCallEV(o, .5)).toBeCloseTo(600, 10);
  });

  it("credits only the old pot when a bet wins by folds, and loses only its new cost to a reraise-fold", () => {
    const o = flop();
    o.heroCards = [card(7, 2), card(2, 3)];
    const sizing = analyzeSizing(o, [{ villainCards: [card(12, 2), card(14)], showdownShare: 0 }]);
    const bet = evaluateSizingAction(o, sizing, "raise", 250)!;
    const response = sizingResponse(o, [card(12, 2), card(14)], 250);
    expect(bet.details.heroContinuesRaise).toBe(false);
    expect(response.fold + response.call + response.raise).toBeCloseTo(1, 12);
    // Isolate every branch explicitly. No extra copy of hero's 250 belongs
    // in the fold-win reward; sunk preflop contributions aren't charged again.
    const expected = response.fold * o.pot
      + response.call * calledRaiseEV(o, 0, 250)
      + response.raise * -250;
    expect(bet.ev).toBeCloseTo(expected, 8);
  });

  it("chooses one response to a reraise across the belief, never the winning answer for each hidden runout", () => {
    const o = flop();
    const villainCards = [card(12, 2), card(14)];
    const sizing = analyzeSizing(o, [
      { villainCards, showdownShare: 0 },
      { villainCards, showdownShare: 1 },
    ]);
    const bet = evaluateSizingAction(o, sizing, "raise", 250)!;
    const response = sizingResponse(o, villainCards, 250);
    expect(response.raise).toBeGreaterThan(0);
    expect(response.raiseTo).toBeDefined();
    expect(bet.details.heroContinuesRaise).toBe(true);
    // Hero's aggregate conditional equity is 1/2 in the raise branch. He cannot
    // fold only the losing runout and call only the winning one in this bank.
    const expected = response.fold * o.pot
      + response.call * calledRaiseEV(o, .5, 250)
      + response.raise * calledRaiseEV(o, .5, response.raiseTo!);
    expect(bet.ev).toBeCloseTo(expected, 8);
  });

  it("does not peek at each sampled outcome when deciding whether to call a probe after checking", () => {
    const o = flop();
    o.dealerSeat = 1; // Hero acts first and may face an in-position bet after checking.
    o.history.pop();
    const villainCards = [card(12, 2), card(14)];
    const sizing = analyzeSizing(o, [
      { villainCards, showdownShare: 0 },
      { villainCards, showdownShare: 1 },
    ]);
    const check = evaluateSizingAction(o, sizing, "check")!;
    expect(check.details.probeProbability).toBeGreaterThan(0);
    expect(check.details.heroContinuesProbe).toBe(true);
    // At half equity any matched probe returns P/2 on average. Per-row perfect
    // information would incorrectly turn losing calls into cost-free folds.
    expect(check.ev).toBeCloseTo(500, 8);
  });

  it("keeps dead money from folded players in a heads-up continuation", () => {
    const o = flop();
    o.players.push({ ...o.players[1], id: "folded", seat: 2, stack: 9900, startStack: 10000,
      committed: 100, antePaid: 0, folded: true });
    o.pot += 100;
    const sizing = analyzeSizing(o, [
      { villainCards: [card(12, 2), card(14)], showdownShare: 0 },
      { villainCards: [card(12, 2), card(14)], showdownShare: 1 },
    ]);
    expect(sizing.supported).toBe(true);
    expect(evaluateSizingAction(o, sizing, "check")!.ev).toBeCloseTo(550, 10);
  });
});

describe("sizing distinguishes protection, value, bluffing and missing support", () => {
  it("allows a small 55 protection bet on QQ3 without declaring it universally best", () => {
    const o = flop();
    const sizing = analyzeSizing(o, bank(o));
    expect(sizing.supported).toBe(true);
    for (const total of [250, 330]) {
      const feedback = gradeSizing(o, sizing, "raise", total);
      expect(feedback).toBeDefined();
      expect(["good", "reasonable", "uncertain"]).toContain(feedback!.verdict);
    }
    const small = evaluateSizingAction(o, sizing, "raise", 250)!;
    const large = evaluateSizingAction(o, sizing, "raise", 1000)!;
    expect(small.ev).not.toBeCloseTo(large.ev, 6);
  });

  it("does not approve the same protection bet against a range consisting of queens", () => {
    const o = flop();
    const samples = bank(o, [[card(12, 2), card(14)], [card(12, 3), card(13, 1)]]);
    const sizing = analyzeSizing(o, samples);
    expect(evaluateSizingAction(o, sizing, "raise", 250)!.ev).toBeLessThan(evaluateSizingAction(o, sizing, "check")!.ev);
    expect(["good", "reasonable", "uncertain"]).toContain(gradeSizing(o, sizing, "check")!.verdict);
    const feedback = gradeSizing(o, sizing, "raise", 250);
    expect(feedback).toBeDefined();
    expect(["risky", "mistake", "uncertain"]).toContain(feedback!.verdict);
  });

  it("does not automatically approve every small bet with a no-draw trash hand", () => {
    const o = flop();
    o.heroCards = [card(7, 2), card(2, 3)];
    const sizing = analyzeSizing(o, bank(o, [[card(12, 2), card(14)], [card(12, 3), card(13, 1)]]));
    const feedback = gradeSizing(o, sizing, "raise", 250);
    expect(feedback).toBeDefined();
    expect(["risky", "mistake", "uncertain"]).toContain(feedback!.verdict);
  });

  it("returns no confident action for unsupported multiway pots", () => {
    const o = flop();
    o.players.push({ ...o.players[1], id: "third", seat: 2, antePaid: 0 });
    o.pot += o.players[2].committed;
    const sizing = analyzeSizing(o, bank(o));
    expect(sizing.supported).toBe(false);
    expect(sizing.unsupportedReason).toBeTruthy();
    expect(chooseSizingAction(o, sizing)).toBeUndefined();
    expect(gradeSizing(o, sizing, "raise", 250)).toBeUndefined();
    const integrated = analyzeDecision(o, { seed: 234, samples: 100 });
    expect(gradeDecision(o, integrated, "raise", 250).verdict).toBe("uncertain");
  });

  it("declines unsupported existing all-in pots instead of inventing a response", () => {
    const o = flop();
    Object.assign(o.players[1], { stack: 0, startStack: 600, allIn: true });
    o.canRaise = false;
    o.legalActions = ["check"];
    const sizing = analyzeSizing(o, bank(o));
    expect(sizing.supported).toBe(false);
    expect(sizing.unsupportedReason).toBeTruthy();
    expect(chooseSizingAction(o, sizing)).toBeUndefined();
  });

  it("does not label a river bet as equity denial against future cards", () => {
    const o = flop();
    o.street = "river";
    o.board.push(card(14, 2), card(2, 3));
    const sizing = analyzeSizing(o, bank(o));
    expect(sizing.supported).toBe(true);
    expect(sizing.protection).toBe(false);
  });

  it("checks a royal flush entirely on the board instead of inventing protection or folding", () => {
    const o = flop();
    o.street = "river";
    o.board = [card(14), card(13), card(12), card(11), card(10)];
    const samples = Array.from({ length: 120 }, () => ({
      villainCards: [card(7, 1), card(2, 3)], showdownShare: .5,
    }));
    const sizing = analyzeSizing(o, samples);
    expect(sizing.protection).toBe(false);
    expect(chooseSizingAction(o, sizing)?.action).toBe("check");
    expect(["reasonable", "good", "uncertain"]).toContain(gradeSizing(o, sizing, "check")!.verdict);
    expect(sizing.candidates.some(candidate => candidate.action === "fold")).toBe(false);
  });

  it("conditions the hypothetical continuing range on the size actually offered", () => {
    const o = flop();
    const weak = [card(14), card(13, 1)], strong = [card(12, 2), card(14, 1)];
    const smallWeak = sizingResponse(o, weak, 250), largeWeak = sizingResponse(o, weak, 1000);
    expect(smallWeak).not.toEqual(largeWeak);
    const posterior = (total: number) => {
      const weakCall = sizingResponse(o, weak, total).call;
      const strongCall = sizingResponse(o, strong, total).call;
      return strongCall / (weakCall + strongCall);
    };
    expect(posterior(250)).not.toBeCloseTo(posterior(1000), 6);
    const forbid = () => { throw Error("Responder accessed the hero's private cards"); };
    const responderView = Object.create(o, { heroCards: { get: forbid } }) as DecisionObservation;
    expect(sizingResponse(responderView, weak, 250)).toEqual(smallWeak);
  });

  it("is deterministic, leaves inputs unchanged, and never reads private cards or future deck", () => {
    const o = flop();
    const samples = bank(o);
    deepFreeze(o);
    deepFreeze(samples);
    const forbid = () => { throw Error("Private information was accessed"); };
    const guarded = Object.create(o, {
      holeCards: { get: forbid, enumerable: true },
      deck: { get: forbid, enumerable: true },
    }) as DecisionObservation;
    const first = analyzeSizing(guarded, samples);
    expect(analyzeSizing(guarded, samples)).toEqual(first);
    expect(chooseSizingAction(guarded, first)).toEqual(chooseSizingAction(guarded, first));
    expect(gradeSizing(guarded, first, "raise", 350)).toEqual(gradeSizing(guarded, first, "raise", 350));
  });

  it("evaluates the actual entered amount rather than snapping it to a pot-fraction bucket", () => {
    const o = flop();
    const sizing = analyzeSizing(o, bank(o));
    const exact = evaluateSizingAction(o, sizing, "raise", 350)!;
    expect(exact.total).toBe(350);
    expect(exact.ev).not.toBeCloseTo(evaluateSizingAction(o, sizing, "raise", 330)!.ev, 8);
    expect(exact.ev).not.toBeCloseTo(evaluateSizingAction(o, sizing, "raise", 500)!.ev, 8);
  });

  it("evaluates deep overbets but keeps extrapolated response assumptions out of recommendations", () => {
    const o = flop();
    const sizing = analyzeSizing(o, bank(o));
    const deep = evaluateSizingAction(o, sizing, "all-in")!;
    expect(Number.isFinite(deep.ev)).toBe(true);
    expect(deep.trusted).toBe(false);
    expect(sizing.best!.trusted).toBe(true);
    expect(gradeSizing(o, sizing, "all-in")!.verdict).toBe("uncertain");
    expect(chooseSizingAction(o, sizing)?.action).not.toBe("all-in");
    expect(evaluateSizingAction(o, sizing, "raise", 2000)!.trusted).toBe(true);
    expect(evaluateSizingAction(o, sizing, "raise", 2001)!.trusted).toBe(false);

    // It is the effective amount, not the label 'all-in', that crosses this
    // trust boundary. An uncalled 9 000 is returned against this short stack.
    Object.assign(o.players[1], { stack: 1000, startStack: 1600 });
    const capped = analyzeSizing(o, bank(o));
    expect(evaluateSizingAction(o, capped, "all-in")!.trusted).toBe(true);
    expect(evaluateSizingAction(o, capped, "all-in")!.details.effectiveTotal).toBe(1000);
  });

  it("marks a bet as assumption-sensitive when it wins only under the tighter response model", () => {
    const o = flop();
    o.players[0].stack = o.players[1].stack = 2000;
    o.players[0].startStack = 2400;
    o.players[1].startStack = 2600;
    o.maxRaiseTo = 2000;
    const samples: SizingSample[] = Array.from({ length: 120 }, (_, index) => ({
      villainCards: [card(12, 2), card(14, 1)], showdownShare: index % 25 === 0 ? 1 : 0,
    }));
    const sizing = analyzeSizing(o, samples);
    const check = evaluateSizingAction(o, sizing, "check")!;
    const shove = evaluateSizingAction(o, sizing, "all-in")!;
    expect(check.scenarios.base).toBeGreaterThan(shove.scenarios.base);
    expect(shove.scenarios.tight).toBeGreaterThan(check.scenarios.tight);
    expect(check.scenarios.loose).toBeGreaterThan(shove.scenarios.loose);
    expect(gradeSizing(o, sizing, "all-in")!.verdict).toBe("uncertain");
  });
});

describe("sizing policy integration in real generated hands", () => {
  it("grades small protection bets from actual sampled public ranges, including a different paired board", () => {
    const grades: Array<{ ownRank: number; seed: number; total: number; verdict: string }> = [];
    for (const [ownRank, boardRank, lowRank] of [[5, 12, 3], [6, 11, 2]]) {
      for (const seed of [123, 456, 789]) {
        const observation = flop();
        observation.heroCards = [card(ownRank, 2), card(ownRank, 3)];
        observation.board = [card(boardRank), card(boardRank, 1), card(lowRank, 2)];
        const analysis = analyzeDecision(observation, { seed, samples: 1800 });
        expect(analysis.sizing?.supported).toBe(true);
        expect(analysis.sizing!.sampleCount).toBe(1800);
        expect(analysis.sizing!.assumptions.join(" ")).toMatch(/не GTO/);
        for (const total of [250, 330]) {
          const feedback = gradeDecision(observation, analysis, "raise", total);
          // The real public-range bank must reach the exact-size comparison;
          // an old shortcut based only on hand strength must not override it.
          expect(feedback).toEqual(gradeSizing(observation, analysis.sizing!, "raise", total));
          expect(evaluateSizingAction(observation, analysis.sizing!, "raise", total)!.total).toBe(total);
          expect(feedback.reason).toMatch(/модел|размер|ответ|выборк/i);
          grades.push({ ownRank, seed, total, verdict: feedback.verdict });
        }
      }
    }
    for (const ownRank of [5, 6])
      expect(grades.some(grade => grade.ownRank === ownRank
        && (grade.verdict === "reasonable" || grade.verdict === "good"))).toBe(true);
  });

  it("finishes generated bot hands with legal sizes and conserved chips", () => {
    let sawPostflop = false;
    for (let seed = 201; seed < 207; seed++) {
      let hand = createTrainingHand(seed, { playerCount: seed % 2 ? 2 : 6, startingStack: 6000, randomDepth: true });
      const startingChips = hand.initialPlayers.reduce((sum, player) => sum + player.stack, 0);
      for (let step = 0; hand.phase === "playing"; step++) {
        if (step >= 200) throw Error(`Non-terminating bot hand for seed ${seed}`);
        const observation = observe(hand, hand.hand.actorId!);
        sawPostflop ||= observation.street !== "preflop";
        const decisionSeed = seed * 1000 + step;
        const profile = observation.players.find(player => player.id === observation.actorId)!.profile;
        const analysis = analyzeDecision(observation, { seed: decisionSeed, samples: 100, profile });
        const decision = chooseBotAction(observation, profile, decisionSeed, analysis);
        expect(observation.legalActions).toContain(decision.action);
        if (decision.action === "raise") {
          expect(Number.isSafeInteger(decision.total)).toBe(true);
          expect(decision.total!).toBeGreaterThan(observation.currentBet);
          expect(decision.total!).toBeLessThanOrEqual(observation.maxRaiseTo);
          expect(decision.total! >= observation.minRaiseTo || decision.total === observation.maxRaiseTo).toBe(true);
        }
        hand = applyAction(hand, decision.action, decision.total, decision.reason);
        const chips = hand.hand.players.reduce((sum, player) => sum + player.stack
          + (hand.phase === "finished" ? 0 : player.committed), 0);
        expect(chips).toBe(startingChips);
      }
      expect(hand.phase).toBe("finished");
    }
    expect(sawPostflop).toBe(true);
  });
});
