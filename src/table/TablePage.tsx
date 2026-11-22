import { useEffect, useRef, useState } from "react";
import {
  act,
  canRaise,
  createPlayers,
  finishPlayers,
  nextDealer,
  pot,
  setFinalContributions,
  settleHand,
  sidePots,
  startHand,
} from "./engine";
import type { Hand, Player, TableSettings } from "./engine";
import {
  allHands,
  exportTable,
  importTable,
  loadSession,
  parseTableImport,
  saveSession,
  saveSessionAndArchive,
} from "./repository";
import type { TableSession } from "./repository";
import { preflopMatrix } from "../strategy/hands";
import type { ModelContext, ModelResult } from "../strategy/model";
import "./table.css";

const chips = (n: number) => n.toLocaleString("ru-RU");
const number = (s: string) => {
  const n = Number(s.trim().replace(",", "."));
  if (!s.trim() || !Number.isSafeInteger(n) || n < 0)
    throw Error("Введите целое неотрицательное число фишек.");
  return n;
};
const defaults: TableSettings = {
  startingStack: 30000,
  smallBlind: 100,
  bigBlind: 200,
  reentry: true,
};
const newSession = (): TableSession => {
  const players = createPlayers(10, 30000);
  return {
    version: 1,
    id: crypto.randomUUID(),
    settings: defaults,
    players,
    heroId: players[0].id,
    dealerSeat: 9,
    handNumber: 1,
    hand: null,
  };
};
function position(seat: number, players: Player[], dealer: number) {
  const seats = players
    .filter((p) => p.active)
    .map((p) => p.seat)
    .sort((a, b) => a - b);
  const d = seats.indexOf(dealer);
  const i = (seats.indexOf(seat) - d + seats.length) % seats.length;
  if (seats.length === 2) return i === 0 ? "BTN / SB" : "BB";
  if (i === 0) return "BTN";
  if (i === 1) return "SB";
  if (i === 2) return "BB";
  const left = seats.length - i;
  return left === 1
    ? "CO"
    : left === 2
      ? "HJ"
      : left === 3
        ? "LJ"
        : i === 3
          ? "UTG"
          : `UTG+${i - 3}`;
}
const actionName: Record<string, string> = {
  "small-blind": "SB",
  "big-blind": "BB",
  ante: "Анте",
  fold: "Фолд",
  check: "Чек",
  call: "Колл",
  raise: "Рейз",
  "all-in": "Олл-ин",
};

export function TablePage({ onBack }: { onBack: () => void }) {
  const [session, setSession] = useState<TableSession | null>(null),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  const [settings, setSettings] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false),
    [modelOpen, setModelOpen] = useState(false);
  const [amount, setAmount] = useState(""),
    [advice, setAdvice] = useState<ModelResult | null>(null),
    [progress, setProgress] = useState<number | null>(null),
    [modelError, setModelError] = useState("");
  const [selected, setSelected] = useState<string | null>(null),
    [totals, setTotals] = useState<Record<string, string>>({}),
    [winners, setWinners] = useState<string[][]>([]);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof allHands>>>(
    [],
  );
  const [samples, setSamples] = useState(() => {
    const n = Number(localStorage.getItem("preflop-samples"));
    return [160, 400, 1000].includes(n) ? n : 400;
  });
  const busy = useRef(false),
    undo = useRef<TableSession[]>([]);
  useEffect(() => {
    let alive = true;
    loadSession()
      .then(async (s) => {
        if (!alive) return;
        if (!s) {
          s = newSession();
          await saveSession(s);
        }
        if (alive) setSession(s);
      })
      .catch(() =>
        setError("Не удалось открыть хранилище стола. Перезагрузите страницу."),
      );
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    localStorage.setItem("preflop-samples", String(samples));
  }, [samples]);
  const hand = session?.hand;
  useEffect(() => {
    setAmount("");
    setSelected(null);
    setAdvice(null);
    setModelError("");
    setProgress(null);
    if (!hand || hand.status !== "playing" || hand.actorId !== hand.heroId)
      return;
    const id = `${session!.id}:${hand.number}:${hand.actions.length}:${samples}`;
    const context: ModelContext = {
      id,
      heroId: hand.heroId,
      heroSeat: hand.players.find((p) => p.id === hand.heroId)!.seat,
      dealerSeat: hand.dealerSeat,
      players: hand.players,
      actions: hand.actions,
      smallBlind: hand.smallBlind,
      bigBlind: hand.bigBlind,
      ante: hand.ante,
      currentBet: hand.currentBet,
      minRaise: hand.minRaise,
      samples,
      seed: hand.number * 1009 + hand.actions.length,
    };
    const worker = new Worker(
      new URL("../strategy/strategy.worker.ts", import.meta.url),
      { type: "module" },
    );
    let active = true;
    setProgress(0);
    worker.onmessage = (e) => {
      if (!active || e.data.id !== id) return;
      if (e.data.error) {
        setModelError(e.data.error);
        setProgress(null);
      } else if (e.data.result) {
        setAdvice(e.data.result);
        setProgress(null);
      } else setProgress(e.data.progress);
    };
    worker.onerror = () => {
      if (active) {
        setModelError(
          "Ошибка расчёта. Измените точность или повторно откройте стол.",
        );
        setProgress(null);
      }
    };
    worker.postMessage({ id, context });
    return () => {
      active = false;
      worker.terminate();
    };
  }, [hand, samples]);
  useEffect(() => {
    if (!hand || hand.status === "playing") return;
    setTotals(
      Object.fromEntries(hand.players.map((p) => [p.id, String(p.committed)])),
    );
    setWinners(
      sidePots(hand).map((p) => (p.eligible.length === 1 ? p.eligible : [])),
    );
  }, [hand]);
  async function operation(fn: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось сохранить изменения.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function replace(next: TableSession, remember = true) {
    await saveSession(next);
    if (remember && session) undo.current.push(session);
    setSession(next);
  }
  const perform = (type: "fold" | "check" | "call" | "raise" | "all-in") =>
    void operation(async () => {
      if (!session?.hand) return;
      await replace({
        ...session,
        hand: act(
          session.hand,
          type,
          type === "raise" ? number(amount) : undefined,
        ),
      });
    });
  if (!session)
    return (
      <>
        <header className="topbar">
          <button className="back" onClick={onBack} aria-label="В главное меню">
            ←
          </button>
        </header>
        <p role="status">{error || "Открываем стол…"}</p>
      </>
    );
  const actor = hand?.players.find((p) => p.id === hand.actorId),
    heroTurn = !!actor && actor.id === session.heroId;
  const displayBB = hand?.bigBlind ?? session.settings.bigBlind;
  const heroAvailable = session.players.some(
    (p) => p.id === session.heroId && p.active && p.stack > 0,
  );
  const active = session.players.filter((p) => p.active);
  const pots = hand && hand.status !== "playing" ? sidePots(hand) : [];
  const displayed = session.players.map((p) => ({
    ...p,
    ...hand?.players.find((h) => h.id === p.id),
  }));
  const selectedAdvice = selected ? advice?.hands[selected] : undefined;
  async function openHistory() {
    await operation(async () => {
      setHistory(await allHands());
      setHistoryOpen(true);
    });
  }
  async function exportData() {
    await operation(async () => {
      const history = await allHands();
      const url = URL.createObjectURL(
        new Blob([exportTable(session!, history)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "poker-table.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  async function complete() {
    await operation(async () => {
      if (!hand) return;
      const settled = settleHand(hand, winners);
      const players = finishPlayers(
        session!.players,
        settled,
        session!.settings,
      );
      const next = {
        ...session!,
        players,
        hand: null,
        handNumber: session!.handNumber + 1,
        dealerSeat:
          players.filter((p) => p.active).length > 1
            ? nextDealer(players, session!.dealerSeat)
            : (players.find((p) => p.active)?.seat ?? session!.dealerSeat),
      };
      await saveSessionAndArchive(next, {
        id: `${session!.id}:${hand.id}`,
        sessionId: session!.id,
        timestamp: Date.now(),
        hand: settled,
        settings: {
          ...session!.settings,
          smallBlind: hand.smallBlind,
          bigBlind: hand.bigBlind,
        },
        startingPlayers: session!.players,
      });
      undo.current = [];
      setSession(next);
    });
  }
  return (
    <>
      <header className="topbar">
        <button className="back" aria-label="В главное меню" onClick={onBack}>
          ←
        </button>
        <strong>Префлоп · стол</strong>
        <button
          className="settings-button"
          aria-label="Настройки стола"
          onClick={() => setSettings(true)}
        >
          ⚙
        </button>
      </header>
      {error && !settings && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="table-toolbar">
        <span>
          {chips(hand?.smallBlind ?? session.settings.smallBlind)} /{" "}
          {chips(displayBB)} · BB ante
        </span>
        <span>#{session.handNumber}</span>
        <span className={session.settings.reentry ? "" : "closed-reentry"}>
          {session.settings.reentry ? "Реэнтри ∞" : "Реэнтри закрыто"}
        </span>
      </div>
      <details className="seats-details" open={!hand}>
        <summary>Игроки · {active.length}</summary>
        <div className="seats" aria-label="Игроки за столом">
          {displayed
            .filter((p) => p.active)
            .map((p) => (
              <div
                key={p.id}
                className={
                  "seat " +
                  (p.id === actor?.id ? "acting " : "") +
                  (p.id === session.heroId ? "hero-seat " : "") +
                  ("folded" in p && p.folded ? "folded" : "")
                }
              >
                <div className="seat-top">
                  <span>
                    {position(
                      p.seat,
                      session.players,
                      hand?.dealerSeat ?? session.dealerSeat,
                    )}
                    {p.id === session.heroId ? " · Вы" : ""}
                  </span>
                  {p.seat === (hand?.dealerSeat ?? session.dealerSeat) && (
                    <b className="dealer-chip">D</b>
                  )}
                </div>
                <strong>{p.name}</strong>
                <div>
                  {chips(p.stack)}{" "}
                  <small>{(p.stack / displayBB).toFixed(1)} BB</small>
                </div>
                {"committed" in p && (
                  <small>
                    {p.folded
                      ? "Фолд"
                      : p.allIn
                        ? "Олл-ин"
                        : `Внесено ${chips(p.committed ?? 0)}`}
                  </small>
                )}
              </div>
            ))}
        </div>
      </details>
      {!hand ? (
        <div className="start-panel">
          <button
            className="primary"
            disabled={pending || active.length < 2 || !heroAvailable}
            onClick={() =>
              void operation(async () => {
                await replace({
                  ...session,
                  hand: startHand(
                    session.players,
                    session.settings,
                    session.dealerSeat,
                    session.heroId,
                    session.handNumber,
                  ),
                });
              })
            }
          >
            Начать раздачу
          </button>
          {!heroAvailable && (
            <p className="hint">
              Вы выбыли. Место и стек можно изменить в настройках.
            </p>
          )}
          <div className="table-links">
            <button onClick={() => setSettings(true)}>Состав и стеки</button>
            <button onClick={() => void openHistory()}>История</button>
          </div>
        </div>
      ) : (
        <>
          <div className="pot-line">
            <strong>Банк {chips(pot(hand))}</strong>
            <button
              disabled={pending || !undo.current.length}
              onClick={() =>
                void operation(async () => {
                  const prev = undo.current.at(-1);
                  if (prev) {
                    await saveSession(prev);
                    undo.current.pop();
                    setSession(prev);
                  }
                })
              }
            >
              ↶ Отменить ход
            </button>
          </div>
          {hand.status === "playing" && actor ? (
            <>
              <div className="turn-line">
                <strong>{heroTurn ? "Ваш ход" : `Ход: ${actor.name}`}</strong>
                <span>
                  {Math.max(0, hand.currentBet - actor.streetCommitted) > 0
                    ? `Колл ${chips(Math.min(actor.stack, hand.currentBet - actor.streetCommitted))}`
                    : "Можно чек"}
                </span>
              </div>
              <div className="table-actions">
                <button disabled={pending} onClick={() => perform("fold")}>
                  Фолд
                </button>
                <button
                  disabled={pending}
                  onClick={() =>
                    perform(
                      hand.currentBet > actor.streetCommitted
                        ? "call"
                        : "check",
                    )
                  }
                >
                  {hand.currentBet > actor.streetCommitted ? "Колл" : "Чек"}
                </button>
                <button
                  disabled={
                    pending ||
                    (actor.streetCommitted + actor.stack > hand.currentBet &&
                      !canRaise(hand))
                  }
                  onClick={() => perform("all-in")}
                >
                  Олл-ин
                </button>
              </div>
              <div className="raise-entry">
                <label htmlFor="raise-to">Ставка до</label>
                <input
                  id="raise-to"
                  disabled={pending || !canRaise(hand)}
                  inputMode="numeric"
                  value={amount}
                  placeholder={String(
                    Math.min(
                      actor.streetCommitted + actor.stack,
                      hand.currentBet + hand.minRaise,
                    ),
                  )}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <button
                  disabled={pending || !canRaise(hand)}
                  onClick={() => perform("raise")}
                >
                  {hand.actions.filter(
                    (a) =>
                      a.type === "raise" ||
                      (a.type === "all-in" && a.total > hand.bigBlind),
                  ).length > 0
                    ? "Повысить"
                    : "Рейз"}
                </button>
              </div>
              <div className="matrix-header">
                <h2>Диапазон</h2>
                <button onClick={() => setModelOpen(true)}>
                  Приближённая модель ⓘ
                </button>
              </div>
              {heroTurn ? (
                <>
                  {progress !== null && (
                    <p role="status" className="hint">
                      Расчёт матрицы…{" "}
                      {Math.round(progress <= 1 ? progress * 100 : progress)}%
                    </p>
                  )}
                  {modelError && (
                    <p role="alert" className="error">
                      {modelError}
                    </p>
                  )}
                  <div className="range-legend">
                    <span className="legend-fold">Фолд</span>
                    <span className="legend-call">Колл / чек</span>
                    <span className="legend-raise">Рейз / 3-бет</span>
                    <span className="legend-jam">Олл-ин</span>
                  </div>
                  <p className="matrix-note">
                    Штриховка — близкие оценки действий
                  </p>
                  <div
                    className="range-grid"
                    aria-label="Матрица стартовых рук"
                  >
                    {preflopMatrix()
                      .flat()
                      .map((h) => {
                        const a = advice?.hands[h];
                        return (
                          <button
                            key={h}
                            className={
                              "range-cell action-" +
                              (a?.action ?? "unknown") +
                              (a?.uncertain ? " uncertain" : "") +
                              (selected === h ? " picked" : "")
                            }
                            aria-label={
                              h + (a ? " — " + actionName[a.action] : "")
                            }
                            onClick={() =>
                              setSelected(selected === h ? null : h)
                            }
                          >
                            {h}
                          </button>
                        );
                      })}
                  </div>
                  {selected && (
                    <div className="hand-advice">
                      <strong>
                        {selected} ·{" "}
                        {selectedAdvice
                          ? actionName[selectedAdvice.action]
                          : "Считаем…"}
                        {selectedAdvice?.raiseTo
                          ? " до " + chips(selectedAdvice.raiseTo)
                          : ""}
                      </strong>
                      {selectedAdvice && (
                        <>
                          <div className="advice-ev">
                            {Object.entries(selectedAdvice.ev).map(
                              ([action, ev]) => (
                                <span key={action}>
                                  {actionName[action]}:{" "}
                                  {(ev! / displayBB).toFixed(2)} BB
                                </span>
                              ),
                            )}
                          </div>
                          <small>
                            {selectedAdvice.uncertain
                              ? "Близкие оценки: рекомендация неустойчива."
                              : "Оценки относительно фолда; будущие ставки не моделируются."}
                          </small>
                        </>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <p className="hint">Матрица появится в ваш ход.</p>
              )}
            </>
          ) : (
            <div className="settlement">
              <h2>Завершение раздачи</h2>
              <details>
                <summary>Итоговые вклады после префлопа</summary>
                <p className="hint">
                  Полная сумма за раздачу, включая блайнды и анте. Без
                  постфлоп-подсказок.
                </p>
                {hand.players.map((p) => (
                  <label key={p.id} className="final-contribution">
                    <span>
                      {p.name}
                      {p.folded ? " · фолд" : ""}
                    </span>
                    <input
                      aria-label={"Итоговый вклад " + p.name}
                      inputMode="numeric"
                      disabled={p.folded}
                      value={totals[p.id] ?? String(p.committed)}
                      onChange={(e) =>
                        setTotals({ ...totals, [p.id]: e.target.value })
                      }
                    />
                  </label>
                ))}
                <button
                  disabled={pending}
                  onClick={() =>
                    void operation(async () => {
                      await replace({
                        ...session,
                        hand: setFinalContributions(
                          hand,
                          Object.fromEntries(
                            Object.entries(totals).map(([id, s]) => [
                              id,
                              number(s),
                            ]),
                          ),
                        ),
                      });
                    })
                  }
                >
                  Пересчитать банки
                </button>
              </details>
              {pots.map((p, i) => (
                <fieldset key={i}>
                  <legend>
                    {i === 0 ? "Основной банк" : `Побочный банк ${i}`} ·{" "}
                    {chips(p.amount)}
                  </legend>
                  {p.eligible.map((id) => (
                    <label className="winner" key={id}>
                      <input
                        type="checkbox"
                        checked={winners[i]?.includes(id) ?? false}
                        onChange={(e) =>
                          setWinners((old) =>
                            pots.map((_, j) =>
                              j === i
                                ? e.target.checked
                                  ? [...(old[i] ?? []), id]
                                  : (old[i] ?? []).filter((x) => x !== id)
                                : (old[j] ?? []),
                            ),
                          )
                        }
                      />
                      {hand.players.find((x) => x.id === id)?.name}
                    </label>
                  ))}
                </fieldset>
              ))}
              <button
                className="primary"
                disabled={
                  pending ||
                  winners.length !== pots.length ||
                  winners.some((w) => !w.length)
                }
                onClick={() => void complete()}
              >
                Распределить банк
              </button>
            </div>
          )}
          <details className="hand-log">
            <summary>Ходы · {hand.actions.length}</summary>
            {hand.actions.map((a, i) => (
              <p key={i}>
                {hand.players.find((p) => p.id === a.playerId)?.name}:{" "}
                {actionName[a.type]}
                {a.paid ? ` до ${chips(a.total)} (+${chips(a.paid)})` : ""}
              </p>
            ))}
          </details>
        </>
      )}
      {settings && (
        <Settings
          error={error}
          session={session}
          pending={pending}
          samples={samples}
          onSamples={setSamples}
          onClose={() => setSettings(false)}
          onSave={async (next) => {
            await replace(next);
            setSettings(false);
          }}
          operation={operation}
          onExport={() => void exportData()}
          onHistory={() => void openHistory()}
          onImport={async (file) => {
            const text = await file.text();
            const payload = parseTableImport(text);
            if (
              !confirm(
                "Заменить текущий стол данными из файла? История будет объединена.",
              )
            )
              return;
            await importTable(payload);
            undo.current = [];
            setSession(payload.session);
            setSettings(false);
          }}
        />
      )}
      {modelOpen && (
        <div className="overlay" onClick={() => setModelOpen(false)}>
          <div
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Модель рекомендаций"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-header">
              <h2>О расчёте</h2>
              <button
                aria-label="Закрыть описание модели"
                onClick={() => setModelOpen(false)}
              >
                ×
              </button>
            </div>
            <p>Результат упрощённой модели, не GTO и не равновесие.</p>
            {(
              advice?.assumptions ?? [
                "Диапазоны усреднённых оппонентов задаются моделью по позиции и действиям.",
                "Сравниваются фолд, колл, рейз и олл-ин; после ответов оппонентов борд доигрывается без будущих ставок.",
                "Рейтинг, ICM и эксплуатация конкретного игрока не учитываются.",
              ]
            ).map((s) => (
              <p className="hint" key={s}>
                {s}
              </p>
            ))}
            <button className="primary" onClick={() => setModelOpen(false)}>
              Понятно
            </button>
          </div>
        </div>
      )}
      {historyOpen && (
        <div className="overlay" onClick={() => setHistoryOpen(false)}>
          <div
            className="sheet history-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="История стола"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-header">
              <h2>История стола</h2>
              <button
                aria-label="Закрыть историю"
                onClick={() => setHistoryOpen(false)}
              >
                ×
              </button>
            </div>
            {!history.length ? (
              <p>Пока нет завершённых раздач.</p>
            ) : (
              history
                .slice()
                .sort((a, b) => b.timestamp - a.timestamp)
                .map((r) => (
                  <details key={r.id}>
                    <summary>
                      #{r.hand.number} ·{" "}
                      {new Date(r.timestamp).toLocaleString("ru-RU")}
                    </summary>
                    {r.hand.players.map((p) => (
                      <p key={p.id}>
                        {p.name}: {chips(p.startStack)} → {chips(p.stack)}
                      </p>
                    ))}
                    {r.hand.actions.map((a, i) => (
                      <p className="hint" key={i}>
                        {r.hand.players.find((p) => p.id === a.playerId)?.name}:{" "}
                        {actionName[a.type]} {a.total}
                      </p>
                    ))}
                  </details>
                ))
            )}
            <button className="primary" onClick={() => void exportData()}>
              Экспорт JSON
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function Settings({
  error,
  session,
  pending,
  samples,
  onSamples,
  onClose,
  onSave,
  operation,
  onExport,
  onHistory,
  onImport,
}: {
  error: string;
  session: TableSession;
  pending: boolean;
  samples: number;
  onSamples: (n: number) => void;
  onClose: () => void;
  onSave: (s: TableSession) => Promise<void>;
  operation: (fn: () => Promise<void>) => Promise<void>;
  onExport: () => void;
  onHistory: () => void;
  onImport: (file: File) => Promise<void>;
}) {
  const [draft, setDraft] = useState(session),
    [stack, setStack] = useState(String(session.settings.startingStack)),
    [sb, setSB] = useState(String(session.settings.smallBlind)),
    [bb, setBB] = useState(String(session.settings.bigBlind)),
    [levels, setLevels] = useState(
      (session.settings.blindLevels ?? [])
        .map((l) => `${l.smallBlind}/${l.bigBlind}`)
        .join("\n"),
    );
  const locked = !!draft.hand;
  async function save() {
    await operation(async () => {
      const startingStack = number(stack),
        smallBlind = number(sb),
        bigBlind = number(bb);
      if (!startingStack || !smallBlind || bigBlind <= smallBlind)
        throw Error("Стек и блайнды должны быть положительными; BB больше SB.");
      const blindLevels = levels.trim()
        ? levels
            .trim()
            .split(/\n+/)
            .map((line) => {
              const parts = line.trim().split("/");
              if (parts.length !== 2)
                throw Error("Уровень блайндов: SB/BB, каждый с новой строки.");
              const smallBlind = number(parts[0]),
                bigBlind = number(parts[1]);
              if (!smallBlind || bigBlind <= smallBlind)
                throw Error("Проверьте уровни блайндов.");
              return { smallBlind, bigBlind };
            })
        : [];
      await onSave({
        ...draft,
        settings: {
          startingStack,
          smallBlind,
          bigBlind,
          reentry: draft.settings.reentry,
          blindLevels,
        },
      });
    });
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="sheet settings-table"
        role="dialog"
        aria-modal="true"
        aria-label="Настройки стола"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <h2>Настройки стола</h2>
          <button aria-label="Закрыть настройки стола" onClick={onClose}>
            ×
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="settings-fields">
          <label>
            Стартовый стек
            <input
              inputMode="numeric"
              value={stack}
              onChange={(e) => setStack(e.target.value)}
            />
          </label>
          <div className="blind-inputs">
            <label>
              SB
              <input
                inputMode="numeric"
                value={sb}
                onChange={(e) => setSB(e.target.value)}
              />
            </label>
            <label>
              BB + анте 1 BB
              <input
                inputMode="numeric"
                value={bb}
                onChange={(e) => setBB(e.target.value)}
              />
            </label>
          </div>
          <label className="reentry-toggle">
            <input
              type="checkbox"
              checked={draft.settings.reentry}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  settings: { ...draft.settings, reentry: e.target.checked },
                })
              }
            />
            Реэнтри включено
          </label>
          {locked && (
            <p className="hint">
              Блайнды изменятся со следующей раздачи. Реэнтри — при завершении
              текущей.
            </p>
          )}
          <label>
            Точность матрицы
            <select
              value={samples}
              onChange={(e) => onSamples(Number(e.target.value))}
            >
              <option value={160}>Быстрее · 160 выборок на руку</option>
              <option value={400}>Обычно · 400 выборок на руку</option>
              <option value={1000}>Точнее · 1 000 выборок на руку</option>
            </select>
          </label>
          <details>
            <summary>Уровни блайндов</summary>
            <label>
              По одному SB/BB на строку
              <textarea
                value={levels}
                placeholder={"100/200\n200/400\n300/600"}
                onChange={(e) => setLevels(e.target.value)}
              />
            </label>
            <button
              disabled={locked}
              onClick={() =>
                void operation(async () => {
                  const parsed = levels
                    .trim()
                    .split(/\n+/)
                    .filter(Boolean)
                    .map((s) => s.split("/").map(number));
                  if (
                    parsed.some(
                      (x) => x.length !== 2 || x[0] <= 0 || x[1] <= x[0],
                    )
                  )
                    throw Error("Проверьте таблицу блайндов.");
                  const current = number(bb);
                  const next = parsed.find(([, b]) => b > current);
                  if (!next)
                    throw Error("Добавьте следующий уровень блайндов.");
                  setSB(String(next[0]));
                  setBB(String(next[1]));
                })
              }
            >
              Блайндс ап
            </button>
          </details>
          <details open={!locked}>
            <summary>Игроки и позиции</summary>
            {locked ? (
              <button
                onClick={() => {
                  if (
                    confirm(
                      "Отменить текущую раздачу и вернуться к её стартовым стекам для редактирования?",
                    )
                  )
                    setDraft({ ...draft, hand: null });
                }}
              >
                Отменить раздачу для редактирования
              </button>
            ) : (
              <>
                <label>
                  Вы
                  <select
                    value={draft.heroId}
                    onChange={(e) =>
                      setDraft({ ...draft, heroId: e.target.value })
                    }
                  >
                    {draft.players
                      .filter((p) => p.active)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Дилер
                  <select
                    value={draft.dealerSeat}
                    onChange={(e) =>
                      setDraft({ ...draft, dealerSeat: Number(e.target.value) })
                    }
                  >
                    {draft.players
                      .filter((p) => p.active)
                      .map((p) => (
                        <option key={p.id} value={p.seat}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
                {draft.players.map((p) => (
                  <div className="player-edit" key={p.id}>
                    <input
                      aria-label={"Имя места " + (p.seat + 1)}
                      value={p.name}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          players: draft.players.map((x) =>
                            x.id === p.id ? { ...x, name: e.target.value } : x,
                          ),
                        })
                      }
                    />
                    <input
                      aria-label={"Стек " + p.name}
                      inputMode="numeric"
                      value={p.stack}
                      onChange={(e) => {
                        if (/^\d*$/.test(e.target.value)) {
                          const n = Number(e.target.value);
                          if (Number.isSafeInteger(n))
                            setDraft({
                              ...draft,
                              players: draft.players.map((x) =>
                                x.id === p.id ? { ...x, stack: n } : x,
                              ),
                            });
                        }
                      }}
                    />
                    <button
                      aria-label={"Удалить " + p.name}
                      onClick={() =>
                        void operation(async () => {
                          const players = draft.players.filter(
                            (x) => x.id !== p.id,
                          );
                          if (!players.length)
                            throw Error(
                              "Оставьте хотя бы одно место за столом.",
                            );
                          const fallback =
                            players.find((x) => x.active) ?? players[0];
                          setDraft({
                            ...draft,
                            players,
                            heroId:
                              draft.heroId === p.id
                                ? fallback.id
                                : draft.heroId,
                            dealerSeat:
                              draft.dealerSeat === p.seat
                                ? fallback.seat
                                : draft.dealerSeat,
                          });
                        })
                      }
                    >
                      ×
                    </button>
                    {!p.active && (
                      <button
                        onClick={() =>
                          void operation(async () => {
                            setDraft({
                              ...draft,
                              players: draft.players.map((x) =>
                                x.id === p.id
                                  ? { ...x, active: true, stack: number(stack) }
                                  : x,
                              ),
                            });
                          })
                        }
                      >
                        Вернуть
                      </button>
                    )}
                  </div>
                ))}
                <button
                  disabled={draft.players.length >= 10}
                  onClick={() =>
                    void operation(async () => {
                      const seat = Array.from({ length: 10 }, (_, i) => i).find(
                        (i) => !draft.players.some((p) => p.seat === i),
                      );
                      if (seat === undefined) return;
                      const player: Player = {
                        id: crypto.randomUUID(),
                        name: `Игрок ${seat + 1}`,
                        stack: number(stack),
                        seat,
                        active: true,
                        reentries: 0,
                      };
                      setDraft({
                        ...draft,
                        players: [...draft.players, player].sort(
                          (a, b) => a.seat - b.seat,
                        ),
                      });
                    })
                  }
                >
                  Добавить игрока
                </button>
                <button
                  onClick={() =>
                    void operation(async () => {
                      const n = number(stack);
                      setDraft({
                        ...draft,
                        players: draft.players.map((p) => ({
                          ...p,
                          stack: n,
                          active: true,
                        })),
                      });
                    })
                  }
                >
                  Всем стартовый стек
                </button>
              </>
            )}
          </details>
          <div className="table-links">
            <button onClick={onHistory}>История</button>
            <button onClick={onExport}>Экспорт</button>
            <label className="button">
              Импорт
              <input
                hidden
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void operation(() => onImport(file));
                }}
              />
            </label>
          </div>
          <button
            className="danger-button"
            onClick={() =>
              void operation(async () => {
                if (
                  confirm(
                    "Начать новый турнир? Текущая раздача будет отменена, завершённые останутся в истории.",
                  )
                )
                  await onSave(newSession());
              })
            }
          >
            Новый турнир
          </button>
        </div>
        <button
          className="primary"
          disabled={pending}
          onClick={() => void save()}
        >
          Сохранить
        </button>
      </div>
    </div>
  );
}
