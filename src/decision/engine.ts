import { compare, deck as freshDeck, evaluate, seeded } from "../core";
import {
  act,
  canRaise as tableCanRaise,
  createPlayers,
  pot,
  sidePots,
  startHand,
  type ActionType,
  type Hand,
  type Player,
} from "../table/engine";

export type { ActionType } from "../table/engine";
export type Street = "preflop" | "flop" | "turn" | "river";
export type OpponentProfile = "balanced" | "tight" | "loose";
export interface TrainingLog {
  street: Street;
  actorId: string;
  action: ActionType | "ante" | "small-blind" | "big-blind";
  total: number;
  paid: number;
  /** Private explanation, revealed only after the hand. Never part of observations. */
  reason?: string;
}
export interface TrainingResult {
  playerId: string;
  payout: number;
  net: number;
}
export interface TrainingHand {
  id: string;
  seed: number;
  number: number;
  hand: Hand;
  street: Street;
  board: number[];
  /** Fixed shuffled undealt deck. The first five cards are the fixed runout. */
  deck: number[];
  holeCards: Record<string, number[]>;
  heroId: string;
  phase: "playing" | "finished";
  logs: TrainingLog[];
  results?: TrainingResult[];
  initialPlayers: Player[];
  profiles: Record<string, OpponentProfile>;
}
export interface PublicPlayer {
  id: string;
  seat: number;
  name: string;
  startStack: number;
  stack: number;
  committed: number;
  streetCommitted: number;
  antePaid: number;
  folded: boolean;
  allIn: boolean;
  profile: OpponentProfile;
}
export interface DecisionObservation {
  street: Street;
  board: number[];
  /** Only this observer's cards. The observer can be the hero or a bot. */
  heroCards: number[];
  actorId: string;
  players: PublicPlayer[];
  history: Omit<TrainingLog, "reason">[];
  dealerSeat: number;
  bigBlind: number;
  smallBlind: number;
  ante: number;
  currentBet: number;
  /** Minimum full raise increment, not its total. */
  minRaise: number;
  canRaise: boolean;
  pot: number;
  toCall: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  legalActions: ActionType[];
}
export interface TrainingOptions {
  playerCount?: number;
  heroSeat?: number;
  dealerSeat?: number;
  startingStack?: number;
  smallBlind?: number;
  bigBlind?: number;
  number?: number;
  randomDepth?: boolean;
}

const clockwise = <T extends { seat: number }>(players: T[], after: number) =>
  [...players].sort(
    (a, b) =>
      ((a.seat - after + 10) % 10 || 10) - ((b.seat - after + 10) % 10 || 10),
  );

export function createTrainingHand(
  seed: number,
  options: TrainingOptions = {},
): TrainingHand {
  if (!Number.isSafeInteger(seed))
    throw new Error("Некорректный seed раздачи.");
  const random = seeded(seed);
  const playerCount = options.playerCount ?? 6;
  const startingStack = options.startingStack ?? 30_000;
  const smallBlind = options.smallBlind ?? 100;
  const bigBlind = options.bigBlind ?? 200;
  const number = options.number ?? 1;
  const initialPlayers = createPlayers(playerCount, startingStack).map(
    (player) => ({
      ...player,
      name: `Игрок ${player.seat + 1}`,
      stack: options.randomDepth
        ? Math.min(
            startingStack,
            [20, 30, 50, 75, 100, 150][Math.floor(random() * 6)] * bigBlind,
          )
        : player.stack,
    }),
  );
  const heroSeat = options.heroSeat ?? 0;
  const hero = initialPlayers.find((player) => player.seat === heroSeat);
  if (!hero) throw new Error("Некорректное место героя.");
  const dealerSeat = options.dealerSeat ?? Math.floor(random() * playerCount);
  const shuffled = freshDeck();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const other = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[other]] = [shuffled[other], shuffled[i]];
  }
  const holeCards: Record<string, number[]> = {};
  // Deal every opponent's cards before the first betting decision.
  initialPlayers.forEach((player, index) => {
    holeCards[player.id] = [shuffled[index], shuffled[index + playerCount]];
  });
  const profiles: Record<string, OpponentProfile> = {};
  initialPlayers.forEach((player) => {
    profiles[player.id] = (["balanced", "balanced", "tight", "loose"] as const)[
      Math.floor(random() * 4)
    ];
  });
  // A trainee's grading style must not be selected by a hidden random draw.
  profiles[hero.id] = "balanced";
  const hand = startHand(
    initialPlayers,
    { startingStack, smallBlind, bigBlind, reentry: false },
    dealerSeat,
    hero.id,
    number,
  );
  const result: TrainingHand = {
    id: `decision-${seed}-${number}`,
    seed,
    number,
    hand,
    street: "preflop",
    board: [],
    deck: shuffled.slice(playerCount * 2),
    holeCards,
    heroId: hero.id,
    phase: "playing",
    logs: hand.actions.map((action) => ({
      street: "preflop",
      actorId: action.playerId,
      action: action.type,
      total: action.total,
      paid: action.paid,
    })),
    initialPlayers,
    profiles,
  };
  return advanceStreets(result);
}

export function legalActions(observation: DecisionObservation): ActionType[] {
  return [...observation.legalActions];
}

/** Positions stay tied to the seats dealt in, including players who folded. */
export function positionLabel(
  observation: Pick<DecisionObservation, "players" | "dealerSeat">,
  playerId: string,
): string {
  const players = observation.players;
  const player = players.find((candidate) => candidate.id === playerId);
  if (!player) return "";
  const order = clockwise(players, observation.dealerSeat);
  if (players.length === 2)
    return player.seat === observation.dealerSeat ? "BTN / SB" : "BB";
  if (player.seat === observation.dealerSeat) return "BTN";
  const offset = order.findIndex((candidate) => candidate.id === playerId);
  if (offset === 0) return "SB";
  if (offset === 1) return "BB";
  const remaining = players.length - 3;
  const names =
    remaining === 1
      ? ["CO"]
      : remaining === 2
        ? ["HJ", "CO"]
        : remaining === 3
          ? ["UTG", "HJ", "CO"]
          : [
              ...Array.from({ length: remaining - 3 }, (_, index) =>
                index ? `UTG+${index}` : "UTG",
              ),
              "LJ",
              "HJ",
              "CO",
            ];
  return names[offset - 2] ?? "";
}

/** The policy boundary: explicitly copy public values; never spread private state. */
export function observe(
  training: TrainingHand,
  observerId: string,
): DecisionObservation {
  const { hand } = training;
  const observer = hand.players.find((player) => player.id === observerId);
  if (!observer || !training.holeCards[observerId])
    throw new Error("Неизвестный игрок.");
  const owes = Math.max(0, hand.currentBet - observer.streetCommitted);
  const isActor =
    training.phase === "playing" &&
    hand.status === "playing" &&
    hand.actorId === observerId;
  const canRaise = isActor && tableCanRaise(hand);
  const actions: ActionType[] = [];
  if (isActor) {
    if (owes > 0) actions.push("fold", "call");
    else actions.push("check");
    if (canRaise) actions.push("raise");
    if (canRaise || (owes > 0 && observer.stack <= owes))
      actions.push("all-in");
  }
  return {
    street: training.street,
    board: [...training.board],
    heroCards: [...training.holeCards[observerId]],
    actorId: observerId,
    players: hand.players.map((player) => ({
      id: player.id,
      seat: player.seat,
      name: player.name,
      startStack: player.startStack,
      stack: player.stack,
      committed: player.committed,
      streetCommitted: player.streetCommitted,
      antePaid: player.antePaid,
      folded: player.folded,
      allIn: player.allIn,
      profile: training.profiles[player.id],
    })),
    history: training.logs.map((log) => ({
      street: log.street,
      actorId: log.actorId,
      action: log.action,
      total: log.total,
      paid: log.paid,
    })),
    dealerSeat: hand.dealerSeat,
    bigBlind: hand.bigBlind,
    smallBlind: hand.smallBlind,
    ante: hand.ante,
    currentBet: hand.currentBet,
    minRaise: hand.minRaise,
    canRaise,
    pot: pot(hand),
    toCall: Math.min(owes, observer.stack),
    minRaiseTo: hand.currentBet + hand.minRaise,
    maxRaiseTo: observer.streetCommitted + observer.stack,
    legalActions: actions,
  };
}

/** Full chip accounting reuses the same tested no-limit admission on every street. */
export function applyAction(
  input: TrainingHand,
  action: ActionType,
  total?: number,
  reason?: string,
): TrainingHand {
  if (
    input.phase !== "playing" ||
    input.hand.status !== "playing" ||
    !input.hand.actorId
  )
    throw new Error("Раздача завершена.");
  if (!observe(input, input.hand.actorId).legalActions.includes(action))
    throw new Error("Действие недоступно: выберите один из разрешённых ходов.");
  const result: TrainingHand = structuredClone(input);
  result.hand = act(input.hand, action, total);
  const recorded = result.hand.actions[result.hand.actions.length - 1];
  result.logs.push({
    street: input.street,
    actorId: recorded.playerId,
    action: recorded.type,
    total: recorded.total,
    paid: recorded.paid,
    ...(reason ? { reason } : {}),
  });
  return advanceStreets(result);
}

function advanceStreets(training: TrainingHand): TrainingHand {
  if (training.hand.status !== "settlement") return training;
  const remaining = training.hand.players.filter((player) => !player.folded);
  if (remaining.length === 1) return finish(training);
  if (training.street === "river") return finish(training);
  const actionable = remaining.filter((player) => !player.allIn);
  if (actionable.length <= 1) {
    training.street = "river";
    training.board = training.deck.slice(0, 5);
    return finish(training);
  }
  training.street = ({ preflop: "flop", flop: "turn", turn: "river" } as const)[
    training.street
  ];
  training.board = training.deck.slice(
    0,
    training.street === "flop" ? 3 : training.street === "turn" ? 4 : 5,
  );
  const { hand } = training;
  hand.players.forEach((player) => {
    player.streetCommitted = 0;
  });
  hand.currentBet = 0;
  hand.minRaise = hand.bigBlind;
  hand.actedSinceFullRaise = [];
  hand.lastActionBet = {};
  hand.pending = clockwise(actionable, hand.dealerSeat).map(
    (player) => player.id,
  );
  hand.actorId = hand.pending[0];
  hand.status = "playing";
  return training;
}

function finish(training: TrainingHand): TrainingHand {
  const { hand } = training;
  // Legacy sidePots uses a single street. Supply total live commitments, preserving
  // dead BB ante eligibility. Never refund aggregate commitments: different rivals
  // may have matched the winner on different streets.
  const totalHand: Hand = {
    ...hand,
    players: hand.players.map((player) => ({
      ...player,
      streetCommitted: player.committed - player.antePaid,
    })),
  };
  const payouts = new Map(hand.players.map((player) => [player.id, 0]));
  const remaining = hand.players.filter((player) => !player.folded);
  const scores = new Map(
    remaining.length > 1
      ? remaining.map(
          (player) =>
            [
              player.id,
              evaluate([...training.holeCards[player.id], ...training.board]),
            ] as const,
        )
      : [],
  );
  for (const sidePot of sidePots(totalHand)) {
    const eligible = hand.players.filter((player) =>
      sidePot.eligible.includes(player.id),
    );
    if (!eligible.length)
      throw new Error("В банке нет допустимого победителя.");
    let winners = [eligible[0]];
    for (const candidate of eligible.slice(1)) {
      const comparison = compare(
        scores.get(candidate.id)!,
        scores.get(winners[0].id)!,
      );
      if (comparison > 0) winners = [candidate];
      else if (comparison === 0) winners.push(candidate);
    }
    const ordered = clockwise(winners, hand.dealerSeat);
    const share = Math.floor(sidePot.amount / ordered.length);
    ordered.forEach((player, index) =>
      payouts.set(
        player.id,
        payouts.get(player.id)! +
          share +
          (index < sidePot.amount % ordered.length ? 1 : 0),
      ),
    );
  }
  training.results = hand.players.map((player) => {
    const payout = payouts.get(player.id)!;
    player.stack += payout;
    player.allIn = player.stack === 0;
    return {
      playerId: player.id,
      payout,
      net: player.stack - player.startStack,
    };
  });
  hand.actorId = null;
  hand.pending = [];
  hand.status = "complete";
  training.phase = "finished";
  return training;
}
