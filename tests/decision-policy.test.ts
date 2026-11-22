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

function tournamentLife(): DecisionObservation {
  const o = context();
  o.heroCards = [card(13), card(12, 1)];
  Object.assign(o.players[0], {
    stack: 2200,
    startStack: 2400,
    committed: 200,
    streetCommitted: 200,
  });
  Object.assign(o.players[1], {
    stack: 2400,
    startStack: 5000,
    committed: 2600,
    streetCommitted: 2400,
  });
  o.players.push({
    id: "folded",
    name: "Пас",
    seat: 2,
    stack: 9900,
    startStack: 10000,
    committed: 100,
    streetCommitted: 100,
    antePaid: 0,
    folded: true,
    allIn: false,
    profile: "balanced",
  });
  Object.assign(o, {
    currentBet: 2400,
    minRaise: 2200,
    toCall: 2200,
    minRaiseTo: 4600,
    maxRaiseTo: 2400,
    canRaise: false,
    pot: 2900,
    legalActions: ["fold", "call", "all-in"],
  });
  o.history = [
    {
      street: "preflop",
      actorId: "villain",
      action: "raise",
      total: 2400,
      paid: 2200,
    },
  ];
  return o;
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

  it("adds stage caution to a large covered call without changing physical equity or claiming ICM", () => {
    const early = tournamentLife(),
      final = structuredClone(early);
    early.tournamentStage = "early";
    final.tournamentStage = "final";
    const options = { seed: 415, samples: 4000 };
    const a = analyzeDecision(early, options),
      b = analyzeDecision(final, options);
    expect(a.equity).toBe(b.equity);
    expect(a.potOdds).toBe(b.potOdds);
    expect(a.riskPremium).toBe(0);
    expect(b.riskPremium).toBeGreaterThan(0);
    expect(b.callMargin).toBeGreaterThan(a.callMargin);
    expect(b.survivalRisk).toBe(true);
    expect(b.fatalRisk).toBe(true);
    expect(a.preferred).toContain("call");
    expect(b.preferred).toContain("fold");
    const earlyGrade = gradeDecision(early, a, "call"),
      finalGrade = gradeDecision(final, b, "call");
    expect(finalGrade.verdict).toBe("uncertain");
    expect(finalGrade).not.toEqual(earlyGrade);
    expect(finalGrade.reason).toContain(
      "не превращает такой колл в доказанную ошибку",
    );
    expect(b.reason).toContain("не ICM");
    expect(
      analyzeDecision({ ...early, tournamentStage: undefined }, options),
    ).toEqual(a);
  });

  it("changes bot responses to a covered large bet instead of only displaying a stage label", () => {
    const early = tournamentLife(),
      final = { ...early, tournamentStage: "final" as const };
    const options = { seed: 415, samples: 4000 };
    const a = analyzeDecision(early, options),
      b = analyzeDecision(final, options);
    expect(chooseBotAction(early, "balanced", 913, a).action).toBe("call");
    expect(chooseBotAction(final, "balanced", 913, b).action).toBe("fold");
    expect(chooseBotAction(final, "balanced", 913, b).reason).toContain(
      "покрывающего",
    );
  });

  it("does not charge the same survival premium to a covering player, a small bet or true heads-up", () => {
    const final = tournamentLife();
    final.tournamentStage = "final";
    const covering = structuredClone(final);
    Object.assign(covering.players[0], { stack: 2800, startStack: 3000 });
    Object.assign(covering.players[1], {
      stack: 0,
      startStack: 2600,
      allIn: true,
    });
    covering.maxRaiseTo = 3000;
    covering.legalActions = ["fold", "call"];
    expect(
      analyzeDecision(covering, { seed: 45, samples: 200 }).riskPremium,
    ).toBe(0);
    const small = structuredClone(final);
    small.currentBet = 300;
    small.toCall = 100;
    small.legalActions = ["fold", "call", "raise", "all-in"];
    expect(analyzeDecision(small, { seed: 45, samples: 200 }).riskPremium).toBe(
      0,
    );
    const headsUp = structuredClone(final);
    headsUp.players = headsUp.players.slice(0, 2);
    expect(
      analyzeDecision(headsUp, { seed: 45, samples: 200 }).riskPremium,
    ).toBe(0);
    // Two active players are still part of a three-player tournament context.
    expect(
      analyzeDecision(final, { seed: 45, samples: 200 }).riskPremium,
    ).toBeGreaterThan(0);
  });

  it("keeps practical open pushes and reshoves at 10–15 BB on the final stage", () => {
    for (const depth of [10, 12, 15]) {
      const open = context();
      open.tournamentStage = "final";
      open.heroCards = [card(9), card(9, 1)];
      open.players[0].stack = depth * 200 - 100;
      open.players[0].startStack = depth * 200;
      open.maxRaiseTo = depth * 200;
      const a = analyzeDecision(open, { seed: 22, samples: 300 });
      expect(a.shortStackPush).toBe(true);
      expect(a.preferred).toContain("all-in");
      expect(a.suggestedRaiseTo).toBe(depth * 200);
      expect(chooseBotAction(open, "balanced", 311, a).action).toBe("all-in");
      expect(gradeDecision(open, a, "all-in").verdict).toBe("good");
      const reshove = structuredClone(open);
      reshove.heroCards = [card(14), card(13, 1)];
      reshove.currentBet = 500;
      reshove.toCall = 400;
      reshove.minRaiseTo = 800;
      reshove.players[1].committed = 700;
      reshove.players[1].streetCommitted = 500;
      reshove.history = [
        {
          street: "preflop",
          actorId: "villain",
          action: "raise",
          total: 500,
          paid: 300,
        },
      ];
      const b = analyzeDecision(reshove, { seed: 23, samples: 300 });
      expect(b.shortStackPush).toBe(true);
      expect(b.preferred).toContain("all-in");
      expect(chooseBotAction(reshove, "tight", 519, b).action).toBe("all-in");
      const trash = structuredClone(open);
      trash.heroCards = [card(7), card(2, 1)];
      expect(
        analyzeDecision(trash, { seed: 22, samples: 300 }).preferred,
      ).toEqual(["fold"]);
    }
  });

  it("does not turn AA or the nuts into automatic final-stage folds", () => {
    const aa = tournamentLife();
    aa.tournamentStage = "final";
    aa.heroCards = [card(14), card(14, 1)];
    const a = analyzeDecision(aa, { seed: 85, samples: 1000 });
    expect(a.preferred).toContain("call");
    expect(gradeDecision(aa, a, "call").verdict).toBe("reasonable");
    const nuts = structuredClone(aa);
    nuts.street = "river";
    nuts.heroCards = [card(14), card(13)];
    nuts.board = [card(12), card(11), card(10), card(2, 1), card(3, 2)];
    const b = analyzeDecision(nuts, { seed: 851, samples: 300 });
    expect(b.equity).toBe(1);
    expect(b.preferred).toContain("call");
    expect(gradeDecision(nuts, b, "call").verdict).toBe("reasonable");
  });

  it("preserves a clear losing chip-price mistake before late-stage caution", () => {
    const trash = tournamentLife();
    trash.tournamentStage = "final";
    trash.street = "river";
    trash.heroCards = [card(2), card(3, 2)];
    trash.board = [card(9), card(9, 1), card(9, 2), card(9, 3), card(2, 1)];
    const a = analyzeDecision(trash, { seed: 71, samples: 400 });
    expect(a.survivalRisk).toBe(true);
    expect(a.equity).toBeLessThan(0.01);
    expect(gradeDecision(trash, a, "call").verdict).toBe("mistake");
    expect(gradeDecision(trash, a, "all-in").verdict).toBe("mistake");
    expect(
      gradeDecision(trash, { ...a, equity: 0, standardError: 0 }, "call")
        .verdict,
    ).toBe("mistake");
    const marginal = tournamentLife();
    marginal.tournamentStage = "final";
    const b = analyzeDecision(marginal, { seed: 415, samples: 4000 });
    expect(gradeDecision(marginal, b, "call").verdict).toBe("uncertain");
  });

  it("does not force unacted players into a five-way showdown against a single shove", () => {
    const o = context();
    o.heroCards = [card(11), card(11, 1)];
    o.dealerSeat = 0;
    Object.assign(o.players[0], {
      seat: 4,
      stack: 2400,
      startStack: 2400,
      committed: 0,
      streetCommitted: 0,
    });
    Object.assign(o.players[1], {
      seat: 3,
      stack: 0,
      startStack: 2400,
      committed: 2400,
      streetCommitted: 2400,
      antePaid: 0,
      allIn: true,
    });
    for (const [seat, live, ante] of [
      [0, 0, 0],
      [1, 100, 0],
      [2, 200, 200],
    ])
      o.players.push({
        id: `pending-${seat}`,
        name: "Ещё не ходил",
        seat,
        stack: 3000 - live - ante,
        startStack: 3000,
        committed: live + ante,
        streetCommitted: live,
        antePaid: ante,
        folded: false,
        allIn: false,
        profile: "balanced",
      });
    Object.assign(o, {
      currentBet: 2400,
      toCall: 2400,
      maxRaiseTo: 2400,
      minRaiseTo: 4600,
      minRaise: 2200,
      canRaise: false,
      pot: 2900,
      legalActions: ["fold", "call", "all-in"],
    });
    o.history = [
      {
        street: "preflop",
        actorId: "villain",
        action: "all-in",
        total: 2400,
        paid: 2400,
      },
    ];
    const a = analyzeDecision(o, { seed: 413, samples: 4000 });
    const forced = structuredClone(o);
    for (const player of forced.players)
      if (player.id.startsWith("pending-")) player.allIn = true;
    const b = analyzeDecision(forced, { seed: 413, samples: 4000 });
    expect(a.pendingResponders).toBe(3);
    expect(a.expectedShowdownOpponents).toBeGreaterThan(1);
    expect(a.expectedShowdownOpponents).toBeLessThan(2);
    expect(b.expectedShowdownOpponents).toBe(4);
    expect(a.equity).toBeGreaterThan(b.equity + 0.1);
    expect(a.preferred).toContain("call");
    expect(["reasonable", "uncertain"]).toContain(
      gradeDecision(o, a, "call").verdict,
    );
    const matched = structuredClone(o);
    for (const player of matched.players)
      if (player.id.startsWith("pending-")) {
        player.committed = 2400 + player.antePaid;
        player.streetCommitted = 2400;
        player.stack = player.startStack - player.committed;
      }
    expect(
      analyzeDecision(matched, { seed: 413, samples: 200 })
        .expectedShowdownOpponents,
    ).toBe(4);
    const final = { ...o, tournamentStage: "final" as const };
    const c = analyzeDecision(final, { seed: 413, samples: 4000 });
    expect(c.expectedShowdownOpponents).toBeLessThan(2);
    expect(gradeDecision(final, c, "call").verdict).toBe("uncertain");
  });

  it("plays final-stage hands deterministically, conserves chips and still cannot read hidden cards", () => {
    function finish(seed: number) {
      let hand = createTrainingHand(seed, {
        playerCount: 6,
        tournamentStage: "final",
        randomDepth: true,
      });
      const total = hand.initialPlayers.reduce((sum, p) => sum + p.stack, 0);
      let count = 0;
      while (hand.phase === "playing" && count < 200) {
        const o = observe(hand, hand.hand.actorId!);
        expect(o.tournamentStage).toBe("final");
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
      expect(hand.hand.players.reduce((sum, p) => sum + p.stack, 0)).toBe(
        total,
      );
      return hand;
    }
    for (const seed of [2, 19, 41]) expect(finish(seed)).toEqual(finish(seed));
    const hand = createTrainingHand(418, {
      playerCount: 6,
      tournamentStage: "final",
      randomDepth: true,
    });
    const other = structuredClone(hand),
      actor = hand.hand.actorId!;
    other.deck.reverse();
    for (const id of Object.keys(other.holeCards))
      if (id !== actor) other.holeCards[id] = [0, 1];
    const a = observe(hand, actor),
      b = observe(other, actor);
    expect(a).toEqual(b);
    expect(analyzeDecision(a, { seed: 81, samples: 200 })).toEqual(
      analyzeDecision(b, { seed: 81, samples: 200 }),
    );
  }, 30_000);
});
