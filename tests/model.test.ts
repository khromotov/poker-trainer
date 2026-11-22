import { describe, expect, it } from "vitest";
import { compare, evaluate, seeded } from "../src/core";
import {
  evaluateShowdown,
  heroPayout,
  legalCandidates,
  solvePreflop,
  type ModelContext,
} from "../src/strategy/model";

const context = (): ModelContext => ({
  heroId: "hero",
  heroSeat: 0,
  dealerSeat: 0,
  smallBlind: 100,
  bigBlind: 200,
  ante: 200,
  currentBet: 200,
  minRaise: 200,
  samples: 50,
  seed: 123,
  players: [
    {
      id: "hero",
      seat: 0,
      stack: 29900,
      committed: 100,
      streetCommitted: 100,
      folded: false,
      allIn: false,
    },
    {
      id: "villain",
      seat: 1,
      stack: 29600,
      committed: 400,
      streetCommitted: 200,
      folded: false,
      allIn: false,
    },
  ],
  actions: [],
});

describe("bounded preflop chipEV model", () => {
  it("agrees with the existing evaluator on random and category-boundary showdowns", () => {
    const random = seeded(71);
    for (let trial = 0; trial < 1500; trial++) {
      const cards = Array.from({ length: 52 }, (_, i) => i);
      for (let i = 0; i < 9; i++) {
        const j = i + Math.floor(random() * (52 - i));
        [cards[i], cards[j]] = [cards[j], cards[i]];
      }
      const a = cards.slice(0, 7),
        b = [...cards.slice(0, 5), ...cards.slice(7, 9)];
      expect(Math.sign(evaluateShowdown(a) - evaluateShowdown(b))).toBe(
        compare(evaluate(a), evaluate(b)),
      );
    }
    // Wheel straight must rank below a six-high straight.
    expect(evaluateShowdown([48, 0, 4, 8, 12, 37, 43])).toBeLessThan(
      evaluateShowdown([0, 4, 8, 12, 16, 37, 43]),
    );
    // Two triplets use the higher one for the full house.
    expect(evaluateShowdown([48, 49, 50, 44, 45, 46, 0])).toBeGreaterThan(
      evaluateShowdown([48, 49, 44, 45, 46, 0, 4]),
    );
  });
  it("handles dead ante, side pots, split pots, and uncalled excess", () => {
    expect(
      heroPayout([100, 50, 20], [false, false, false], [3, 4, 5], 0, 10),
    ).toBe(50);
    expect(
      heroPayout([100, 100, 30], [false, false, false], [10, 10, 20], 0, 20),
    ).toBe(70);
    expect(
      heroPayout([100, 100, 30], [false, false, false], [10, 10, 20], 2, 20),
    ).toBe(110);
    expect(heroPayout([100, 50], [false, true], [1, 9], 0, 20)).toBe(170);
    expect(heroPayout([100, 100], [true, false], [9, 1], 0, 20)).toBe(0);
    // Short BB all-in for ante alone can win the ante, but no live-wager layer.
    expect(
      heroPayout([100, 100, 0], [false, false, false], [10, 15, 20], 2, 50),
    ).toBe(50);
    expect(
      heroPayout([100, 100, 0], [false, false, false], [10, 15, 20], 1, 50),
    ).toBe(200);
  });
  it("only offers affordable legal raises, including a short all-in call", () => {
    const c = context();
    expect(legalCandidates(c)).toEqual([
      { action: "fold", total: 100, cost: 0 },
      { action: "call", total: 200, cost: 100 },
      { action: "raise", total: 500, cost: 400 },
      { action: "all-in", total: 30000, cost: 29900 },
    ]);
    c.players[0].stack = 50;
    expect(legalCandidates(c)).toEqual([
      { action: "fold", total: 100, cost: 0 },
      { action: "all-in", total: 150, cost: 50 },
    ]);
  });
  it("does not reopen a raise after an insufficient all-in raise", () => {
    const c = context();
    c.currentBet = 250;
    c.players[0].streetCommitted = 200;
    c.players[0].committed = 200;
    c.players[1].streetCommitted = 250;
    c.players[1].committed = 450;
    c.actions = [
      { playerId: "hero", type: "call", total: 200, paid: 100 },
      { playerId: "villain", type: "all-in", total: 250, paid: 50 },
    ];
    expect(legalCandidates(c).map((x) => x.action)).toEqual(["fold", "call"]);
  });
  it("never recommends raising into only all-in or folded opponents", () => {
    const c = context();
    c.players[1].stack = 0;
    c.players[1].allIn = true;
    expect(legalCandidates(c).map((x) => x.action)).toEqual(["fold", "call"]);
  });
  it("is deterministic, covers 169 hands, and reports bounded equities and finite EVs", () => {
    const a = solvePreflop(context()),
      b = solvePreflop(context());
    expect(a).toEqual(b);
    expect(Object.keys(a.hands)).toHaveLength(169);
    for (const hand of Object.values(a.hands)) {
      expect(hand.equity).toBeGreaterThanOrEqual(0);
      expect(hand.equity).toBeLessThanOrEqual(1);
      expect(hand.ev.fold).toBe(0);
      expect(Number.isFinite(hand.error)).toBe(true);
      for (const ev of Object.values(hand.ev))
        expect(Number.isFinite(ev)).toBe(true);
      expect(hand.raiseTo ?? 0).toBeLessThanOrEqual(30000);
    }
    expect(a.hands.AA.equity).toBeGreaterThan(a.hands["72o"].equity + 0.25);
    expect(a.source).toContain("Приближённая");
    expect(a.assumptions.join(" ")).toContain("Не GTO");
    expect(a.hands.AA.ev).not.toHaveProperty("all-in");
  });
  it("considers shoving a short effective stack and explicitly excludes deep open shoves", () => {
    const c = context();
    c.players[0].stack = 3900;
    c.players[1].stack = 3600;
    expect(solvePreflop(c).hands.AA.ev).toHaveProperty("all-in");
  });
  it("does not turn a limped short-stack BB option into a shove with every hand", () => {
    const c: ModelContext = {
      heroId: "hero",
      heroSeat: 2,
      dealerSeat: 0,
      smallBlind: 100,
      bigBlind: 200,
      ante: 200,
      currentBet: 200,
      minRaise: 200,
      samples: 1000,
      seed: 1014,
      players: [
        {
          id: "button",
          seat: 0,
          stack: 800,
          committed: 200,
          streetCommitted: 200,
          folded: false,
          allIn: false,
        },
        {
          id: "small",
          seat: 1,
          stack: 800,
          committed: 200,
          streetCommitted: 200,
          folded: false,
          allIn: false,
        },
        {
          id: "hero",
          seat: 2,
          stack: 1500,
          committed: 400,
          streetCommitted: 200,
          folded: false,
          allIn: false,
        },
      ],
      actions: [
        { playerId: "hero", type: "ante", total: 200, paid: 200 },
        { playerId: "small", type: "small-blind", total: 100, paid: 100 },
        { playerId: "hero", type: "big-blind", total: 200, paid: 200 },
        { playerId: "button", type: "call", total: 200, paid: 200 },
        { playerId: "small", type: "call", total: 200, paid: 100 },
      ],
    };
    const result = solvePreflop(c);
    expect(result.hands["72o"].action).toBe("check");
    expect(result.hands.AA.action).toBe("all-in");
    expect(result.hands["72o"].ev.check!).toBeGreaterThan(
      result.hands["72o"].ev["all-in"]!,
    );
    expect(
      Object.values(result.hands).filter((h) => h.action === "all-in").length,
    ).toBeLessThan(100);
  });
  it("changes range-conditioned equity and EV when an opponent raises a different amount", () => {
    const opening = context();
    opening.currentBet = 600;
    opening.players[1].streetCommitted = 600;
    opening.players[1].committed = 800;
    opening.players[1].stack = 29200;
    opening.actions = [
      { playerId: "villain", type: "raise", total: 600, paid: 400 },
    ];
    const shove = context();
    shove.currentBet = 29800;
    shove.players[1].streetCommitted = 29800;
    shove.players[1].committed = 30000;
    shove.players[1].stack = 0;
    shove.players[1].allIn = true;
    shove.actions = [
      { playerId: "villain", type: "all-in", total: 29800, paid: 29600 },
    ];
    const a = solvePreflop(opening),
      b = solvePreflop(shove);
    expect(b.hands["72o"].action).toBe("fold");
    expect(a.hands.AA.ev.call).not.toBe(b.hands.AA.ev.call);
    expect(a.hands["AKs"].equity).not.toBe(b.hands["AKs"].equity);
  });
  it("rejects malformed or excessive work requests", () => {
    expect(() => solvePreflop({ ...context(), samples: 1001 })).toThrow();
    expect(() => solvePreflop({ ...context(), bigBlind: 0 })).toThrow();
    const bad = context();
    bad.players[0].stack = -1;
    expect(() => solvePreflop(bad)).toThrow();
    expect(() =>
      solvePreflop({
        ...context(),
        players: Array(11).fill(context().players[0]),
      }),
    ).toThrow();
  });
});
