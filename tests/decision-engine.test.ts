import { describe, expect, it } from "vitest";
import { deck, seeded } from "../src/core";
import {
  applyAction,
  createTrainingHand,
  observe,
  type TrainingHand,
} from "../src/decision/engine";
import { pot, startHand } from "../src/table/engine";

function passiveToEnd(input: TrainingHand): TrainingHand {
  let hand = input;
  for (let step = 0; hand.phase === "playing" && step < 100; step++) {
    const view = observe(hand, hand.hand.actorId!);
    hand = applyAction(hand, view.toCall > 0 ? "call" : "check");
  }
  expect(hand.phase).toBe("finished");
  return hand;
}

function withStacks(
  stacks: number[],
  dealer = stacks.length - 1,
): TrainingHand {
  const training = createTrainingHand(24, {
    playerCount: stacks.length,
    dealerSeat: dealer,
  });
  training.initialPlayers.forEach((player, index) => {
    player.stack = stacks[index];
  });
  training.hand = startHand(
    training.initialPlayers,
    { startingStack: 30_000, smallBlind: 100, bigBlind: 200, reentry: false },
    dealer,
    training.heroId,
  );
  training.logs = training.hand.actions.map((action) => ({
    street: "preflop",
    actorId: action.playerId,
    action: action.type,
    total: action.total,
    paid: action.paid,
  }));
  return training;
}

function fixedRunout(training: TrainingHand, board: number[]) {
  const cards = deck().filter((card) => !board.includes(card));
  training.hand.players.forEach((player, index) => {
    training.holeCards[player.id] = cards.slice(index * 2, index * 2 + 2);
  });
  training.deck = [...board, ...cards.slice(training.hand.players.length * 2)];
  return training;
}

describe("decision trainer complete hand engine", () => {
  it("deals all private cards before play, deterministically with a fixed unique runout", () => {
    const first = createTrainingHand(742, {
      playerCount: 10,
      randomDepth: true,
    });
    expect(first).toEqual(
      createTrainingHand(742, { playerCount: 10, randomDepth: true }),
    );
    expect(first).not.toEqual(
      createTrainingHand(743, { playerCount: 10, randomDepth: true }),
    );
    const cards = [...Object.values(first.holeCards).flat(), ...first.deck];
    expect(cards).toHaveLength(52);
    expect(new Set(cards).size).toBe(52);
    expect(
      Object.values(first.holeCards).every((cards) => cards.length === 2),
    ).toBe(true);
    expect(first.board).toEqual([]);
    expect(
      first.initialPlayers.every(
        (player) =>
          player.stack % 200 === 0 &&
          player.stack >= 4000 &&
          player.stack <= 30000,
      ),
    ).toBe(true);
  });

  it("observation exposes only the observer own cards and public history", () => {
    const hand = createTrainingHand(532, { playerCount: 4 });
    const actor = hand.hand.actorId!;
    const initial = observe(hand, actor);
    const changed = structuredClone(hand);
    changed.deck.reverse();
    for (const id of Object.keys(changed.holeCards))
      if (id !== actor) changed.holeCards[id] = [50, 51];
    changed.logs.forEach((log) => {
      log.reason = "Private AA hidden explanation";
    });
    expect(observe(changed, actor)).toEqual(initial);
    expect(initial).not.toHaveProperty("deck");
    expect(initial).not.toHaveProperty("holeCards");
    expect(initial.history.every((log) => !("reason" in log))).toBe(true);
    expect(
      initial.players.every(
        (player) => !("cards" in player) && !("holeCards" in player),
      ),
    ).toBe(true);
    initial.heroCards[0] = -1;
    initial.board.push(-1);
    initial.players[0].stack = -1;
    expect(observe(hand, actor)).not.toEqual(initial);
    const botId = hand.hand.players.find(
      (player) => player.id !== hand.heroId,
    )!.id;
    expect(observe(hand, botId).heroCards).toEqual(hand.holeCards[botId]);
  });

  it("moves all four streets, resetting only the street ledger", () => {
    let hand = createTrainingHand(52, { playerCount: 3, dealerSeat: 2 });
    while (hand.street === "preflop") {
      const view = observe(hand, hand.hand.actorId!);
      hand = applyAction(hand, view.toCall ? "call" : "check");
    }
    expect(hand.street).toBe("flop");
    expect(hand.board).toEqual(hand.deck.slice(0, 3));
    expect(hand.hand.actorId).toBe("player-1");
    expect(hand.hand.players.map((player) => player.streetCommitted)).toEqual([
      0, 0, 0,
    ]);
    expect(hand.hand.players.map((player) => player.committed)).toEqual([
      200, 400, 200,
    ]);
    expect(hand.hand.currentBet).toBe(0);
    expect(pot(hand.hand)).toBe(800);
    const finished = passiveToEnd(hand);
    expect(finished.logs.map((log) => log.street)).toEqual(
      expect.arrayContaining(["preflop", "flop", "turn", "river"]),
    );
    expect(finished.board).toEqual(hand.deck.slice(0, 5));
    expect(
      finished.hand.players.reduce((sum, player) => sum + player.stack, 0),
    ).toBe(90_000);
    expect(finished.results!.reduce((sum, result) => sum + result.net, 0)).toBe(
      0,
    );
  });

  it("heads up has BTN/SB first preflop and BB first postflop", () => {
    let hand = createTrainingHand(32, { playerCount: 2, dealerSeat: 0 });
    expect(hand.hand.actorId).toBe("player-1");
    hand = applyAction(hand, "call");
    expect(hand.hand.actorId).toBe("player-2");
    hand = applyAction(hand, "check");
    expect(hand.street).toBe("flop");
    expect(hand.hand.actorId).toBe("player-2");
    expect(observe(hand, "player-2").legalActions).toContain("raise");
    expect(observe(hand, "player-2").minRaiseTo).toBe(200);
  });

  it("rejects a free fold and keeps check available in the same decision", () => {
    let hand = createTrainingHand(32, { playerCount: 2, dealerSeat: 0 });
    hand = applyAction(hand, "call");
    const original = structuredClone(hand);
    expect(observe(hand, hand.hand.actorId!).legalActions).toContain("check");
    expect(observe(hand, hand.hand.actorId!).legalActions).not.toContain(
      "fold",
    );
    expect(() => applyAction(hand, "fold")).toThrow("Действие недоступно");
    expect(() => applyAction(hand, "call")).toThrow("Действие недоступно");
    expect(hand).toEqual(original);
    expect(applyAction(hand, "check").street).toBe("flop");
  });

  it("rejects actions after completion or on a state no longer accepting a decision", () => {
    const hand = createTrainingHand(65, { playerCount: 2, dealerSeat: 0 });
    const complete = applyAction(hand, "fold");
    const original = structuredClone(complete);
    expect(complete.phase).toBe("finished");
    expect(observe(complete, complete.heroId).legalActions).toEqual([]);
    for (const action of ["fold", "check", "call", "raise", "all-in"] as const)
      expect(() => applyAction(complete, action, 1000)).toThrow(
        "Раздача завершена",
      );
    expect(complete).toEqual(original);
    const settled = structuredClone(hand);
    settled.hand.status = "settlement";
    expect(observe(settled, settled.hand.actorId!).legalActions).toEqual([]);
    expect(() => applyAction(settled, "call")).toThrow("Раздача завершена");
    const noActor = structuredClone(hand);
    noActor.hand.actorId = null;
    expect(() => applyAction(noActor, "call")).toThrow("Раздача завершена");
  });

  it("does not change dealt cards when an action differs, and never mutates input", () => {
    const hand = createTrainingHand(22, { playerCount: 3 });
    const original = structuredClone(hand);
    const call = applyAction(hand, "call");
    const raise = applyAction(hand, "raise", 600);
    expect(call.deck).toEqual(raise.deck);
    expect(call.holeCards).toEqual(raise.holeCards);
    expect(hand).toEqual(original);
    expect(passiveToEnd(call).board).toEqual(passiveToEnd(raise).board);
  });

  it("a fold win returns the uncalled bet and does not reveal a board", () => {
    let hand = createTrainingHand(65, { playerCount: 2, dealerSeat: 0 });
    hand = applyAction(hand, "raise", 2000);
    hand = applyAction(hand, "fold");
    expect(hand.phase).toBe("finished");
    expect(hand.board).toEqual([]);
    expect(
      hand.results?.find((result) => result.playerId === "player-1")?.net,
    ).toBe(400);
    expect(
      hand.results?.find((result) => result.playerId === "player-2")?.net,
    ).toBe(-400);
    expect(hand.hand.players[0].returned).toBe(1800);
    expect(observe(hand, hand.heroId).legalActions).toEqual([]);
  });

  it("all-in call runs out the fixed board and finishes without empty side-pot bets", () => {
    let hand = createTrainingHand(62, {
      playerCount: 2,
      dealerSeat: 0,
      startingStack: 1000,
    });
    hand = applyAction(hand, "all-in");
    expect(observe(hand, hand.hand.actorId!).legalActions).toEqual([
      "fold",
      "call",
      "all-in",
    ]);
    hand = applyAction(hand, "call");
    expect(hand.phase).toBe("finished");
    expect(hand.board).toEqual(hand.deck.slice(0, 5));
    expect(
      hand.hand.players.reduce((sum, player) => sum + player.stack, 0),
    ).toBe(2000);
  });

  it("short BB pays ante first and can win the ante pot without a live wager", () => {
    const hand = createTrainingHand(931, {
      playerCount: 2,
      startingStack: 100,
      dealerSeat: 0,
    });
    expect(hand.phase).toBe("finished");
    const bb = hand.hand.players[1];
    expect(bb.antePaid).toBe(100);
    expect(bb.streetCommitted).toBe(0);
    expect(
      hand.hand.players.reduce((sum, player) => sum + player.stack, 0),
    ).toBe(200);
  });

  it("splits a board royal flush and gives the BB ante odd chip clockwise after BTN", () => {
    let hand = fixedRunout(
      createTrainingHand(83, {
        playerCount: 2,
        dealerSeat: 0,
        smallBlind: 1,
        bigBlind: 3,
      }),
      [32, 36, 40, 44, 48],
    );
    hand = passiveToEnd(hand);
    expect(
      hand.results?.find((result) => result.playerId === "player-2")?.payout,
    ).toBe(5);
    expect(
      hand.results?.find((result) => result.playerId === "player-1")?.payout,
    ).toBe(4);
    expect(hand.results!.reduce((sum, result) => sum + result.net, 0)).toBe(0);
  });

  it("settles side pots from whole-hand contributions", () => {
    let hand = fixedRunout(
      withStacks([1000, 2000, 5000]),
      [32, 36, 40, 44, 48],
    );
    hand = applyAction(hand, "all-in"); // BTN 5000
    hand = applyAction(hand, "call"); // SB 1000
    hand = applyAction(hand, "call"); // BB 1800 live + 200 ante
    expect(hand.phase).toBe("finished");
    // All hands tie; main 3200 splits three ways (odd chip SB then BB),
    // side 1600 splits BB/BTN, and BTN gets uncalled 3200 back.
    expect(hand.hand.players.map((player) => player.stack)).toEqual([
      1067, 1867, 5066,
    ]);
    expect(
      hand.hand.players.reduce((sum, player) => sum + player.stack, 0),
    ).toBe(8000);
  });

  it("preserves matched chips when different rivals call on different streets", () => {
    let hand = createTrainingHand(90, { playerCount: 3, dealerSeat: 2 });
    hand = applyAction(hand, "raise", 1000);
    hand = applyAction(hand, "call");
    hand = applyAction(hand, "call");
    hand = applyAction(hand, "raise", 1000); // SB bets flop
    hand = applyAction(hand, "fold"); // BB folds
    hand = applyAction(hand, "call"); // BTN calls
    hand = applyAction(hand, "check"); // SB turn
    hand = applyAction(hand, "raise", 1000); // BTN turn
    hand = applyAction(hand, "fold"); // SB folds
    expect(hand.phase).toBe("finished");
    expect(
      hand.results?.find((result) => result.playerId === "player-3")?.payout,
    ).toBe(5200);
    expect(
      hand.results?.find((result) => result.playerId === "player-3")?.net,
    ).toBe(3200);
    expect(hand.hand.players.map((player) => player.stack)).toEqual([
      28000, 28800, 33200,
    ]);
  });

  it("retains minimum raises and cumulative short-all-in reopening rules on postflop streets", () => {
    let hand = createTrainingHand(98, { playerCount: 3, dealerSeat: 2 });
    while (hand.street === "preflop") {
      const view = observe(hand, hand.hand.actorId!);
      hand = applyAction(hand, view.toCall ? "call" : "check");
    }
    hand = applyAction(hand, "raise", 1000);
    const first = hand.hand.players.find((player) => player.id === "player-2")!;
    first.stack = 1400; // Test fixture short stack; state still tests street admission.
    hand = applyAction(hand, "all-in"); // incomplete 400 increment
    hand = applyAction(hand, "call");
    expect(hand.hand.actorId).toBe("player-1");
    expect(observe(hand, "player-1").canRaise).toBe(false);
    expect(() => applyAction(hand, "raise", 2400)).toThrow();
    hand = applyAction(hand, "call");
    expect(hand.street).toBe("turn");
    expect(hand.hand.actedSinceFullRaise).toEqual([]);
  });

  it("finishes over 200 varied legal games conserving chips, cards and legal actors", () => {
    for (let seed = 0; seed < 240; seed++) {
      const random = seeded(seed + 4829);
      let hand = createTrainingHand(seed, {
        playerCount: 2 + (seed % 9),
        randomDepth: true,
      });
      const total = hand.initialPlayers.reduce(
        (sum, player) => sum + player.stack,
        0,
      );
      const future = [...hand.deck];
      for (let step = 0; hand.phase === "playing" && step < 300; step++) {
        const view = observe(hand, hand.hand.actorId!);
        const choices = view.legalActions;
        let action = choices[Math.floor(random() * choices.length)];
        let target: number | undefined;
        if (action === "raise") {
          if (view.minRaiseTo > view.maxRaiseTo) action = "all-in";
          else
            target = Math.min(
              view.maxRaiseTo,
              view.minRaiseTo + Math.floor(random() * 8) * view.bigBlind,
            );
        }
        hand = applyAction(hand, action, target);
        expect(hand.deck).toEqual(future);
        expect(hand.board).toEqual(future.slice(0, hand.board.length));
        expect(
          hand.hand.players.every(
            (player) => Number.isInteger(player.stack) && player.stack >= 0,
          ),
        ).toBe(true);
        if (hand.phase === "playing") {
          expect(
            hand.hand.players.reduce((sum, player) => sum + player.stack, 0) +
              pot(hand.hand),
          ).toBe(total);
          const actor = hand.hand.players.find(
            (player) => player.id === hand.hand.actorId,
          )!;
          expect(actor.folded || actor.allIn).toBe(false);
        }
      }
      expect(hand.phase, `seed ${seed}`).toBe("finished");
      expect(
        hand.hand.players.reduce((sum, player) => sum + player.stack, 0),
        `seed ${seed}`,
      ).toBe(total);
      expect(hand.results!.reduce((sum, result) => sum + result.net, 0)).toBe(
        0,
      );
      expect(
        hand.results!.reduce((sum, result) => sum + result.payout, 0),
      ).toBe(pot(hand.hand));
    }
  });
});
