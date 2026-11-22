/** Pure chip accounting. Chips are integral. A short BB posts the BB ante first.
 * Ante is dead main-pot money; it never counts towards the live amount to call.
 */
export interface BlindLevel { smallBlind: number; bigBlind: number }
export interface TableSettings {
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  reentry: boolean;
  blindLevels?: BlindLevel[];
}
export interface Player {
  id: string;
  name: string;
  stack: number;
  seat: number;
  active: boolean;
  reentries: number;
}
export interface HandPlayer {
  id: string;
  seat: number;
  name: string;
  startStack: number;
  stack: number;
  committed: number;
  streetCommitted: number;
  antePaid: number;
  returned: number;
  folded: boolean;
  allIn: boolean;
}
export type ActionType = 'fold' | 'check' | 'call' | 'raise' | 'all-in';
export interface HandAction {
  playerId: string;
  type: ActionType | 'small-blind' | 'big-blind' | 'ante';
  total: number;
  paid: number;
}
export interface Hand {
  id: string;
  number: number;
  dealerSeat: number;
  heroId: string;
  players: HandPlayer[];
  actorId: string | null;
  currentBet: number;
  minRaise: number;
  actedSinceFullRaise: string[];
  lastActionBet: Record<string, number>;
  pending: string[];
  actions: HandAction[];
  status: 'playing' | 'settlement' | 'complete';
  bigBlind: number;
  smallBlind: number;
  ante: number;
}
export interface SidePot { amount: number; eligible: string[] }

const integer = (value: number, label: string, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label}: нужно целое число от ${minimum}.`);
};
const clone = (hand: Hand): Hand => ({
  ...hand, players: hand.players.map(player => ({ ...player })),
  actions: hand.actions.map(action => ({ ...action })),
  pending: [...hand.pending], actedSinceFullRaise: [...hand.actedSinceFullRaise],
  lastActionBet: { ...hand.lastActionBet },
});
const clockwise = <T extends { seat: number }>(players: T[], seat: number): T[] =>
  [...players].sort((a, b) => ((a.seat - seat + 10) % 10 || 10) - ((b.seat - seat + 10) % 10 || 10));

export function validateSettings(settings: TableSettings): void {
  integer(settings.startingStack, 'Стартовый стек', 1);
  integer(settings.smallBlind, 'Малый блайнд', 1);
  integer(settings.bigBlind, 'Большой блайнд', 1);
  if (settings.smallBlind > settings.bigBlind) throw new Error('Малый блайнд не может превышать большой.');
  if (typeof settings.reentry !== 'boolean') throw new Error('Укажите, разрешено ли реэнтри.');
  for (const level of settings.blindLevels ?? []) {
    integer(level.smallBlind, 'Малый блайнд уровня', 1);
    integer(level.bigBlind, 'Большой блайнд уровня', 1);
    if (level.smallBlind > level.bigBlind) throw new Error('Неверные блайнды уровня.');
  }
}

export function createPlayers(count = 10, startingStack = 30_000): Player[] {
  integer(count, 'Число игроков', 2);
  if (count > 10) throw new Error('За столом может быть не больше 10 игроков.');
  integer(startingStack, 'Стартовый стек', 1);
  if (!Number.isSafeInteger(startingStack * count)) throw new Error('Сумма фишек слишком велика для точного учёта.');
  return Array.from({ length: count }, (_, seat) => ({
    id: `player-${seat + 1}`, name: `Игрок ${seat + 1}`, stack: startingStack, seat, active: true, reentries: 0,
  }));
}

export function nextDealer(players: Player[], dealerSeat: number): number {
  const eligible = players.filter(player => player.active && player.stack > 0);
  if (!eligible.length) throw new Error('Нет игроков со стеком.');
  return clockwise(eligible, dealerSeat)[0].seat;
}

/** Refunded chips are removed from the pot before winners are chosen. */
function returnUncalled(hand: Hand): void {
  const sorted = [...hand.players].sort((a, b) => b.streetCommitted - a.streetCommitted);
  const highest = sorted[0];
  const excess = highest.streetCommitted - (sorted[1]?.streetCommitted ?? 0);
  if (excess <= 0) return;
  highest.streetCommitted -= excess;
  highest.committed -= excess;
  highest.stack += excess;
  highest.returned += excess;
  highest.allIn = highest.stack === 0;
}

function advance(hand: Hand, afterSeat: number): Hand {
  const remaining = hand.players.filter(player => !player.folded);
  const actionable = remaining.filter(player => !player.allIn);
  hand.pending = hand.pending.filter(id => actionable.some(player => player.id === id));
  if (remaining.length <= 1 || actionable.length === 0) hand.pending = [];
  // With one player able to act there is no option to bet into an empty side pot.
  if (actionable.length === 1) {
    const player = actionable[0];
    const otherBet = Math.max(0, ...remaining.filter(other => other.id !== player.id).map(other => other.streetCommitted));
    hand.pending = player.streetCommitted < otherBet ? [player.id] : [];
  }
  if (!hand.pending.length) {
    returnUncalled(hand);
    hand.status = 'settlement';
    hand.actorId = null;
    return hand;
  }
  hand.pending = clockwise(hand.players, afterSeat).filter(player => hand.pending.includes(player.id)).map(player => player.id);
  hand.actorId = hand.pending[0];
  return hand;
}

export function startHand(players: Player[], settings: TableSettings, dealerSeat: number, heroId: string, number = 1): Hand {
  validateSettings(settings);
  integer(number, 'Номер раздачи', 1);
  integer(dealerSeat, 'Место дилера');
  if (players.length > 10 || new Set(players.map(player => player.id)).size !== players.length || new Set(players.map(player => player.seat)).size !== players.length) {
    throw new Error('Места и идентификаторы игроков должны быть уникальными; максимум 10 игроков.');
  }
  for (const player of players) {
    integer(player.stack, 'Стек'); integer(player.seat, 'Место');
    if (player.seat > 9) throw new Error('Места нумеруются от 0 до 9.');
  }
  if (!Number.isSafeInteger(players.reduce((sum, player) => sum + player.stack, 0))) throw new Error('Сумма фишек слишком велика для точного учёта.');
  const seated = players.filter(player => player.active && player.stack > 0);
  if (seated.length < 2) throw new Error('Для раздачи нужны хотя бы два игрока со стеком.');
  if (!seated.some(player => player.seat === dealerSeat)) throw new Error('Дилер должен быть за столом.');
  if (!seated.some(player => player.id === heroId)) throw new Error('Выберите своё место за столом.');
  const order = clockwise(seated, dealerSeat);
  const sb = seated.length === 2 ? seated.find(player => player.seat === dealerSeat)! : order[0];
  const bb = seated.length === 2 ? order[0] : order[1];
  const hand: Hand = {
    id: `hand-${number}`, number, dealerSeat, heroId,
    players: seated.map(player => ({ id: player.id, seat: player.seat, name: player.name,
      startStack: player.stack, stack: player.stack, committed: 0, streetCommitted: 0,
      antePaid: 0, returned: 0, folded: false, allIn: false })),
    actorId: null, currentBet: settings.bigBlind, minRaise: settings.bigBlind,
    actedSinceFullRaise: [], lastActionBet: {}, pending: [], actions: [], status: 'playing',
    bigBlind: settings.bigBlind, smallBlind: settings.smallBlind, ante: settings.bigBlind,
  };
  const post = (id: string, type: HandAction['type'], amount: number, ante = false) => {
    const player = hand.players.find(candidate => candidate.id === id)!;
    const paid = Math.min(amount, player.stack);
    player.stack -= paid; player.committed += paid;
    if (ante) player.antePaid += paid; else player.streetCommitted += paid;
    player.allIn = player.stack === 0;
    hand.actions.push({ playerId: id, type, total: ante ? paid : player.streetCommitted, paid });
  };
  post(bb.id, 'ante', settings.bigBlind, true);
  post(sb.id, 'small-blind', settings.smallBlind);
  post(bb.id, 'big-blind', settings.bigBlind);
  hand.pending = hand.players.filter(player => !player.allIn).map(player => player.id);
  return advance(hand, bb.seat);
}

export function canRaise(hand: Hand): boolean {
  if (hand.status !== 'playing' || !hand.actorId) return false;
  const player = hand.players.find(candidate => candidate.id === hand.actorId)!;
  return player.stack + player.streetCommitted > hand.currentBet &&
    hand.players.some(other => other.id !== player.id && !other.folded && !other.allIn) &&
    (!hand.actedSinceFullRaise.includes(player.id) || hand.currentBet - (hand.lastActionBet[player.id] ?? 0) >= hand.minRaise);
}

/** `total` is the player's live total for this street, never an added amount. */
export function act(input: Hand, type: ActionType, total?: number): Hand {
  if (input.status !== 'playing' || !input.actorId) throw new Error('Сейчас нет игрока, ожидающего действия.');
  if (!['fold', 'check', 'call', 'raise', 'all-in'].includes(type)) throw new Error('Неизвестное действие.');
  const hand = clone(input);
  const player = hand.players.find(candidate => candidate.id === hand.actorId)!;
  const owed = Math.max(0, hand.currentBet - player.streetCommitted);
  let target = player.streetCommitted;
  if (type === 'fold') player.folded = true;
  if (type === 'check' && owed > 0) throw new Error('Для чека нужно сначала уравнять ставку.');
  if (type === 'call') {
    if (owed === 0) throw new Error('Ставка уже уравнена: доступен чек.');
    target += Math.min(owed, player.stack);
  }
  if (type === 'raise') {
    integer(total!, 'Итоговая ставка', 1);
    if (total! <= hand.currentBet) throw new Error('Повышение должно превышать текущую ставку.');
    target = total!;
  }
  if (type === 'all-in') target += player.stack;
  if (target > player.streetCommitted + player.stack) throw new Error('Ставка превышает стек.');
  if (target > hand.currentBet) {
    if (!canRaise(input)) throw new Error('Торги не открыты для нового повышения: доступен колл или фолд.');
    const raise = target - hand.currentBet;
    if (raise < hand.minRaise && target !== player.streetCommitted + player.stack) throw new Error(`Минимальная полная ставка: ${hand.currentBet + hand.minRaise}.`);
    if (raise >= hand.minRaise) {
      hand.minRaise = raise;
      hand.actedSinceFullRaise = [];
      hand.pending = hand.players.filter(other => other.id !== player.id && !other.folded && !other.allIn).map(other => other.id);
    } else {
      const pending = new Set(hand.pending);
      hand.players.filter(other => other.id !== player.id && !other.folded && !other.allIn && other.streetCommitted < target).forEach(other => pending.add(other.id));
      hand.pending = [...pending];
    }
    hand.currentBet = target;
  }
  const paid = target - player.streetCommitted;
  player.stack -= paid; player.committed += paid; player.streetCommitted = target;
  player.allIn = player.stack === 0;
  hand.actions.push({ playerId: player.id, type, total: target, paid });
  hand.lastActionBet[player.id] = hand.currentBet;
  if (!hand.actedSinceFullRaise.includes(player.id)) hand.actedSinceFullRaise.push(player.id);
  hand.pending = hand.pending.filter(id => id !== player.id);
  return advance(hand, player.seat);
}

export function pot(hand: Hand): number { return hand.players.reduce((sum, player) => sum + player.committed, 0); }

/** Live wagers create matching layers. All ante chips belong to the first layer. */
export function sidePots(hand: Hand): SidePot[] {
  const result: SidePot[] = [];
  const ante = hand.players.reduce((sum, player) => sum + player.antePaid, 0);
  const limits = [...new Set(hand.players.map(player => player.streetCommitted).filter(amount => amount > 0))].sort((a, b) => a - b);
  let previous = 0;
  // A player all-in for the ante alone is eligible only for the dead ante pot.
  const anteOnly = hand.players.some(player => !player.folded && player.streetCommitted === 0);
  if (ante > 0 && (anteOnly || !limits.length)) result.push({ amount: ante, eligible: hand.players.filter(player => !player.folded).map(player => player.id) });
  for (const limit of limits) {
    const contributors = hand.players.filter(player => player.streetCommitted >= limit);
    const eligible = contributors.filter(player => !player.folded).map(player => player.id);
    const amount = (limit - previous) * contributors.length + (previous === 0 && !anteOnly ? ante : 0);
    if (amount > 0) {
      const prior = result[result.length - 1];
      if (prior && prior.eligible.length === eligible.length && prior.eligible.every(id => eligible.includes(id))) prior.amount += amount;
      else result.push({ amount, eligible });
    }
    previous = limit;
  }
  return result;
}

/** At preflop's end enter each player's final whole-hand contribution, including ante.
 * This records later streets without attempting a postflop strategy. Folded players
 * cannot contribute more. The current preflop contributions form the lower bound.
 */
export function setFinalContributions(input: Hand, totals: Record<string, number>): Hand {
  if (input.status !== 'settlement') throw new Error('Сначала завершите префлоп.');
  const hand = clone(input);
  // Actions contain only the preflop ledger, before its uncalled excess refund.
  // Recover that floor so a later correction can also lower a mistaken total.
  const preflop = hand.players.map(player => ({ id: player.id, live: hand.actions
    .filter(action => action.playerId === player.id && action.type !== 'ante')
    .reduce((sum, action) => sum + action.paid, 0) }));
  const ordered = [...preflop].sort((a, b) => b.live - a.live);
  if (ordered[0]) ordered[0].live -= ordered[0].live - (ordered[1]?.live ?? 0);
  const floors = Object.fromEntries(preflop.map(player => [player.id, player.live + hand.players.find(candidate => candidate.id === player.id)!.antePaid]));
  // These are corrections to the final ledger, not another round of wagers.
  // Refunds must be recalculated rather than accumulated on repeated edits.
  hand.players.forEach(player => { player.returned = 0; });
  for (const [id, total] of Object.entries(totals)) {
    const player = hand.players.find(candidate => candidate.id === id);
    if (!player) throw new Error('Неизвестный игрок.');
    integer(total, 'Итоговый вклад');
    if (total < floors[player.id] || total > player.startStack) throw new Error('Итоговый вклад должен быть между вкладом на префлопе и стартовым стеком.');
    if (player.folded && total !== floors[player.id]) throw new Error('Сбросивший карты игрок больше не ставит.');
    player.committed = total;
    player.streetCommitted = total - player.antePaid;
    player.stack = player.startStack - total;
    player.allIn = player.stack === 0;
  }
  returnUncalled(hand);
  return hand;
}

/** Select winners separately for each side pot. Odd chips go clockwise after BTN. */
export function settleHand(input: Hand, winners: string[][]): Hand {
  if (input.status !== 'settlement') throw new Error('Раздача ещё не готова к распределению банка.');
  const hand = clone(input);
  returnUncalled(hand);
  const pots = sidePots(hand);
  if (winners.length && winners.length !== pots.length) throw new Error('Укажите победителей каждого банка.');
  pots.forEach((sidePot, index) => {
    const chosen = winners[index] ?? (sidePot.eligible.length === 1 ? sidePot.eligible : []);
    if (!chosen.length || new Set(chosen).size !== chosen.length || chosen.some(id => !sidePot.eligible.includes(id))) throw new Error(`Выберите допустимых победителей банка ${index + 1}.`);
    const ordered = clockwise(hand.players.filter(player => chosen.includes(player.id)), hand.dealerSeat);
    const share = Math.floor(sidePot.amount / ordered.length);
    const remainder = sidePot.amount % ordered.length;
    ordered.forEach((player, position) => { player.stack += share + (position < remainder ? 1 : 0); player.allIn = player.stack === 0; });
  });
  hand.status = 'complete'; hand.actorId = null; hand.pending = [];
  return hand;
}

export function finishPlayers(players: Player[], hand: Hand, settings: TableSettings): Player[] {
  if (hand.status !== 'complete') throw new Error('Сначала распределите банк.');
  validateSettings(settings);
  return players.map(player => {
    const result = hand.players.find(candidate => candidate.id === player.id);
    if (!result) return { ...player };
    if (result.stack > 0) return { ...player, stack: result.stack };
    return settings.reentry
      ? { ...player, stack: settings.startingStack, active: true, reentries: player.reentries + 1 }
      : { ...player, stack: 0, active: false };
  });
}
