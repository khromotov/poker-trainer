import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import {
  applyAction,
  createTrainingHand,
  observe,
  type TrainingHand,
} from "../src/decision/engine";
import {
  allArchives,
  completeSession,
  exportHistory,
  importHistory,
  loadSession,
  parseHistoryImport,
  saveSession,
  type Archive,
  type DecisionSession,
} from "../src/decision/repository";
import { all as equityHistory, save as saveEquity } from "../src/storage";
import {
  loadSession as loadTable,
  saveSession as saveTable,
  type TableSession,
} from "../src/table/repository";
import { createPlayers, startHand } from "../src/table/engine";

const settings = {
  playerCount: 3,
  startingStack: 30_000,
  smallBlind: 100,
  bigBlind: 200,
  randomDepth: false,
};

function session(seed = 100): DecisionSession {
  return {
    version: 1,
    id: `session-${seed}`,
    settings: { ...settings },
    handNumber: 1,
    decisions: [],
    awaitingFeedback: false,
    hand: createTrainingHand(seed, {
      ...settings,
      heroSeat: 0,
      dealerSeat: 0,
      number: 1,
    }),
  };
}

function heroDecision(): DecisionSession {
  const current = session();
  const observation = observe(current.hand!, current.hand!.heroId);
  expect(observation.actorId).toBe(current.hand!.hand.actorId);
  const action = observation.legalActions.includes("call") ? "call" : "check";
  current.decisions.push({
    id: "decision-1",
    timestamp: 10,
    observation,
    action,
    feedback: {
      verdict: "reasonable",
      title: "Разумное действие",
      reason: "Учебная оценка по доступной информации.",
    },
  });
  current.hand = applyAction(current.hand!, action);
  current.awaitingFeedback = true;
  return current;
}

function finished(): { current: DecisionSession; archive: Archive } {
  const current = heroDecision();
  let hand = current.hand!;
  for (let count = 0; hand.phase === "playing"; count += 1) {
    if (count > 1000) throw Error("Hand did not finish");
    const observation = observe(hand, hand.hand.actorId!);
    hand = applyAction(
      hand,
      observation.legalActions.includes("check") ? "check" : "call",
      undefined,
      "Private bot explanation",
    );
  }
  current.hand = hand;
  current.awaitingFeedback = false;
  return {
    current,
    archive: {
      id: `${current.id}:${hand.id}`,
      sessionId: current.id,
      timestamp: 1000,
      hand,
      decisions: current.decisions,
    },
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.restoreAllMocks();
});

describe("decision trainer persistence", () => {
  it("restores the full deal and grading pause independently of the previous databases", async () => {
    const equity = {
      id: "old-result",
      timestamp: 1,
      mode: "Random" as const,
      cards: [0, 1, 2, 3],
      answer: 50,
      equity: 0.5,
      win: 0.4,
      tie: 0.2,
      simulations: 10000,
      signed: 0,
      absolute: 0,
      categories: [],
    };
    await saveEquity(equity);
    const players = createPlayers(3, 30_000);
    const tableSettings = {
      startingStack: 30_000,
      smallBlind: 100,
      bigBlind: 200,
      reentry: true,
    };
    const previous: TableSession = {
      version: 1,
      id: "retired-table",
      settings: tableSettings,
      players,
      heroId: players[0].id,
      dealerSeat: 0,
      handNumber: 1,
      hand: startHand(players, tableSettings, 0, players[0].id),
    };
    await saveTable(previous);
    expect(await loadSession()).toBeNull();
    const current = heroDecision();
    await saveSession(current);
    expect(await loadSession()).toEqual(current);
    expect((await loadSession())!.awaitingFeedback).toBe(true);
    expect(await loadTable()).toEqual(previous);
    expect(await equityHistory()).toEqual([equity]);
  });

  it("persists an all-street finished hand and archive atomically and idempotently", async () => {
    const { current, archive } = finished();
    expect(current.hand!.street).toBe("river");
    await completeSession(current, archive);
    await completeSession(current, archive);
    expect(await loadSession()).toEqual(current);
    expect(await allArchives()).toEqual([archive]);
    await expect(
      completeSession({ ...current, id: "another-session" }, archive),
    ).rejects.toThrow();
    expect((await loadSession())!.id).toBe(current.id);
  });

  it("never exports the unfinished current private deal and imports history without replacing it", async () => {
    const current = session(999);
    await saveSession(current);
    const { archive } = finished();
    const payload = parseHistoryImport(exportHistory([archive]));
    expect(Object.keys(payload).sort()).toEqual([
      "format",
      "history",
      "version",
    ]);
    expect(payload.history[0].hand.holeCards).toEqual(archive.hand.holeCards);
    expect(await importHistory(payload)).toEqual({ added: 1, skipped: 0 });
    expect(await loadSession()).toEqual(current);
    const conflict = { ...archive, timestamp: 5000 };
    const next = { ...archive, id: "next-archive", timestamp: 2000 };
    expect(
      await importHistory({ ...payload, history: [conflict, next] }),
    ).toEqual({ added: 1, skipped: 1 });
    expect(await allArchives()).toEqual([next, archive]);
    expect(await importHistory(payload)).toEqual({ added: 0, skipped: 1 });
  });

  it("stores feedback and observation before the action without private card, runout or reason additions", async () => {
    const current = heroDecision();
    const observation = current.decisions[0].observation as unknown as Record<
      string,
      unknown
    >;
    observation.deck = current.hand!.deck;
    observation.holeCards = current.hand!.holeCards;
    (observation.history as Array<Record<string, unknown>>)[0].reason =
      "Secret strategy with the opponent’s real cards";
    (observation.players as Array<Record<string, unknown>>)[1].cards = [42, 43];
    await saveSession(current);
    const saved = (await loadSession())!;
    expect(saved.decisions[0].observation).not.toHaveProperty("holeCards");
    expect(saved.decisions[0].observation).not.toHaveProperty("deck");
    expect(
      saved.decisions[0].observation.history.every((log) => !("reason" in log)),
    ).toBe(true);
    expect(
      saved.decisions[0].observation.players.every(
        (player) => !("cards" in player),
      ),
    ).toBe(true);
    expect(saved.hand!.holeCards).toEqual(current.hand!.holeCards);
    expect(saved.decisions[0].observation.history.length).toBeLessThan(
      saved.hand!.logs.length,
    );
  });

  it("saves a blank session and rejects malformed writes without replacing existing data", async () => {
    const blank: DecisionSession = { ...session(), hand: null, handNumber: 0 };
    await saveSession(blank);
    expect(await loadSession()).toEqual(blank);
    const bad = session();
    bad.settings.startingStack = -10;
    await expect(saveSession(bad)).rejects.toThrow();
    expect(await loadSession()).toEqual(blank);
  });

  it("allows changing next-hand settings without changing the current deal", async () => {
    const current = heroDecision();
    const originalHand = structuredClone(current.hand);
    current.settings = {
      ...current.settings,
      playerCount: 10,
      startingStack: 60_000,
      randomDepth: true,
    };
    await saveSession(current);
    expect((await loadSession())!.settings).toEqual(current.settings);
    expect((await loadSession())!.hand).toEqual(originalHand);
  });

  it("rolls back the session when the archive write fails and allows a clean retry", async () => {
    const previous = session(999);
    await saveSession(previous);
    const { current, archive } = finished();
    const originalAdd = IDBObjectStore.prototype.add;
    const failingWrite = vi
      .spyOn(IDBObjectStore.prototype, "add")
      .mockImplementation(function (
        ...args: Parameters<IDBObjectStore["add"]>
      ) {
        const request = originalAdd.apply(this, args);
        // A second add with the same key fails asynchronously and aborts both stores.
        if (this.name === "hands") originalAdd.apply(this, args);
        return request;
      });
    await expect(completeSession(current, archive)).rejects.toThrow();
    failingWrite.mockRestore();
    expect(await loadSession()).toEqual(previous);
    expect(await allArchives()).toEqual([]);
    await completeSession(current, archive);
    expect(await loadSession()).toEqual(current);
    expect(await allArchives()).toEqual([archive]);
  });

  it("restores intermediate states through raises, folds, all-ins and street transitions", async () => {
    let sawAllIn = false;
    let sawFlop = false;
    for (let seed = 1; seed <= 20; seed++) {
      const current = session(seed);
      current.settings.randomDepth = true;
      current.hand = createTrainingHand(seed, {
        ...current.settings,
        heroSeat: 0,
        dealerSeat: 0,
      });
      for (let step = 0; current.hand.phase === "playing"; step++) {
        if (step > 200) throw Error("Hand failed to terminate");
        const observation = observe(current.hand, current.hand.hand.actorId!);
        const action =
          observation.legalActions[
            (seed * 13 + step * 17) % observation.legalActions.length
          ];
        const total =
          action === "raise"
            ? Math.min(observation.minRaiseTo, observation.maxRaiseTo)
            : undefined;
        if (observation.actorId === current.hand.heroId)
          current.decisions.push({
            id: `choice-${seed}-${step}`,
            timestamp: seed * 1000 + step,
            observation,
            action,
            ...(total === undefined ? {} : { total }),
            feedback: {
              verdict: "uncertain",
              title: "Учебный разбор",
              reason: "Проверка сохранения решения.",
            },
          });
        sawAllIn ||= action === "all-in";
        current.hand = applyAction(current.hand, action, total);
        sawFlop ||= current.hand.board.length >= 3;
        await saveSession(current);
        expect(await loadSession()).toEqual(current);
      }
    }
    expect(sawAllIn).toBe(true);
    expect(sawFlop).toBe(true);
  });
});

describe("decision history validation", () => {
  it.each([
    [
      "duplicate dealt cards",
      (hand: TrainingHand) => {
        hand.holeCards[hand.heroId][0] = hand.deck[0];
      },
    ],
    [
      "invalid card ID",
      (hand: TrainingHand) => {
        hand.deck[0] = 52;
      },
    ],
    [
      "missing opponent cards",
      (hand: TrainingHand) => {
        delete hand.holeCards[hand.hand.players[1].id];
      },
    ],
    [
      "fractional stack",
      (hand: TrainingHand) => {
        hand.hand.players[0].stack += 0.5;
      },
    ],
    [
      "unsafe stack",
      (hand: TrainingHand) => {
        hand.hand.players[0].stack = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "duplicate player ID",
      (hand: TrainingHand) => {
        hand.hand.players[1].id = hand.hand.players[0].id;
      },
    ],
    [
      "invalid opponent profile",
      (hand: TrainingHand) => {
        (hand.profiles as Record<string, string>)[hand.heroId] = "seer";
      },
    ],
    [
      "unpaid archived hand",
      (hand: TrainingHand) => {
        hand.hand.status = "settlement";
      },
    ],
    [
      "unfinished archived hand",
      (hand: TrainingHand) => {
        hand.phase = "playing";
      },
    ],
    [
      "changed board",
      (hand: TrainingHand) => {
        hand.board.reverse();
      },
    ],
    [
      "unknown history action",
      (hand: TrainingHand) => {
        (hand.logs[0] as unknown as { action: string }).action = "win";
      },
    ],
    [
      "invalid net",
      (hand: TrainingHand) => {
        hand.results![0].net += 1;
      },
    ],
  ])("rejects %s before writing", async (_name, mutate) => {
    const { archive } = finished();
    mutate(archive.hand);
    await expect(
      importHistory({
        format: "poker-decisions",
        version: 1,
        history: [archive],
      }),
    ).rejects.toThrow();
    expect(await allArchives()).toEqual([]);
  });

  it("rejects hidden future boards, mismatched hero cards and invalid feedback grades", () => {
    for (const mutate of [
      (archive: Archive) => {
        archive.decisions[0].observation.board = archive.hand.board;
      },
      (archive: Archive) => {
        archive.decisions[0].observation.heroCards =
          archive.hand.holeCards[archive.hand.hand.players[1].id];
      },
      (archive: Archive) => {
        (archive.decisions[0].feedback as { verdict: string }).verdict =
          "perfect-gto";
      },
      (archive: Archive) => {
        archive.decisions[0].observation.history[0].total += 1;
      },
      (archive: Archive) => {
        archive.decisions[0].observation.players[0].stack += 1;
      },
      (archive: Archive) => {
        archive.decisions[0].action = "raise";
        archive.decisions[0].total = 0;
      },
    ]) {
      const { archive } = finished();
      mutate(archive);
      expect(() => exportHistory([archive])).toThrow();
    }
  });

  it("rejects duplicate IDs, unknown versions, oversized files and unrelated histories", () => {
    const { archive } = finished();
    expect(() => exportHistory([archive, archive])).toThrow();
    expect(() =>
      parseHistoryImport(
        JSON.stringify({ format: "poker-decisions", version: 2, history: [] }),
      ),
    ).toThrow();
    expect(() => parseHistoryImport(" ".repeat(10 * 1024 * 1024 + 1))).toThrow(
      /10/,
    );
    expect(() => parseHistoryImport("{")).toThrow(/JSON/);
    expect(() =>
      parseHistoryImport(
        JSON.stringify({ format: "poker-table", version: 1, history: [] }),
      ),
    ).toThrow();
  });
});
