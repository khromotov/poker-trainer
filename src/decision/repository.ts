import type { ActionType } from "../table/engine";
import type {
  TrainingHand,
  DecisionObservation,
  TournamentStage,
} from "./engine";
import type { Feedback } from "./policy";

export interface DecisionSettings {
  playerCount: number;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  randomDepth: boolean;
  /** Missing in old v1 data; interpreted as early without rewriting history. */
  tournamentStage?: TournamentStage;
}

export interface DecisionRecord {
  id: string;
  timestamp: number;
  observation: DecisionObservation;
  action: ActionType;
  total?: number;
  feedback: Feedback;
}

/** Full private state is local restore data, never an input to the coach. */
export interface DecisionSession {
  version: 1;
  id: string;
  hand: TrainingHand | null;
  decisions: DecisionRecord[];
  settings: DecisionSettings;
  handNumber: number;
  awaitingFeedback: boolean;
}

export interface ArchivedTrainingHand {
  id: string;
  sessionId: string;
  timestamp: number;
  hand: TrainingHand;
  decisions: DecisionRecord[];
}
export type Archive = ArchivedTrainingHand;

export interface DecisionTransfer {
  format: "poker-decisions";
  version: 1;
  history: ArchivedTrainingHand[];
}

const DATABASE = "poker-decisions";
const MAX_IMPORT_LENGTH = 10 * 1024 * 1024;
const ACTIONS = ["fold", "check", "call", "raise", "all-in"];
const POSTINGS = [...ACTIONS, "ante", "small-blind", "big-blind"];
const STREETS = ["preflop", "flop", "turn", "river"];
const TOURNAMENT_STAGES = ["early", "middle", "late", "final"];

function invalid(message = "Неверная структура данных тренажёра"): never {
  throw Error(message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function integer(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    invalid("Неверное числовое значение");
}
function text(value: unknown, maximum = 200): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    invalid("Неверное текстовое значение");
}
function boolean(value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") invalid();
}
function enumeration(
  value: unknown,
  values: string[],
): asserts value is string {
  if (typeof value !== "string" || !values.includes(value))
    invalid("Неизвестное значение");
}
function list(value: unknown, minimum = 0, maximum = 1000): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    invalid("Неверный список");
  return value;
}
function unique(values: unknown[]): void {
  if (new Set(values).size !== values.length)
    invalid("Повторяющиеся идентификаторы или карты");
}
function cards(value: unknown, count?: number): number[] {
  const result = list(value, count ?? 0, count ?? 52);
  result.forEach((card) => integer(card, 0, 51));
  unique(result);
  return result as number[];
}
function safeSum(values: number[]): number {
  const sum = values.reduce((result, value) => result + value, 0);
  integer(sum);
  return sum;
}
function ids(value: unknown, allowed: string[]): string[] {
  const result = list(value, 0, 10);
  if (result.some((id) => typeof id !== "string" || !allowed.includes(id)))
    invalid("Неизвестный игрок");
  unique(result);
  return result as string[];
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("session", { keyPath: "key" });
      request.result.createObjectStore("hands", { keyPath: "id" });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () =>
      reject(request.error ?? Error("Не удалось открыть историю тренировок"));
    request.onblocked = () =>
      reject(Error("Закройте другие вкладки приложения и повторите"));
  });
}

async function transact<T>(
  stores: string[],
  mode: IDBTransactionMode,
  run: (transaction: IDBTransaction) => () => T,
): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction | undefined;
    let result: () => T;
    try {
      transaction = database.transaction(stores, mode);
      result = run(transaction);
    } catch (error) {
      try {
        transaction?.abort();
      } catch {
        /* Already aborted by the database. */
      }
      database.close();
      reject(error);
      return;
    }
    transaction.oncomplete = () => {
      database.close();
      try {
        resolve(result());
      } catch (error) {
        reject(error);
      }
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction!.error ?? Error("Сохранение отменено"));
    };
    transaction.onerror = () => {
      /* Reject only after the transaction has rolled back. */
    };
  });
}

export async function loadSession(): Promise<DecisionSession | null> {
  return transact(["session"], "readonly", (transaction) => {
    const request = transaction.objectStore("session").get("current");
    return () =>
      request.result ? validateSession(request.result.value) : null;
  });
}

export async function saveSession(session: DecisionSession): Promise<void> {
  const value = validateSession(session);
  return transact(["session"], "readwrite", (transaction) => {
    transaction.objectStore("session").put({ key: "current", value });
    return () => undefined;
  });
}

/** Save the final state and its archive together. Retrying cannot create duplicates. */
export async function completeSession(
  session: DecisionSession,
  archive: ArchivedTrainingHand,
): Promise<void> {
  const current = validateSession(session);
  const completed = validateArchive(archive);
  if (
    current.id !== completed.sessionId ||
    !current.hand ||
    current.hand.id !== completed.hand.id ||
    current.hand.phase !== "finished"
  )
    invalid("Архив не соответствует завершённой раздаче");
  if (
    JSON.stringify(current.hand) !== JSON.stringify(completed.hand) ||
    JSON.stringify(current.decisions) !== JSON.stringify(completed.decisions)
  )
    invalid("Архив отличается от сохранённого результата");
  return transact(["session", "hands"], "readwrite", (transaction) => {
    const store = transaction.objectStore("hands");
    const request = store.get(completed.id);
    request.onsuccess = () => {
      if (!request.result) store.add(completed);
      else if (
        request.result.sessionId !== completed.sessionId ||
        JSON.stringify(request.result.hand) !==
          JSON.stringify(completed.hand) ||
        JSON.stringify(request.result.decisions) !==
          JSON.stringify(completed.decisions)
      )
        transaction.abort();
    };
    transaction.objectStore("session").put({ key: "current", value: current });
    return () => undefined;
  });
}

export async function allArchives(): Promise<ArchivedTrainingHand[]> {
  return transact(["hands"], "readonly", (transaction) => {
    const request = transaction.objectStore("hands").getAll();
    return () =>
      (request.result as unknown[])
        .map(validateArchive)
        .sort((a, b) => b.timestamp - a.timestamp);
  });
}

/** Only completed hands are exported. The current private deal stays in local restore data. */
export function exportHistory(history: ArchivedTrainingHand[]): string {
  return JSON.stringify(
    validateTransfer({ format: "poker-decisions", version: 1, history }),
    null,
    2,
  );
}

export function parseHistoryImport(source: string): DecisionTransfer {
  if (source.length > MAX_IMPORT_LENGTH) invalid("Файл больше 10 МБ");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    invalid("Не удалось прочитать JSON");
  }
  return validateTransfer(value);
}

/** Merge archives only; importing never replaces an unfinished training hand. */
export async function importHistory(
  payload: DecisionTransfer,
): Promise<{ added: number; skipped: number }> {
  const value = validateTransfer(payload);
  return transact(["hands"], "readwrite", (transaction) => {
    const store = transaction.objectStore("hands");
    let added = 0;
    let skipped = 0;
    for (const record of value.history) {
      const request = store.get(record.id);
      request.onsuccess = () => {
        if (request.result) skipped += 1;
        else {
          store.add(record);
          added += 1;
        }
      };
    }
    return () => ({ added, skipped });
  });
}

function validateSettings(value: unknown): DecisionSettings {
  const settings = object(value);
  integer(settings.playerCount, 2, 10);
  integer(settings.startingStack, 1);
  integer(settings.smallBlind, 1);
  integer(settings.bigBlind, 1);
  if (settings.smallBlind > settings.bigBlind) invalid("Неверные блайнды");
  boolean(settings.randomDepth);
  if (settings.tournamentStage !== undefined)
    enumeration(settings.tournamentStage, TOURNAMENT_STAGES);
  safeSum(Array(settings.playerCount).fill(settings.startingStack));
  return {
    playerCount: settings.playerCount,
    startingStack: settings.startingStack,
    smallBlind: settings.smallBlind,
    bigBlind: settings.bigBlind,
    randomDepth: settings.randomDepth,
    ...(settings.tournamentStage === undefined
      ? {}
      : { tournamentStage: settings.tournamentStage as TournamentStage }),
  };
}

function validateSession(value: unknown): DecisionSession {
  const session = object(value);
  if (session.version !== 1) invalid("Неизвестная версия тренажёра");
  text(session.id);
  integer(session.handNumber);
  boolean(session.awaitingFeedback);
  const settings = validateSettings(session.settings);
  const hand =
    session.hand === null ? null : validateTrainingHand(session.hand);
  const decisions = validateDecisions(session.decisions, hand);
  // Settings can already describe the next deal while the current deal remains
  // restorable with the exact player count, blinds and stacks it started with.
  if (hand && hand.number !== session.handNumber)
    invalid("Раздача не соответствует сессии");
  if (!hand && (decisions.length || session.awaitingFeedback))
    invalid("Нет раздачи для сохранённых решений");
  if (session.awaitingFeedback && !decisions.length)
    invalid("Нет решения для оценки");
  return {
    version: 1,
    id: session.id,
    hand,
    decisions,
    settings,
    handNumber: session.handNumber,
    awaitingFeedback: session.awaitingFeedback,
  };
}

function validateArchive(value: unknown): ArchivedTrainingHand {
  const archive = object(value);
  text(archive.id);
  text(archive.sessionId);
  integer(archive.timestamp);
  const hand = validateTrainingHand(archive.hand);
  if (hand.phase !== "finished")
    invalid("Экспортировать можно только завершённые раздачи");
  const decisions = validateDecisions(archive.decisions, hand);
  return {
    id: archive.id,
    sessionId: archive.sessionId,
    timestamp: archive.timestamp,
    hand,
    decisions,
  };
}

function validateTransfer(value: unknown): DecisionTransfer {
  const payload = object(value);
  if (payload.format !== "poker-decisions" || payload.version !== 1)
    invalid("Неверный формат или версия файла");
  const history = list(payload.history, 0, 20000).map(validateArchive);
  unique(history.map((archive) => archive.id));
  return { format: "poker-decisions", version: 1, history };
}

function validatePlayers(value: unknown): Record<string, unknown>[] {
  const players = list(value, 2, 10).map(object);
  for (const player of players) {
    text(player.id);
    text(player.name, 100);
    integer(player.seat, 0, 9);
    integer(player.stack);
    integer(player.reentries);
    boolean(player.active);
  }
  unique(players.map((player) => player.id));
  unique(players.map((player) => player.seat));
  safeSum(players.map((player) => player.stack as number));
  return players;
}

function validateChipHand(value: unknown): {
  hand: Record<string, unknown>;
  players: Record<string, unknown>[];
  playerIds: string[];
} {
  const hand = object(value);
  text(hand.id);
  text(hand.heroId);
  integer(hand.number, 1);
  integer(hand.dealerSeat, 0, 9);
  integer(hand.currentBet);
  integer(hand.minRaise, 1);
  integer(hand.smallBlind, 1);
  integer(hand.bigBlind, 1);
  integer(hand.ante, 1);
  if (hand.smallBlind > hand.bigBlind || hand.ante !== hand.bigBlind)
    invalid("Неверные блайнды раздачи");
  enumeration(hand.status, ["playing", "settlement", "complete"]);
  const players = list(hand.players, 2, 10).map(object);
  for (const player of players) {
    text(player.id);
    text(player.name, 100);
    integer(player.seat, 0, 9);
    integer(player.startStack, 1);
    for (const field of [
      "stack",
      "committed",
      "streetCommitted",
      "antePaid",
      "returned",
    ])
      integer(player[field]);
    boolean(player.folded);
    boolean(player.allIn);
    if (
      (player.committed as number) > player.startStack ||
      (player.streetCommitted as number) > (player.committed as number) ||
      (player.antePaid as number) > hand.ante ||
      (player.antePaid as number) > (player.committed as number) ||
      (player.returned as number) > player.startStack
    )
      invalid("Неверный вклад игрока");
    if (
      hand.status !== "complete" &&
      (player.stack as number) + (player.committed as number) !==
        player.startStack
    )
      invalid("Нарушен баланс фишек");
    if (hand.status !== "complete" && player.allIn !== (player.stack === 0))
      invalid("Неверный статус олл-ина");
  }
  const playerIds = players.map((player) => player.id as string);
  unique(playerIds);
  unique(players.map((player) => player.seat));
  if (
    !playerIds.includes(hand.heroId) ||
    !players.some((player) => player.seat === hand.dealerSeat)
  )
    invalid("Неизвестный Hero или дилер");
  const startTotal = safeSum(
    players.map((player) => player.startStack as number),
  );
  const stackTotal = safeSum(players.map((player) => player.stack as number));
  safeSum(players.map((player) => player.committed as number));
  if (hand.status === "complete" && stackTotal !== startTotal)
    invalid("Нарушен баланс распределённого банка");
  const pending = ids(hand.pending, playerIds);
  ids(hand.actedSinceFullRaise, playerIds);
  if (
    pending.some((id) => {
      const player = players.find((p) => p.id === id)!;
      return player.folded || player.allIn;
    })
  )
    invalid("Неверная очередь действий");
  if (hand.status === "playing") {
    if (typeof hand.actorId !== "string" || hand.actorId !== pending[0])
      invalid("Неверный текущий игрок");
  } else if (hand.actorId !== null || pending.length)
    invalid("Торги завершены, но очередь не пуста");
  for (const [id, amount] of Object.entries(object(hand.lastActionBet))) {
    if (!playerIds.includes(id)) invalid("Неизвестный игрок");
    integer(amount);
  }
  for (const action of list(hand.actions, 0, 1000).map(object)) {
    if (
      typeof action.playerId !== "string" ||
      !playerIds.includes(action.playerId)
    )
      invalid("Неизвестный игрок в истории");
    enumeration(action.type, POSTINGS);
    integer(action.total);
    integer(action.paid);
    if (action.paid > action.total) invalid("Неверная ставка в истории");
  }
  return { hand, players, playerIds };
}

function validateTrainingHand(value: unknown): TrainingHand {
  const training = object(value);
  if (training.tournamentStage !== undefined)
    enumeration(training.tournamentStage, TOURNAMENT_STAGES);
  text(training.id);
  integer(training.seed, -Number.MAX_SAFE_INTEGER);
  integer(training.number, 1);
  text(training.heroId);
  enumeration(training.street, STREETS);
  enumeration(training.phase, ["playing", "finished"]);
  const { hand, players, playerIds } = validateChipHand(training.hand);
  if (training.heroId !== hand.heroId || training.number !== hand.number)
    invalid("Неверная идентичность раздачи");
  const initialPlayers = validatePlayers(training.initialPlayers);
  if (
    initialPlayers.length !== players.length ||
    initialPlayers.some(
      (player) =>
        !players.some(
          (p) =>
            p.id === player.id &&
            p.startStack === player.stack &&
            p.seat === player.seat,
        ),
    )
  )
    invalid("Неверные стартовые стеки");
  const holeCards = object(training.holeCards);
  const profiles = object(training.profiles);
  if (
    Object.keys(holeCards).length !== playerIds.length ||
    Object.keys(profiles).length !== playerIds.length
  )
    invalid("Карты и профили не соответствуют игрокам");
  const dealt: number[] = [];
  for (const id of playerIds) {
    dealt.push(...cards(holeCards[id], 2));
    enumeration(profiles[id], ["balanced", "tight", "loose"]);
  }
  const deck = cards(training.deck, 52 - dealt.length);
  unique([...dealt, ...deck]);
  const board = cards(training.board);
  const boardSize = (
    { preflop: 0, flop: 3, turn: 4, river: 5 } as Record<string, number>
  )[training.street];
  if (
    board.length !== boardSize ||
    board.some((card, index) => card !== deck[index])
  )
    invalid("Неверные общие карты");
  for (const log of list(training.logs, 0, 1000).map(object)) {
    enumeration(log.street, STREETS);
    enumeration(log.action, POSTINGS);
    if (typeof log.actorId !== "string" || !playerIds.includes(log.actorId))
      invalid("Неизвестный игрок в журнале");
    integer(log.total);
    integer(log.paid);
    if (log.paid > log.total) invalid("Неверная ставка в журнале");
    if (log.reason !== undefined) text(log.reason, 2000);
  }
  if (training.phase === "finished") {
    if (hand.status !== "complete") invalid("Раздача не распределена");
    const results = list(training.results, players.length, players.length).map(
      object,
    );
    unique(results.map((result) => result.playerId));
    for (const result of results) {
      if (
        typeof result.playerId !== "string" ||
        !playerIds.includes(result.playerId)
      )
        invalid("Неизвестный игрок в результате");
      integer(result.payout);
      integer(result.net, -Number.MAX_SAFE_INTEGER);
      const player = players.find((p) => p.id === result.playerId)!;
      if (
        result.net !==
          (player.stack as number) - (player.startStack as number) ||
        (player.stack as number) !==
          (player.startStack as number) -
            (player.committed as number) +
            result.payout
      )
        invalid("Неверный итог раздачи");
    }
  } else if (hand.status === "complete" || training.results !== undefined)
    invalid("Незавершённая раздача содержит результат");
  return structuredClone(training) as unknown as TrainingHand;
}

// Public observation and decision validation is deliberately separate from the
// private restorable deal: the coach and exported decision logs cannot gain
// access to an opponent's cards, future runout, or private bot explanations.
function validateDecisions(
  value: unknown,
  training: TrainingHand | null,
): DecisionRecord[] {
  const records = list(value, 0, 1000).map((value) => {
    const record = object(value);
    text(record.id);
    integer(record.timestamp);
    enumeration(record.action, ACTIONS);
    if (record.total !== undefined) integer(record.total);
    const feedback = object(record.feedback);
    enumeration(feedback.verdict, [
      "good",
      "reasonable",
      "risky",
      "mistake",
      "uncertain",
    ]);
    text(feedback.title, 300);
    text(feedback.reason, 4000);
    const observation = validateObservation(record.observation, training);
    if (!observation.legalActions.includes(record.action as ActionType))
      invalid("Решение недоступно в сохранённой ситуации");
    if (
      record.action === "raise" &&
      (record.total === undefined ||
        record.total <
          Math.min(observation.minRaiseTo, observation.maxRaiseTo) ||
        record.total > observation.maxRaiseTo)
    )
      invalid("Неверная полная ставка решения");
    const played = training!.logs[observation.history.length];
    if (
      !played ||
      played.actorId !== observation.actorId ||
      played.action !== record.action ||
      (record.total !== undefined && record.total !== played.total)
    )
      invalid("Сохранённое решение отсутствует в журнале раздачи");
    return {
      id: record.id,
      timestamp: record.timestamp,
      observation,
      action: record.action as ActionType,
      ...(record.total === undefined ? {} : { total: record.total }),
      feedback: {
        verdict: feedback.verdict,
        title: feedback.title,
        reason: feedback.reason,
      } as Feedback,
    };
  });
  unique(records.map((record) => record.id));
  if (
    records.some(
      (record, index) =>
        index > 0 &&
        record.observation.history.length <=
          records[index - 1].observation.history.length,
    )
  )
    invalid("Неверный порядок решений");
  return records;
}

function validateObservation(
  value: unknown,
  training: TrainingHand | null,
): DecisionObservation {
  const observation = object(value);
  if (!training) invalid("Решение без раздачи");
  if (observation.tournamentStage !== undefined)
    enumeration(observation.tournamentStage, TOURNAMENT_STAGES);
  if (
    (observation.tournamentStage ?? "early") !==
    (training.tournamentStage ?? "early")
  )
    invalid("Стадия решения не совпадает с раздачей");
  enumeration(observation.street, STREETS);
  text(observation.actorId);
  if (observation.actorId !== training.heroId)
    invalid("В истории должно быть решение героя");
  const heroCards = cards(observation.heroCards, 2);
  if (
    heroCards.some(
      (card, index) => card !== training.holeCards[training.heroId][index],
    )
  )
    invalid("Карты героя не соответствуют раздаче");
  const board = cards(observation.board);
  const boardSize = (
    { preflop: 0, flop: 3, turn: 4, river: 5 } as Record<string, number>
  )[observation.street];
  if (
    board.length !== boardSize ||
    board.length > training.board.length ||
    board.some((card, index) => card !== training.board[index])
  )
    invalid("В решении есть недоступные общие карты");
  const playerIds = training.hand.players.map((player) => player.id);
  const players = list(
    observation.players,
    playerIds.length,
    playerIds.length,
  ).map((value) => {
    const player = object(value);
    text(player.id);
    text(player.name, 100);
    integer(player.seat, 0, 9);
    integer(player.startStack, 1);
    for (const field of ["stack", "committed", "streetCommitted", "antePaid"])
      integer(player[field]);
    boolean(player.folded);
    boolean(player.allIn);
    enumeration(player.profile, ["balanced", "tight", "loose"]);
    const initial = training.initialPlayers.find(
      (candidate) => candidate.id === player.id,
    );
    if (
      !initial ||
      initial.seat !== player.seat ||
      initial.stack !== player.startStack ||
      (player.stack as number) + (player.committed as number) !==
        initial.stack ||
      (player.streetCommitted as number) + (player.antePaid as number) >
        (player.committed as number) ||
      player.allIn !== (player.stack === 0)
    )
      invalid("Неверный игрок в сохранённой ситуации");
    return {
      id: player.id,
      name: player.name,
      seat: player.seat,
      startStack: player.startStack,
      stack: player.stack as number,
      committed: player.committed as number,
      streetCommitted: player.streetCommitted as number,
      antePaid: player.antePaid as number,
      folded: player.folded,
      allIn: player.allIn,
      profile:
        player.profile as DecisionObservation["players"][number]["profile"],
    };
  });
  unique(players.map((player) => player.id));
  unique(players.map((player) => player.seat));
  const history = list(observation.history, 0, 1000).map((value, index) => {
    const log = object(value);
    enumeration(log.street, STREETS);
    enumeration(log.action, POSTINGS);
    text(log.actorId);
    if (
      STREETS.indexOf(log.street) >
      STREETS.indexOf(observation.street as string)
    )
      invalid("В решении есть будущие действия");
    if (!playerIds.includes(log.actorId))
      invalid("Неизвестный игрок в наблюдении");
    integer(log.total);
    integer(log.paid);
    const actual = training.logs[index];
    if (
      !actual ||
      actual.actorId !== log.actorId ||
      actual.action !== log.action ||
      actual.street !== log.street ||
      actual.total !== log.total ||
      actual.paid !== log.paid
    )
      invalid("История решения не совпадает с раздачей");
    // Intentionally omit any supplied private reason or other unknown properties.
    return {
      street: log.street as DecisionObservation["street"],
      actorId: log.actorId,
      action: log.action as DecisionObservation["history"][number]["action"],
      total: log.total,
      paid: log.paid,
    };
  });
  integer(observation.dealerSeat, 0, 9);
  for (const field of [
    "bigBlind",
    "smallBlind",
    "ante",
    "minRaise",
    "minRaiseTo",
  ])
    integer(observation[field], 1);
  for (const field of ["currentBet", "pot", "toCall", "maxRaiseTo"])
    integer(observation[field]);
  boolean(observation.canRaise);
  if (
    observation.dealerSeat !== training.hand.dealerSeat ||
    observation.bigBlind !== training.hand.bigBlind ||
    observation.smallBlind !== training.hand.smallBlind ||
    observation.ante !== training.hand.ante
  )
    invalid("Блайнды решения не совпадают с раздачей");
  const hero = players.find((player) => player.id === observation.actorId)!;
  if (
    hero.folded ||
    hero.allIn ||
    observation.pot !== safeSum(players.map((player) => player.committed)) ||
    observation.toCall !==
      Math.min(
        Math.max(0, (observation.currentBet as number) - hero.streetCommitted),
        hero.stack,
      ) ||
    observation.maxRaiseTo !== hero.streetCommitted + hero.stack ||
    observation.minRaiseTo !==
      (observation.currentBet as number) + (observation.minRaise as number)
  )
    invalid("Неверные ставки сохранённого решения");
  const legalActions = list(observation.legalActions, 1, 5);
  legalActions.forEach((action) => enumeration(action, ACTIONS));
  unique(legalActions);
  if (
    legalActions.includes("check") !== (observation.toCall === 0) ||
    legalActions.includes("call") !== observation.toCall > 0 ||
    legalActions.includes("fold") !== observation.toCall > 0 ||
    legalActions.includes("raise") !== observation.canRaise ||
    legalActions.includes("all-in") !==
      (observation.canRaise ||
        (observation.toCall > 0 && hero.stack <= observation.toCall))
  )
    invalid("Неверные доступные действия");
  return {
    street: observation.street as DecisionObservation["street"],
    ...(observation.tournamentStage === undefined
      ? {}
      : { tournamentStage: observation.tournamentStage as TournamentStage }),
    board,
    heroCards,
    actorId: observation.actorId,
    players,
    history,
    dealerSeat: observation.dealerSeat,
    bigBlind: observation.bigBlind as number,
    smallBlind: observation.smallBlind as number,
    ante: observation.ante as number,
    currentBet: observation.currentBet as number,
    minRaise: observation.minRaise as number,
    canRaise: observation.canRaise,
    pot: observation.pot as number,
    toCall: observation.toCall as number,
    minRaiseTo: observation.minRaiseTo as number,
    maxRaiseTo: observation.maxRaiseTo as number,
    legalActions: legalActions as ActionType[],
  };
}
