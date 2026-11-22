import { describe, expect, it } from 'vitest';
import {
  act, canRaise, createPlayers, finishPlayers, nextDealer, pot, setFinalContributions,
  settleHand, sidePots, startHand, type Hand, type TableSettings,
} from '../src/table/engine';

const settings: TableSettings = { startingStack: 30_000, smallBlind: 100, bigBlind: 200, reentry: true };
const player = (hand: Hand, id: string) => hand.players.find(candidate => candidate.id === id)!;
const callAround = (hand: Hand): Hand => {
  while (hand.status === 'playing') {
    const actor = player(hand, hand.actorId!);
    hand = act(hand, actor.streetCommitted < hand.currentBet ? 'call' : 'check');
  }
  return hand;
};
const totalChips = (hand: Hand) => hand.players.reduce((sum, candidate) => sum + candidate.stack, 0) + (hand.status === 'complete' ? 0 : pot(hand));

describe('preflop table accounting', () => {
  it('posts BB ante separately and keeps the BB option for a ten-seat table', () => {
    const hand = startHand(createPlayers(), settings, 0, 'player-1');
    expect(hand.actorId).toBe('player-4');
    expect(pot(hand)).toBe(500);
    expect(player(hand, 'player-3')).toMatchObject({ committed: 400, antePaid: 200, streetCommitted: 200, stack: 29_600 });
    const ended = callAround(hand);
    expect(ended.status).toBe('settlement');
    expect(ended.actions.at(-1)).toMatchObject({ playerId: 'player-3', type: 'check' });
    expect(pot(ended)).toBe(2_200);
    expect(totalChips(ended)).toBe(300_000);
    expect(hand.actions).toHaveLength(3);
  });

  it('uses the BTN as SB and first actor heads-up', () => {
    const hand = startHand(createPlayers(2), settings, 0, 'player-1');
    expect(hand.actorId).toBe('player-1');
    expect(player(hand, 'player-1').streetCommitted).toBe(100);
    expect(player(hand, 'player-2').antePaid).toBe(200);
    const called = act(hand, 'call');
    expect(called.actorId).toBe('player-2');
    expect(act(called, 'check').status).toBe('settlement');
  });

  it('treats a raise as the total amount and computes the extra chips', () => {
    let hand = startHand(createPlayers(2), settings, 0, 'player-1');
    hand = act(hand, 'raise', 600);
    expect(hand.actions.at(-1)).toMatchObject({ total: 600, paid: 500 });
    expect(player(hand, 'player-1').stack).toBe(29_400);
    expect(hand.minRaise).toBe(400);
    expect(() => act(hand, 'raise', 800)).toThrow(/Минимальная/);
    expect(() => act(hand, 'raise', 1000.5)).toThrow(/целое/);
    expect(() => act(hand, 'check')).toThrow();
    expect(() => act(hand, 'raise', 40_000)).toThrow(/стек/);
  });

  it('returns an unmatched bet and awards the blind/ante to the sole survivor', () => {
    let hand = startHand(createPlayers(2), settings, 0, 'player-1');
    hand = act(hand, 'raise', 2_000);
    hand = act(hand, 'fold');
    expect(player(hand, 'player-1').returned).toBe(1_800);
    expect(pot(hand)).toBe(600);
    expect(sidePots(hand)).toEqual([{ amount: 600, eligible: ['player-1'] }]);
    hand = settleHand(hand, []);
    expect(player(hand, 'player-1').stack).toBe(30_400);
    expect(player(hand, 'player-2').stack).toBe(29_600);
    expect(totalChips(hand)).toBe(60_000);
    expect(() => settleHand(hand, [])).toThrow();
  });

  it('does not reopen raising after a single incomplete all-in', () => {
    const players = createPlayers(4);
    players[0].stack = 300;
    let hand = startHand(players, settings, 0, 'player-1');
    hand = act(hand, 'call'); // player 4: 200
    hand = act(hand, 'all-in'); // BTN: 300, +100 incomplete
    hand = act(hand, 'call'); // SB
    hand = act(hand, 'call'); // BB
    expect(hand.actorId).toBe('player-4');
    expect(canRaise(hand)).toBe(false);
    expect(() => act(hand, 'raise', 600)).toThrow(/не открыты/);
    expect(callAround(hand).status).toBe('settlement');
  });

  it('reopens raising when successive short all-ins add up to a full raise', () => {
    const players = createPlayers(5);
    players[4].stack = 300;
    players[0].stack = 400;
    let hand = startHand(players, settings, 0, 'player-1');
    hand = act(hand, 'call'); // player 4: 200
    hand = act(hand, 'all-in'); // player 5: 300
    hand = act(hand, 'all-in'); // BTN: 400
    hand = act(hand, 'call'); // SB
    hand = act(hand, 'call'); // BB
    expect(hand.actorId).toBe('player-4');
    expect(canRaise(hand)).toBe(true);
    expect(act(hand, 'raise', 600).currentBet).toBe(600);
  });

  it('does not let the only player with chips create an empty side pot', () => {
    const players = createPlayers(2);
    players[0].stack = 300;
    let hand = startHand(players, settings, 0, 'player-1');
    hand = act(hand, 'all-in');
    expect(hand.actorId).toBe('player-2');
    expect(canRaise(hand)).toBe(false);
    expect(() => act(hand, 'all-in')).toThrow();
    hand = act(hand, 'call');
    expect(hand.status).toBe('settlement');
    expect(pot(hand)).toBe(800);
  });

  it('settles distinct side pots with folded dead money and no chip loss', () => {
    const players = createPlayers(4);
    players[0].stack = 1_000;
    players[1].stack = 2_000;
    players[2].stack = 3_200; // 200 dead ante plus 3000 live
    let hand = startHand(players, settings, 0, 'player-1');
    hand = act(hand, 'raise', 600); // player4
    hand = act(hand, 'all-in'); // 1000
    hand = act(hand, 'all-in'); // 2000
    hand = act(hand, 'all-in'); // 3000 live
    hand = act(hand, 'fold');
    expect(player(hand, 'player-3').returned).toBe(1_000);
    expect(sidePots(hand)).toEqual([
      { amount: 3_800, eligible: ['player-1', 'player-2', 'player-3'] },
      { amount: 2_000, eligible: ['player-2', 'player-3'] },
    ]);
    const initial = players.reduce((sum, candidate) => sum + candidate.stack, 0);
    hand = settleHand(hand, [['player-1'], ['player-2']]);
    expect(player(hand, 'player-1').stack).toBe(3_800);
    expect(player(hand, 'player-2').stack).toBe(2_000);
    expect(player(hand, 'player-3').stack).toBe(1_000);
    expect(totalChips(hand)).toBe(initial);
  });

  it('rejects an ineligible side-pot winner and duplicate winner', () => {
    const hand = callAround(startHand(createPlayers(3), settings, 0, 'player-1'));
    expect(() => settleHand(hand, [['missing']])).toThrow(/победителей/);
    expect(() => settleHand(hand, [['player-1', 'player-1']])).toThrow(/победителей/);
    expect(() => settleHand(hand, [])).toThrow(/победителей/);
  });

  it('splits pots with deterministic odd chips after the button', () => {
    const tiny = { ...settings, smallBlind: 1, bigBlind: 1 };
    let hand = callAround(startHand(createPlayers(3), tiny, 0, 'player-1'));
    expect(pot(hand)).toBe(4);
    hand = settleHand(hand, [['player-1', 'player-2', 'player-3']]);
    expect(player(hand, 'player-2').stack).toBe(30_001);
    expect(totalChips(hand)).toBe(90_000);
  });

  it('handles ante-first short BB without counting the ante as a live call', () => {
    const players = createPlayers(3);
    players[2].stack = 150;
    let hand = startHand(players, settings, 0, 'player-1');
    expect(player(hand, 'player-3')).toMatchObject({ antePaid: 150, streetCommitted: 0, allIn: true });
    expect(hand.currentBet).toBe(200);
    hand = callAround(hand);
    expect(sidePots(hand)).toEqual([
      { amount: 150, eligible: ['player-1', 'player-2', 'player-3'] },
      { amount: 400, eligible: ['player-1', 'player-2'] },
    ]);
    hand = settleHand(hand, [['player-3'], ['player-1']]);
    expect(player(hand, 'player-3').stack).toBe(150);
    expect(totalChips(hand)).toBe(60_150);
  });

  it('collects final contributions and creates post-hand side pots', () => {
    const players = createPlayers(3);
    const input = callAround(startHand(players, settings, 0, 'player-1'));
    const hand = setFinalContributions(input, { 'player-1': 1_000, 'player-2': 2_000, 'player-3': 2_200 });
    expect(pot(hand)).toBe(5_200);
    expect(sidePots(hand)).toEqual([
      { amount: 3_200, eligible: ['player-1', 'player-2', 'player-3'] },
      { amount: 2_000, eligible: ['player-2', 'player-3'] },
    ]);
    expect(input.players[0].committed).toBe(200);
    expect(() => setFinalContributions(input, { 'player-1': 199 })).toThrow();
    expect(() => setFinalContributions(input, { 'player-1': 30_001 })).toThrow();
    expect(() => setFinalContributions(input, { missing: 1000 })).toThrow();
  });

  it('rejects further contributions from a preflop folded player', () => {
    let hand = startHand(createPlayers(3), settings, 0, 'player-1');
    hand = act(hand, 'fold');
    hand = callAround(hand);
    expect(() => setFinalContributions(hand, { 'player-1': 1_000 })).toThrow(/Сбросивший/);
  });

  it('does not accumulate the same unmatched refund when correcting final totals', () => {
    let hand = callAround(startHand(createPlayers(2, 1_000), settings, 0, 'player-1'));
    for (let edit = 0; edit < 10; edit++) {
      hand = setFinalContributions(hand, { 'player-1': 1_000 });
      expect(player(hand, 'player-1').returned).toBe(800);
      expect(totalChips(hand)).toBe(2_000);
    }
  });

  it('allows downward final corrections while preserving preflop folded money', () => {
    let hand = startHand(createPlayers(4), settings, 0, 'player-1');
    hand = act(hand, 'raise', 600); // player 4
    hand = act(hand, 'call'); // BTN
    hand = act(hand, 'fold'); // SB, 100 dead
    hand = act(hand, 'call'); // BB, 200 ante + 600 live
    hand = setFinalContributions(hand, { 'player-1': 1_000, 'player-4': 2_000, 'player-3': 2_200 });
    expect(pot(hand)).toBe(5_300);
    hand = setFinalContributions(hand, { 'player-4': 1_000, 'player-3': 1_200 });
    expect(pot(hand)).toBe(3_300);
    expect(player(hand, 'player-2').committed).toBe(100);
    expect(() => setFinalContributions(hand, { 'player-1': 599 })).toThrow();
    expect(() => setFinalContributions(hand, { 'player-2': 99 })).toThrow();
    expect(totalChips(hand)).toBe(120_000);
  });

  it('deducts a preflop uncalled refund from the correction floor', () => {
    let hand = startHand(createPlayers(2), settings, 0, 'player-1');
    hand = act(hand, 'raise', 2_000);
    hand = act(hand, 'fold');
    hand = setFinalContributions(hand, { 'player-1': 200, 'player-2': 400 });
    expect(pot(hand)).toBe(600);
    expect(() => setFinalContributions(hand, { 'player-1': 199 })).toThrow();
    expect(totalChips(hand)).toBe(60_000);
  });

  it('rebuys only busted players, or eliminates them when reentry is closed', () => {
    const players = createPlayers(2, 1_000);
    let hand = startHand(players, settings, 0, 'player-1');
    hand = act(hand, 'all-in');
    hand = act(hand, 'call');
    hand = settleHand(hand, [['player-1']]);
    expect(finishPlayers(players, hand, settings)[1]).toMatchObject({ stack: 30_000, active: true, reentries: 1 });
    expect(finishPlayers(players, hand, { ...settings, reentry: false })[1]).toMatchObject({ stack: 0, active: false, reentries: 0 });
    expect(nextDealer(finishPlayers(players, hand, settings), 0)).toBe(1);
    expect(nextDealer(finishPlayers(players, hand, { ...settings, reentry: false }), 0)).toBe(0);
  });

  it('validates seats, stacks and chip precision', () => {
    expect(() => createPlayers(11)).toThrow();
    expect(() => createPlayers(2, 100.5)).toThrow();
    expect(() => startHand(createPlayers(2), { ...settings, smallBlind: 201 }, 0, 'player-1')).toThrow();
    const players = createPlayers(3);
    players[1].seat = 0;
    expect(() => startHand(players, settings, 0, 'player-1')).toThrow(/уникальными/);
  });

  it('conserves every chip across varied legal hands and side-pot awards', () => {
    let seed = 81371;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let trial = 0; trial < 150; trial++) {
      const count = 2 + Math.floor(random() * 9);
      const players = createPlayers(count);
      players.forEach(candidate => { candidate.stack = 1 + Math.floor(random() * 5_000); });
      const initial = players.reduce((sum, candidate) => sum + candidate.stack, 0);
      let hand = startHand(players, settings, 0, 'player-1');
      let actions = 0;
      while (hand.status === 'playing') {
        expect(++actions).toBeLessThan(200);
        const actor = player(hand, hand.actorId!);
        const choice = random();
        if (choice < 0.2) hand = act(hand, 'fold');
        else if (choice < 0.4 && canRaise(hand)) hand = act(hand, 'all-in');
        else if (choice < 0.6 && canRaise(hand) && actor.stack + actor.streetCommitted >= hand.currentBet + hand.minRaise) {
          hand = act(hand, 'raise', hand.currentBet + hand.minRaise);
        } else hand = act(hand, actor.streetCommitted < hand.currentBet ? 'call' : 'check');
        expect(totalChips(hand)).toBe(initial);
      }
      const pots = sidePots(hand);
      expect(pots.reduce((sum, sidePot) => sum + sidePot.amount, 0)).toBe(pot(hand));
      expect(pots.every(sidePot => sidePot.eligible.length > 0)).toBe(true);
      hand = settleHand(hand, pots.map(sidePot => [sidePot.eligible[0]]));
      expect(totalChips(hand)).toBe(initial);
      expect(hand.players.every(candidate => Number.isSafeInteger(candidate.stack) && candidate.stack >= 0)).toBe(true);
    }
  });
});
