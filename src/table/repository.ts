import type { Hand, Player, TableSettings } from './engine';

/** The table has its own database; importing it never touches equity practice. */
export interface TableSession {
  version: 1;
  id: string;
  settings: TableSettings;
  players: Player[];
  heroId: string;
  dealerSeat: number;
  handNumber: number;
  hand: Hand | null;
}

export interface ArchivedHand {
  id: string;
  sessionId: string;
  timestamp: number;
  hand: Hand;
  settings: TableSettings;
  startingPlayers: Player[];
}

export interface TableTransfer {
  format: 'poker-table';
  version: 1;
  session: TableSession;
  history: ArchivedHand[];
}

const DATABASE = 'poker-table';
const MAX_IMPORT_LENGTH = 10 * 1024 * 1024;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('session', { keyPath: 'key' });
      database.createObjectStore('hands', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? Error('Не удалось открыть историю стола'));
    request.onblocked = () => reject(Error('Закройте другие вкладки приложения и повторите'));
  });
}

async function transact<T>(
  stores: string[],
  mode: IDBTransactionMode,
  run: (transaction: IDBTransaction) => () => T,
): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let result: () => T;
    try {
      transaction = database.transaction(stores, mode);
      result = run(transaction);
    } catch (error) {
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
      reject(transaction.error ?? Error('Сохранение отменено'));
    };
    transaction.onerror = () => {
      // An error aborts the entire transaction; reject from onabort, after rollback.
    };
  });
}

export async function loadSession(): Promise<TableSession | null> {
  return transact(['session'], 'readonly', transaction => {
    const request = transaction.objectStore('session').get('current');
    return () => {
      if (!request.result) return null;
      validateSession(request.result.value);
      return request.result.value as TableSession;
    };
  });
}

export async function saveSession(session: TableSession): Promise<void> {
  validateSession(session);
  return transact(['session'], 'readwrite', transaction => {
    transaction.objectStore('session').put({ key: 'current', value: session });
    return () => undefined;
  });
}

export async function archiveHand(record: ArchivedHand): Promise<void> {
  validateArchive(record);
  return transact(['hands'], 'readwrite', transaction => {
    transaction.objectStore('hands').put(record);
    return () => undefined;
  });
}

/** Commit settlement and its archive together, so a reload cannot pay twice. */
export async function saveSessionAndArchive(session: TableSession, record: ArchivedHand): Promise<void> {
  validateSession(session);
  validateArchive(record);
  if (record.sessionId !== session.id) invalid('Архив относится к другому столу');
  return transact(['session', 'hands'], 'readwrite', transaction => {
    transaction.objectStore('hands').put(record);
    transaction.objectStore('session').put({ key: 'current', value: session });
    return () => undefined;
  });
}

export async function allHands(): Promise<ArchivedHand[]> {
  return transact(['hands'], 'readonly', transaction => {
    const request = transaction.objectStore('hands').getAll();
    return () => (request.result as ArchivedHand[]).sort((a, b) => b.timestamp - a.timestamp);
  });
}

export function exportTable(session: TableSession, history: ArchivedHand[]): string {
  const payload: TableTransfer = { format: 'poker-table', version: 1, session, history };
  validateTransfer(payload);
  return JSON.stringify(payload, null, 2);
}

export function parseTableImport(text: string): TableTransfer {
  if (text.length > MAX_IMPORT_LENGTH) invalid('Файл больше 10 МБ');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return invalid('Не удалось прочитать JSON');
  }
  validateTransfer(payload);
  return payload as TableTransfer;
}

/** Replace the active session and add missing archive IDs in one transaction. */
export async function importTable(payload: { session: TableSession; history: ArchivedHand[] }): Promise<{ added: number; skipped: number }> {
  validateTransfer({ ...payload, format: 'poker-table', version: 1 });
  return transact(['session', 'hands'], 'readwrite', transaction => {
    const archive = transaction.objectStore('hands');
    let added = 0;
    let skipped = 0;
    for (const record of payload.history) {
      const request = archive.get(record.id);
      request.onsuccess = () => {
        if (request.result) {
          skipped += 1;
        } else {
          archive.add(record);
          added += 1;
        }
      };
    }
    transaction.objectStore('session').put({ key: 'current', value: payload.session });
    return () => ({ added, skipped });
  });
}

function invalid(message = 'Неверная структура данных стола'): never {
  throw Error(message);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid('Неверное числовое значение');
}

function string(value: unknown, maximum = 160): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) invalid('Неверное текстовое значение');
}

function boolean(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') invalid();
}

function unique(values: unknown[]): void {
  if (new Set(values).size !== values.length) invalid('Повторяющиеся игроки или места');
}

function validateTransfer(value: unknown): void {
  const payload = object(value);
  if (payload.format !== 'poker-table' || payload.version !== 1) invalid('Неверный формат или версия файла стола');
  validateSession(payload.session);
  if (!Array.isArray(payload.history) || payload.history.length > 20000) invalid('Неверная история раздач');
  payload.history.forEach(validateArchive);
  unique(payload.history.map(record => object(record).id));
}

function validateSession(value: unknown): void {
  const session = object(value);
  if (session.version !== 1) invalid('Неизвестная версия стола');
  string(session.id);
  validateSettings(session.settings);
  validatePlayers(session.players);
  string(session.heroId);
  if (!(session.players as Player[]).some(player => player.id === session.heroId)) invalid('Не найдено ваше место');
  integer(session.dealerSeat, 0, 9);
  integer(session.handNumber, 0);
  if (session.hand !== null) validateHand(session.hand);
}

function validateArchive(value: unknown): void {
  const record = object(value);
  string(record.id);
  string(record.sessionId);
  integer(record.timestamp);
  validateSettings(record.settings);
  validatePlayers(record.startingPlayers);
  validateHand(record.hand);
}

// Engine-dependent validators are below, kept explicit so malformed imports
// cannot feed invalid chip counts or actions into the table state machine.
function validateSettings(value: unknown): void {
  const settings = object(value);
  integer(settings.startingStack, 1);
  integer(settings.smallBlind, 1);
  integer(settings.bigBlind, 1);
  if (settings.smallBlind > settings.bigBlind) invalid('Малый блайнд больше большого');
  boolean(settings.reentry);
  if (settings.blindLevels !== undefined) {
    if (!Array.isArray(settings.blindLevels) || settings.blindLevels.length > 1000) invalid('Неверная таблица блайндов');
    for (const value of settings.blindLevels) {
      const level = object(value);
      integer(level.smallBlind, 1);
      integer(level.bigBlind, 1);
      if (level.smallBlind > level.bigBlind) invalid('Неверные блайнды уровня');
    }
  }
}

function validatePlayers(value: unknown): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) invalid('За столом должно быть от 1 до 10 мест');
  const players = value.map(object);
  for (const player of players) {
    string(player.id);
    string(player.name, 100);
    integer(player.stack);
    integer(player.seat, 0, 9);
    boolean(player.active);
    integer(player.reentries);
  }
  unique(players.map(player => player.id));
  unique(players.map(player => player.seat));
  safeSum(players.map(player => player.stack as number));
}

function safeSum(values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  integer(total);
  return total;
}

function validateHand(value: unknown): void {
  const hand = object(value);
  string(hand.id);
  string(hand.heroId);
  integer(hand.number, 1);
  integer(hand.dealerSeat, 0, 9);
  integer(hand.currentBet, 0);
  integer(hand.minRaise, 1);
  integer(hand.smallBlind, 1);
  integer(hand.bigBlind, 1);
  integer(hand.ante, 1);
  if (hand.smallBlind > hand.bigBlind || hand.ante !== hand.bigBlind) invalid('Неверные блайнды раздачи');
  if (!['playing', 'settlement', 'complete'].includes(hand.status as string)) invalid('Неизвестное состояние раздачи');
  if (!Array.isArray(hand.players) || hand.players.length < 2 || hand.players.length > 10) invalid('Неверные участники раздачи');
  const players = hand.players.map(object);
  for (const player of players) {
    string(player.id);
    string(player.name, 100);
    integer(player.seat, 0, 9);
    integer(player.startStack, 1);
    integer(player.stack);
    integer(player.committed);
    integer(player.streetCommitted);
    integer(player.antePaid);
    integer(player.returned);
    boolean(player.folded);
    boolean(player.allIn);
    if (player.committed > player.startStack || player.antePaid > hand.ante || player.returned > player.startStack || player.committed !== player.streetCommitted + player.antePaid) invalid('Неверный вклад игрока');
    if (player.allIn !== (player.stack === 0)) invalid('Неверный статус олл-ина');
    if (hand.status !== 'complete' && player.stack + player.committed !== player.startStack) invalid('Нарушен баланс фишек');
  }
  const ids = players.map(player => player.id as string);
  unique(ids);
  unique(players.map(player => player.seat));
  if (!ids.includes(hand.heroId) || !players.some(player => player.seat === hand.dealerSeat)) invalid('Не найдено место игрока или дилера');
  const startingTotal = safeSum(players.map(player => player.startStack as number));
  safeSum(players.map(player => player.committed as number));
  const finalTotal = safeSum(players.map(player => player.stack as number));
  if (hand.status === 'complete' && finalTotal !== startingTotal) invalid('Нарушен баланс распределённого банка');
  for (const field of ['pending', 'actedSinceFullRaise']) {
    const list = hand[field];
    if (!Array.isArray(list) || list.length > 10 || list.some(id => typeof id !== 'string' || !ids.includes(id))) invalid('Неизвестный игрок в очереди');
    unique(list);
  }
  const pending = hand.pending as string[];
  if (pending.some(id => { const player = players.find(candidate => candidate.id === id)!; return player.folded || player.allIn; })) invalid('Неверная очередь действий');
  if (hand.status === 'playing') {
    if (typeof hand.actorId !== 'string' || hand.actorId !== pending[0]) invalid('Неверный текущий игрок');
  } else if (hand.actorId !== null || pending.length) invalid('Раздача завершена, но очередь не пуста');
  const bets = object(hand.lastActionBet);
  for (const [id, amount] of Object.entries(bets)) {
    if (!ids.includes(id)) invalid('Неизвестный игрок в ставках');
    integer(amount);
  }
  if (!Array.isArray(hand.actions) || hand.actions.length > 1000) invalid('Неверная история действий');
  for (const value of hand.actions) {
    const action = object(value);
    if (typeof action.playerId !== 'string' || !ids.includes(action.playerId)) invalid('Неизвестный игрок в истории');
    if (!['fold', 'check', 'call', 'raise', 'all-in', 'small-blind', 'big-blind', 'ante'].includes(action.type as string)) invalid('Неизвестное действие');
    integer(action.total);
    integer(action.paid);
    const player = players.find(candidate => candidate.id === action.playerId)!;
    if (action.total > (player.startStack as number) || action.paid > action.total) invalid('Неверная ставка в истории');
  }
}
