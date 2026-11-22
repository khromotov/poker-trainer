import { describe, expect, it } from "vitest";
import { presentEstimate } from "../src/strategy/presentation";
import type { HandAdvice } from "../src/strategy/model";

describe("uncertain preflop estimates", () => {
  it("does not recommend either contradictory action from the reported 84o/84s scenario", () => {
    const off: HandAdvice = {
      action: "raise",
      raiseTo: 500,
      equity: 0.10857,
      ev: { fold: 0, call: -15.375, raise: 43.5625 },
      error: 54.3369,
      uncertain: true,
    };
    const suited: HandAdvice = {
      action: "call",
      equity: 0.13375,
      ev: { fold: 0, call: 10.875, raise: -4 },
      error: 26.1592,
      uncertain: true,
    };
    for (const advice of [off, suited]) {
      const shown = presentEstimate(advice);
      expect(shown.color).toBe("inconclusive");
      expect(shown).not.toHaveProperty("action");
      expect(shown).not.toHaveProperty("raiseTo");
    }
  });
  it("distinguishes pending computation from inconclusive estimates", () => {
    expect(presentEstimate(undefined).state).toBe("pending");
  });
  it("keeps a separated estimate explicitly labelled as a model output", () => {
    expect(
      presentEstimate({
        action: "raise",
        raiseTo: 500,
        equity: 0.45,
        ev: { fold: 0, call: 586, raise: 1387 },
        error: 62,
        uncertain: false,
      }),
    ).toMatchObject({
      state: "estimate",
      label: "Оценка модели",
      action: "raise",
      raiseTo: 500,
    });
  });
  it("does not present non-finite estimates as a recommendation", () => {
    expect(
      presentEstimate({
        action: "raise",
        raiseTo: 500,
        equity: 0.2,
        ev: { raise: NaN },
        error: 1,
        uncertain: false,
      }).state,
    ).toBe("inconclusive");
  });
});
