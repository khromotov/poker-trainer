import { describe, expect, it } from "vitest";
import { compare, evaluate, seeded } from "../src/core";
import {
  applyAction,
  createTrainingHand,
  observe,
  type DecisionObservation,
} from "../src/decision/engine";
import {
  analyzeDecision,
  callPrice,
  chooseBotAction,
  gradeDecision,
  policyHandValue,
} from "../src/decision/policy";

const card = (rank: number, suit = 0) => (rank - 2) * 4 + suit;
function context(): DecisionObservation {
  return {
    street: "preflop",
    board: [],
    heroCards: [card(14), card(14, 1)],
    actorId: "hero",
    dealerSeat: 0,
    smallBlind: 100,
    bigBlind: 200,
    ante: 200,
    currentBet: 200,
    minRaise: 200,
    canRaise: true,
    pot: 500,
    toCall: 100,
    minRaiseTo: 400,
    maxRaiseTo: 30000,
    legalActions: ["fold", "call", "raise", "all-in"],
    history: [],
    players: [
      {
        id: "hero",
        seat: 0,
        name: "Вы",
        stack: 29900,
        startStack: 30000,
        committed: 100,
        streetCommitted: 100,
        antePaid: 0,
        folded: false,
        allIn: false,
        profile: "balanced",
      },
      {
        id: "villain",
        seat: 1,
        name: "Бот",
        stack: 29600,
        startStack: 30000,
        committed: 400,
        streetCommitted: 200,
        antePaid: 200,
        folded: false,
        allIn: false,
        profile: "balanced",
      },
    ],
  };
}

describe("public-information teaching policy", () => {
  it("agrees with the independent core evaluator on complete and partial boards", () => {
    const random = seeded(239);
    for (let trial = 0; trial < 800; trial++) {
      const d = Array.from({ length: 52 }, (_, i) => i);
      for (let i = 0; i < 9; i++) {
        const j = i + Math.floor(random() * (52 - i));
        [d[i], d[j]] = [d[j], d[i]];
      }
      const a = d.slice(0, 7),
        b = [...d.slice(0, 5), ...d.slice(7, 9)];
      expect(Math.sign(policyHandValue(a) - policyHandValue(b))).toBe(
        compare(evaluate(a), evaluate(b)),
      );
      // Missing cards cannot improve a best-five combination.
      expect(policyHandValue(a.slice(0, 5))).toBeLessThanOrEqual(
        policyHandValue(a.slice(0, 6)),
      );
      expect(policyHandValue(a.slice(0, 6))).toBeLessThanOrEqual(
        policyHandValue(a),
      );
    }
  });

  it("is reproducible and favors AA while not opening any two cards", () => {
    const premium = context(),
      weak = context();
    weak.heroCards = [card(7), card(2, 1)];
    const options = { seed: 92, samples: 800 };
    const result = analyzeDecision(premium, options);
    expect(analyzeDecision(premium, options)).toEqual(result);
    expect(result.preferred).toContain("raise");
    expect(analyzeDecision(weak, options).preferred).toEqual(["fold"]);
    expect(result.equity).toBeGreaterThan(0.75);
    expect(chooseBotAction(premium, "balanced", 123)).toEqual(
      chooseBotAction(premium, "balanced", 123),
    );
    expect(chooseBotAction(weak, "balanced", 123).action).toBe("fold");
    expect(
      gradeDecision(premium, result, "raise", result.suggestedRaiseTo).verdict,
    ).toBe("good");
  });

  it("never gets access to actual opponent cards or the fixed future board", () => {
    const original = createTrainingHand(431, { playerCount: 3 });
    const actor = original.hand.actorId!;
    const changed = structuredClone(original);
    changed.deck.reverse();
    for (const id of Object.keys(changed.holeCards))
      if (id !== actor) changed.holeCards[id] = [card(2), card(2, 1)];
    for (const log of changed.logs) log.reason = "private secret";
    const first = observe(original, actor),
      second = observe(changed, actor);
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("private secret");
    expect(analyzeDecision(first, { seed: 71, samples: 400 })).toEqual(
      analyzeDecision(second, { seed: 71, samples: 400 }),
    );
    expect(chooseBotAction(first, "balanced", 17)).toEqual(
      chooseBotAction(second, "balanced", 17),
    );
  });

  it("calculates the current call price and excludes inaccessible side-pot layers", () => {
    const o = context();
    expect(callPrice(o)).toEqual({
      toCall: 100,
      contestablePot: 600,
      potOdds: 1 / 6,
    });
    o.players[0].stack = 100;
    o.players[1].committed = 5200;
    o.players[1].streetCommitted = 5000;
    o.currentBet = 5000;
    o.pot = 5300;
    expect(callPrice(o)).toEqual({
      toCall: 100,
      contestablePot: 600,
      potOdds: 1 / 6,
    });
  });

  it("uses only legal actions including a short all-in call and no raise after a closed action", () => {
    const o = context();
    o.players[0].stack = 50;
    o.maxRaiseTo = 150;
    o.toCall = 50;
    o.legalActions = ["fold", "call", "all-in"];
    o.canRaise = false;
    const a = analyzeDecision(o, { seed: 49, samples: 120 });
    expect(a.preferred).toEqual(["call"]);
    expect(chooseBotAction(o, "tight", 912).action).toBe("call");
    expect(gradeDecision(o, a, "all-in").verdict).toBe("good");
  });

  it("counts shared-board ties correctly and does not treat a shared royal flush as private value", () => {
    const o = context();
    o.street = "river";
    o.heroCards = [card(2, 1), card(3, 2)];
    o.board = [card(10), card(11), card(12), card(13), card(14)];
    o.currentBet = 0;
    o.toCall = 0;
    o.players.forEach((p) => (p.streetCommitted = 0));
    o.legalActions = ["check", "raise", "all-in"];
    o.minRaiseTo = 200;
    const a = analyzeDecision(o, { seed: 42, samples: 160 });
    expect(a.equity).toBe(0.5);
    expect(a.standardError).toBe(0);
    expect(a.preferred).toEqual(["check"]);
    expect(gradeDecision(o, a, "fold").verdict).toBe("mistake");
  });

  it("allows value aggression with a nut flush rather than forcing check/call", () => {
    const o = context();
    o.street = "flop";
    o.heroCards = [card(14), card(13)];
    o.board = [card(12), card(8), card(3)];
    o.currentBet = 0;
    o.toCall = 0;
    o.players.forEach((p) => (p.streetCommitted = 0));
    o.legalActions = ["check", "raise", "all-in"];
    o.minRaiseTo = 200;
    const a = analyzeDecision(o, { seed: 122, samples: 1000 });
    expect(a.strong).toBe(true);
    expect(a.equity).toBeGreaterThan(0.9);
    expect(a.preferred).toContain("raise");
    expect(a.preferred).toContain("check");
    expect(gradeDecision(o, a, "raise", a.suggestedRaiseTo).verdict).toBe(
      "good",
    );
    expect(gradeDecision(o, a, "check").verdict).toBe("good");
  });

  it("narrows a hypothetical range from public raises rather than knowing the dealt hand", () => {
    const base = context();
    base.heroCards = [card(14), card(11, 1)];
    const raised = structuredClone(base);
    raised.history = [
      {
        street: "preflop",
        actorId: "villain",
        action: "raise",
        total: 600,
        paid: 400,
      },
      {
        street: "preflop",
        actorId: "hero",
        action: "raise",
        total: 1800,
        paid: 1700,
      },
      {
        street: "preflop",
        actorId: "villain",
        action: "raise",
        total: 5200,
        paid: 4600,
      },
    ];
    const a = analyzeDecision(base, { seed: 411, samples: 2200 }),
      b = analyzeDecision(raised, { seed: 411, samples: 2200 });
    expect(a.equity - b.equity).toBeGreaterThan(0.12);
  });

  it("flags obviously excessive sizing without pretending to know an optimal EV", () => {
    const o = context(),
      a = analyzeDecision(o, { seed: 81, samples: 160 });
    const grade = gradeDecision(o, a, "all-in");
    expect(grade.verdict).toBe("risky");
    expect(grade.reason).not.toContain("GTO");
    expect(gradeDecision(o, a, "raise", 399).verdict).toBe("mistake");
  });

  it("does not confuse favorable current odds with proven future profitability", () => {
    const o = context();
    o.street = "flop";
    o.heroCards = [card(7), card(7, 1)];
    o.board = [card(14, 2), card(8, 1), card(3, 3)];
    const a = analyzeDecision(o, { seed: 591, samples: 1500 });
    expect(a.preferred).toContain("call");
    expect(a.strong).toBe(false);
    expect(gradeDecision(o, a, "call").verdict).toBe("reasonable");
    expect(gradeDecision(o, a, "call").reason).toContain("дальнейшие ставки");
  });

  it("withholds confident grading when multiway side-pot equities need separate treatment", () => {
    const o = context();
    o.street = "flop";
    o.heroCards = [card(7), card(7, 1)];
    o.board = [card(14, 2), card(8, 1), card(3, 3)];
    o.players.push({
      id: "short",
      seat: 2,
      name: "Короткий",
      startStack: 50,
      stack: 0,
      committed: 50,
      streetCommitted: 0,
      antePaid: 0,
      folded: false,
      allIn: true,
      profile: "tight",
    });
    const a = analyzeDecision(o, { seed: 593, samples: 400 });
    expect(gradeDecision(o, a, "call").verdict).toBe("uncertain");
    expect(gradeDecision(o, a, "fold").verdict).toBe("uncertain");
  });

  it("finishes generated hands with legal decisions on every street within a bounded action count", () => {
    for (const seed of [1, 15, 71, 219]) {
      let hand = createTrainingHand(seed, {
        playerCount: 4,
        startingStack: 4000,
      });
      let count = 0;
      while (hand.phase === "playing" && count < 200) {
        const o = observe(hand, hand.hand.actorId!);
        const bot = chooseBotAction(
          o,
          hand.profiles[o.actorId],
          seed * 1000 + count,
        );
        expect(o.legalActions).toContain(bot.action);
        hand = applyAction(hand, bot.action, bot.total, bot.reason);
        count++;
      }
      expect(hand.phase).toBe("finished");
      expect(count).toBeLessThan(200);
      expect(hand.hand.players.reduce((sum, p) => sum + p.stack, 0)).toBe(
        16000,
      );
    }
  }, 30_000);
});
