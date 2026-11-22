import { describe, expect, it } from "vitest";
import type { ActionType, DecisionObservation } from "../src/decision/engine";
import {
  describeDecisionHand,
  summarizeDecisionHand,
} from "../src/decision/explanation";
import { analyzeDecision, gradeDecision } from "../src/decision/policy";
import {
  gradeSizing,
  type SizingAnalysis,
  type SizingCandidate,
} from "../src/decision/sizing";

const card = (rank: number, suit = 0) => (rank - 2) * 4 + suit;

function context(
  heroCards = [card(10, 1), card(6, 2)],
  board = [card(12, 2), card(11, 1), card(8, 3)],
): DecisionObservation {
  return {
    tournamentStage: "early",
    street: board.length === 3 ? "flop" : board.length === 4 ? "turn" : "river",
    heroCards,
    board,
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
    history: [],
    players: [
      {
        id: "hero",
        seat: 0,
        name: "Вы",
        startStack: 10400,
        stack: 10000,
        committed: 400,
        streetCommitted: 0,
        antePaid: 0,
        folded: false,
        allIn: false,
        profile: "balanced",
      },
      {
        id: "villain",
        seat: 1,
        name: "Соперник",
        startStack: 10600,
        stack: 10000,
        committed: 600,
        streetCommitted: 0,
        antePaid: 200,
        folded: false,
        allIn: false,
        profile: "balanced",
      },
    ],
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe("factual explanation from visible cards", () => {
  it("describes the screenshot T6 on QJ8 as a gutshot to a nine, without inventing a pair or flush draw", () => {
    const o = context();
    const hand = summarizeDecisionHand(o),
      text = describeDecisionHand(o);
    expect(hand.category).toBe(0);
    expect(hand.hasPair).toBe(false);
    expect(hand.straightDrawOuts).toBe(4);
    expect(hand.flushDrawOuts).toBe(0);
    expect(text).toMatch(/нет пары/i);
    expect(text).toMatch(/гатшот/i);
    expect(text).toMatch(/9|девят/i);
    expect(text).not.toMatch(/флеш-дро/i);
  });

  it("distinguishes a pocket pair below the paired board from a private pair of queens", () => {
    const o = context(
      [card(5, 2), card(5, 3)],
      [card(12), card(12, 1), card(3, 2)],
    );
    const hand = summarizeDecisionHand(o),
      text = describeDecisionHand(o);
    expect(hand.category).toBe(2);
    expect(hand.hasPair).toBe(true);
    expect(hand.protectionCandidate).toBe(true);
    expect(hand.straightDrawOuts).toBe(0);
    expect(hand.flushDrawOuts).toBe(0);
    expect(text).toMatch(/карманн.*55/i);
    expect(text).toMatch(/ниже/i);
    expect(text).toMatch(/общ|борд/i);
    expect(text).not.toMatch(/у вас.*(?:топ-пара|пара дам)/i);
  });

  it("does not call a discarded pocket pair a private holding needing protection on a double-paired board", () => {
    const o = context(
      [card(2), card(2, 1)],
      [card(12), card(12, 1), card(11, 2), card(11, 3)],
    );
    const hand = summarizeDecisionHand(o),
      text = describeDecisionHand(o);
    expect(hand.category).toBe(2);
    expect(hand.protectionCandidate).toBe(false);
    expect(text).toMatch(/две пары.*общ/i);
    expect(text).not.toMatch(/карманная пара 22/i);
  });

  it("describes shared quads with a private ace kicker", () => {
    const o = context(
      [card(14), card(2, 1)],
      [card(12), card(12, 1), card(12, 2), card(12, 3), card(3, 2)],
    );
    const hand = summarizeDecisionHand(o),
      text = describeDecisionHand(o);
    expect(hand.category).toBe(7);
    expect(hand.boardOnly).toBe(false);
    expect(hand.protectionCandidate).toBe(false);
    expect(text).toMatch(/каре/i);
    expect(text).toMatch(/общ|борд/i);
    expect(text).toMatch(/кикер[^.]*A|A[^.]*кикер/i);
  });

  it("counts both ends of an open straight draw without calling them guaranteed winning outs", () => {
    const o = context(
      [card(10), card(9, 1)],
      [card(8, 2), card(7, 3), card(2)],
    );
    const hand = summarizeDecisionHand(o),
      text = describeDecisionHand(o);
    expect(hand.straightDrawOuts).toBe(8);
    expect(hand.flushDrawOuts).toBe(0);
    expect(text).toMatch(/двусторонн/i);
    expect(text).toMatch(/6|шест/i);
    expect(text).toMatch(/J|валет/i);
    expect(text).not.toMatch(/гарантирован.*(?:побед|выигр)/i);
  });

  it("recognizes two separate inside ranks as a double gutshot", () => {
    const o = context(
      [card(11), card(9, 1)],
      [card(7, 2), card(10, 3), card(13)],
    );
    const hand = summarizeDecisionHand(o),
      text = describeDecisionHand(o);
    expect(hand.straightDrawOuts).toBe(8);
    expect(text).toMatch(/двойн.*гатшот/i);
    expect(text).toMatch(/8|восьм/i);
    expect(text).toMatch(/Q|дам/i);
  });

  it("handles an ace-low gutshot", () => {
    const o = context(
      [card(14), card(2, 1)],
      [card(3, 2), card(5, 3), card(13)],
    );
    const hand = summarizeDecisionHand(o),
      text = describeDecisionHand(o);
    expect(hand.straightDrawOuts).toBe(4);
    expect(text).toMatch(/гатшот/i);
    expect(text).toMatch(/4|четв/i);
  });

  it("counts the nine unseen suit cards for a private flush draw", () => {
    const o = context([card(14), card(7, 1)], [card(13), card(12), card(2)]);
    const hand = summarizeDecisionHand(o),
      text = describeDecisionHand(o);
    expect(hand.category).toBe(0);
    expect(hand.flushDrawOuts).toBe(9);
    expect(text).toMatch(/флеш-дро/i);
    expect(text).toMatch(/9/);
  });

  it("does not claim a private draw when the completing straight or flush would be entirely on the board", () => {
    const o = context(
      [card(2, 1), card(3, 2)],
      [card(10), card(11), card(12), card(13)],
    );
    const hand = summarizeDecisionHand(o);
    expect(hand.straightDrawOuts).toBe(0);
    expect(hand.flushDrawOuts).toBe(0);
    expect(hand.drawText ?? "").not.toMatch(/(?:гатшот|стрит-дро|флеш-дро)/i);
  });

  it("does not offer future draw outs on the river", () => {
    const o = context(
      [card(10), card(9, 1)],
      [card(8, 2), card(7, 3), card(2), card(14, 2), card(3, 3)],
    );
    const hand = summarizeDecisionHand(o),
      text = describeDecisionHand(o);
    expect(hand.straightDrawOuts).toBe(0);
    expect(hand.flushDrawOuts).toBe(0);
    expect(text).not.toMatch(/(?:гатшот|двустороннее стрит-дро|флеш-дро)/i);
  });

  it("identifies a shared royal flush as a board hand rather than private value", () => {
    const o = context(
      [card(2, 1), card(3, 2)],
      [card(10), card(11), card(12), card(13), card(14)],
    );
    const hand = summarizeDecisionHand(o),
      text = describeDecisionHand(o);
    expect(hand.category).toBe(8);
    expect(hand.boardOnly).toBe(true);
    expect(hand.protectionCandidate).toBe(false);
    expect(text).toMatch(/борд|общ/i);
  });

  it("describes a made ace-high flush without pretending a draw remains", () => {
    const o = context([card(14), card(13)], [card(12), card(8), card(3)]);
    const hand = summarizeDecisionHand(o),
      text = describeDecisionHand(o);
    expect(hand.category).toBe(5);
    expect(hand.boardOnly).toBe(false);
    expect(hand.flushDrawOuts).toBe(0);
    expect(hand.protectionCandidate).toBe(false);
    expect(text).toMatch(/флеш/i);
    expect(text).toMatch(/старш.*возможн|натс/i);
    expect(text).not.toMatch(/флеш-дро/i);
  });

  it("uses a frozen public observation without looking for hidden cards or the undealt deck", () => {
    const o = context(),
      before = structuredClone(o);
    Object.defineProperty(o, "deck", {
      get() {
        throw Error("Private deck read");
      },
    });
    Object.defineProperty(o, "holeCards", {
      get() {
        throw Error("Private cards read");
      },
    });
    Object.defineProperty(o.players[1], "cards", {
      get() {
        throw Error("Opponent cards read");
      },
    });
    deepFreeze(o);
    expect(describeDecisionHand(o)).toBe(describeDecisionHand(before));
    expect(summarizeDecisionHand(o)).toEqual(summarizeDecisionHand(before));
    expect(o).toEqual(before);
  });
});

/** These controlled candidate payoffs isolate explanation branches. They are
 * deliberately not evidence that the authored response strategy is optimal. */
function candidate(
  action: ActionType,
  ev: number,
  total?: number,
): SizingCandidate {
  return {
    action,
    ...(total !== undefined ? { total } : {}),
    ev,
    standardError: 0,
    sensitivityLow: ev,
    sensitivityHigh: ev,
    reason: "Контролируемый вариант текущей улицы",
    values: Array(100).fill(ev),
    scenarios: { base: ev, tight: ev, loose: ev },
    details: {
      foldProbability: 0.35,
      callProbability: 0.55,
      raiseProbability: 0.1,
      probeProbability: 0.2,
      heroContinuesRaise: false,
      heroContinuesProbe: false,
      ...(total !== undefined ? { effectiveTotal: total } : {}),
    },
    trusted: true,
  };
}

function analysis(
  best: SizingCandidate,
  actual: SizingCandidate,
): SizingAnalysis {
  return {
    supported: true,
    samples: Array.from({ length: 100 }, () => ({
      villainCards: [card(14), card(13, 1)],
      showdownShare: 0,
    })),
    sampleCount: 100,
    candidates: [actual, best],
    best,
    assumptions: [],
    protection: false,
  };
}

describe("concrete feedback for a controlled supported comparison", () => {
  it("keeps concrete hand facts when multiway grading cannot choose a supported alternative", () => {
    const o = context();
    o.players.push({
      id: "third",
      seat: 2,
      name: "Ещё соперник",
      startStack: 10400,
      stack: 10000,
      committed: 400,
      streetCommitted: 0,
      antePaid: 0,
      folded: false,
      allIn: false,
      profile: "balanced",
    });
    o.pot += 400;
    const a = analyzeDecision(o, { seed: 142, samples: 160 });
    const feedback = gradeDecision(o, a, "check");
    expect(feedback.verdict).toBe("uncertain");
    expect(feedback.reason).toMatch(/гатшот/i);
    expect(feedback.reason).toMatch(/9|девят/i);
    expect(feedback.reason).toMatch(/нескольк.*соперник/i);
  });

  it("names an initial bet and its exact amount when check loses the bounded comparison", () => {
    const o = context(),
      a = analysis(candidate("raise", 300, 330), candidate("check", 0));
    const feedback = gradeSizing(o, a, "check")!;
    expect(feedback.verdict).toBe("risky");
    expect(feedback.reason).toMatch(/гатшот/i);
    expect(feedback.reason).toMatch(/9|девят/i);
    expect(feedback.reason).toMatch(/бет[^.]*330/i);
    expect(feedback.reason).not.toMatch(/рейз до 330/i);
    expect(feedback.reason).toMatch(/фолд|колл|ререйз/i);
  });

  it("names the passive alternative instead of saying only that another action is preferred", () => {
    const o = context(),
      a = analysis(candidate("check", 300), candidate("raise", 0, 350));
    const feedback = gradeSizing(o, a, "raise", 350)!;
    expect(feedback.verdict).toBe("risky");
    expect(feedback.reason).toContain("350");
    expect(feedback.reason).toMatch(/чек/i);
    expect(feedback.reason).toMatch(/гатшот/i);
  });

  it("calls a raise over an existing bet a raise and gives the full total", () => {
    const o = context();
    Object.assign(o.players[1], {
      stack: 9600,
      committed: 1000,
      streetCommitted: 400,
    });
    Object.assign(o, {
      currentBet: 400,
      minRaise: 400,
      minRaiseTo: 800,
      toCall: 400,
      pot: 1400,
      legalActions: ["fold", "call", "raise", "all-in"],
    });
    const a = analysis(candidate("raise", 500, 1000), candidate("call", 0));
    const feedback = gradeSizing(o, a, "call")!;
    expect(feedback.verdict).toBe("risky");
    expect(feedback.reason.replace(/\s/g, "")).toMatch(/рейздо1000/i);
    expect(feedback.reason).not.toMatch(/\bбет 1[\s\u00a0]?000/i);
  });

  it("explains response sensitivity when tighter and looser assumptions reverse the verdict", () => {
    const o = context(),
      best = candidate("raise", 200, 330),
      actual = candidate("check", 0);
    best.scenarios = { base: 200, tight: -200, loose: 400 };
    best.sensitivityLow = -200;
    best.sensitivityHigh = 400;
    const feedback = gradeSizing(o, analysis(best, actual), "check")!;
    expect(feedback.verdict).toBe("uncertain");
    expect(feedback.reason).toMatch(/гатшот/i);
    expect(feedback.reason).toMatch(/узк|широк|тайтов|лузов/i);
    expect(feedback.reason).toMatch(/ответ|соперник/i);
    expect(feedback.reason).not.toMatch(
      /^.*Ограниченная модель предпочитает другой способ продолжить\.?$/i,
    );
  });
});
