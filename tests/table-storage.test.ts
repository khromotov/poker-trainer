import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { act, createPlayers, finishPlayers, settleHand, startHand } from '../src/table/engine';
import type { TableSettings } from '../src/table/engine';
import {
  allHands, archiveHand, exportTable, importTable, loadSession, parseTableImport,
  saveSession, saveSessionAndArchive,
} from '../src/table/repository';
import type { ArchivedHand, TableSession } from '../src/table/repository';
import { all as allEquity, save as saveEquity } from '../src/storage';

const settings: TableSettings = { startingStack: 30_000, smallBlind: 100, bigBlind: 200, reentry: true };

function session(): TableSession {
  const players = createPlayers(3, settings.startingStack);
  return {
    version: 1, id: 'table-session-1', settings: { ...settings }, players,
    heroId: players[0].id, dealerSeat: 0, handNumber: 1,
    hand: startHand(players, settings, 0, players[0].id),
  };
}

function completed(): { current: TableSession; archive: ArchivedHand } {
  const current = session();
  let hand = current.hand!;
  while (hand.status === 'playing') hand = act(hand, 'fold');
  hand = settleHand(hand, []);
  const archive: ArchivedHand = {
    id: `${current.id}:${hand.id}`, sessionId: current.id,
    timestamp: 1000, hand, settings: current.settings, startingPlayers: current.players,
  };
  return {
    current: { ...current, players: finishPlayers(current.players, hand, settings), hand },
    archive,
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe('table persistence', () => {
  it('creates independent storage without changing existing equity history', async () => {
    const equity = {
      id: 'old-equity-result', timestamp: 10, mode: 'Random' as const,
      cards: [0, 1, 2, 3], answer: 50, equity: .5, win: .4, tie: .2,
      simulations: 10000, signed: 0, absolute: 0, categories: [],
    };
    await saveEquity(equity);
    expect(await loadSession()).toBeNull();
    const current = session();
    await saveSession(current);
    expect(await loadSession()).toEqual(current);
    expect(await allEquity()).toEqual([equity]);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('poker-trainer');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(database.version).toBe(1);
    database.close();
  });

  it('saves the paid state and archive atomically and idempotently', async () => {
    const { current, archive } = completed();
    await saveSessionAndArchive(current, archive);
    await saveSessionAndArchive(current, archive);
    expect(await loadSession()).toEqual(current);
    expect(await allHands()).toEqual([archive]);
    const bad = { ...archive, sessionId: 'different-session' };
    await expect(saveSessionAndArchive({ ...current, handNumber: 2 }, bad)).rejects.toThrow();
    expect((await loadSession())?.handNumber).toBe(1);
  });

  it('round-trips exports and imports without replacing conflicting archive IDs', async () => {
    const { current, archive } = completed();
    await archiveHand(archive);
    const conflict = { ...archive, timestamp: archive.timestamp + 100 };
    const nextArchive = { ...archive, id: 'second-archive', timestamp: 2000 };
    const imported = { ...current, handNumber: 12 };
    const payload = parseTableImport(exportTable(imported, [conflict, nextArchive]));
    expect(await importTable(payload)).toEqual({ added: 1, skipped: 1 });
    expect(await allHands()).toEqual([nextArchive, archive]);
    expect(await loadSession()).toEqual(imported);
    expect(await importTable(payload)).toEqual({ added: 0, skipped: 2 });
  });

  it('rejects malformed imports before any database write', async () => {
    const current = session();
    await saveSession(current);
    const invalid = structuredClone(current);
    invalid.players[0].stack = -1;
    await expect(importTable({ session: invalid, history: [] })).rejects.toThrow();
    expect(await loadSession()).toEqual(current);
    expect(await allHands()).toEqual([]);
  });

  it('persists the final remaining player and a manually corrected snapshot', async () => {
    const current = session();
    current.hand = null;
    current.players = [current.players[0]];
    current.players[0].stack = 123456;
    current.players[0].name = 'Corrected name';
    await saveSession(current);
    expect(await loadSession()).toEqual(current);
  });
});

describe('table import validation', () => {
  const transfer = () => ({ format: 'poker-table', version: 1, session: session(), history: [] as ArchivedHand[] });

  it.each([
    ['duplicate player ID', (value: ReturnType<typeof transfer>) => { value.session.players[1].id = value.session.players[0].id; }],
    ['duplicate seat', (value: ReturnType<typeof transfer>) => { value.session.players[1].seat = value.session.players[0].seat; }],
    ['fractional chips', (value: ReturnType<typeof transfer>) => { value.session.players[0].stack = .5; }],
    ['unsafe chips', (value: ReturnType<typeof transfer>) => { value.session.players[0].stack = Number.MAX_SAFE_INTEGER + 1; }],
    ['invalid blinds', (value: ReturnType<typeof transfer>) => { value.session.settings.smallBlind = 1000; }],
    ['missing hero', (value: ReturnType<typeof transfer>) => { value.session.heroId = 'missing'; }],
    ['unknown actor', (value: ReturnType<typeof transfer>) => { value.session.hand!.actorId = 'missing'; }],
    ['inconsistent hand chips', (value: ReturnType<typeof transfer>) => { value.session.hand!.players[0].stack += 1; }],
    ['negative ante', (value: ReturnType<typeof transfer>) => { value.session.hand!.players[2].antePaid = -1; }],
    ['unknown action', (value: ReturnType<typeof transfer>) => { (value.session.hand!.actions[0] as { type: string }).type = 'bet-more'; }],
    ['invalid action amount', (value: ReturnType<typeof transfer>) => { value.session.hand!.actions[0].paid = Number.POSITIVE_INFINITY; }],
    ['invalid reentry', (value: ReturnType<typeof transfer>) => { (value.session.settings as unknown as { reentry: string }).reentry = 'yes'; }],
  ])('rejects %s', (_label, mutate) => {
    const value = transfer();
    mutate(value);
    expect(() => parseTableImport(JSON.stringify(value))).toThrow();
  });

  it('rejects duplicate archive IDs, unknown versions, huge files and unrelated equity exports', () => {
    const { current, archive } = completed();
    expect(() => exportTable(current, [archive, archive])).toThrow();
    expect(() => parseTableImport(JSON.stringify({ ...transfer(), version: 2 }))).toThrow();
    expect(() => parseTableImport(' '.repeat(10 * 1024 * 1024 + 1))).toThrow(/10/);
    expect(() => parseTableImport(JSON.stringify({ version: 1, settings: { simulations: 50000 }, history: [] }))).toThrow();
  });
});
