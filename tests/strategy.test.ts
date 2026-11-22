import { describe, expect, it } from "vitest";
import { combinationsFor, handAt, preflopMatrix } from "../src/strategy/hands";
import { unavailableStrategy } from "../src/strategy/provider";
describe("preflop matrix", () => {
  it("covers all 169 types and all 1326 physical combinations", () => {
    const matrix = preflopMatrix().flat();
    expect(new Set(matrix).size).toBe(169);
    expect(matrix.reduce((n, hand) => n + combinationsFor(hand), 0)).toBe(1326);
  });
  it("uses pair, suited and offsuit positions", () => {
    expect(handAt(0, 0)).toBe("AA");
    expect(handAt(0, 1)).toBe("AKs");
    expect(handAt(1, 0)).toBe("AKo");
    expect(() => combinationsFor("KAo")).toThrow();
  });
  it("does not invent a strategy", () =>
    expect(
      unavailableStrategy.getStrategy({
        street: "preflop",
        playerCount: 2,
        heroSeat: 0,
        dealerSeat: 0,
        smallBlind: 100,
        bigBlind: 200,
        bigBlindAnte: 200,
        stacks: [30000, 30000],
        actions: [],
      }),
    ).toMatchObject({ status: "unavailable" }));
});
