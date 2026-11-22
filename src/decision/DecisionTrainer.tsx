import { useEffect, useRef, useState } from "react";
import { rank, suit } from "../core";
import {
  applyAction,
  createTrainingHand,
  observe,
  positionLabel,
} from "./engine";
import type { DecisionObservation, Street, TournamentStage } from "./engine";
import type { ActionType } from "../table/engine";
import { gradeDecision } from "./policy";
import type { Analysis, Feedback } from "./policy";
import {
  allArchives,
  completeSession,
  exportHistory,
  importHistory,
  loadSession,
  parseHistoryImport,
  saveSession,
} from "./repository";
import type {
  ArchivedTrainingHand,
  DecisionSession,
  DecisionSettings,
} from "./repository";
import "./decision.css";

const names: Record<string, string> = {
  fold: "Фолд",
  check: "Чек",
  call: "Колл",
  raise: "Рейз",
  "all-in": "Олл-ин",
  "small-blind": "SB",
  "big-blind": "BB",
  ante: "Анте",
};
const streetNames: Record<Street, string> = {
  preflop: "Префлоп",
  flop: "Флоп",
  turn: "Тёрн",
  river: "Ривер",
};
const verdictNames: Record<string, string> = {
  good: "Хорошо",
  reasonable: "Разумно",
  risky: "Рискованно",
  mistake: "Ошибка",
  uncertain: "Неоднозначно",
};
const profileNames = {
  balanced: "Умеренный",
  tight: "Тайтовый",
  loose: "Лузовый",
};
const stageNames: Record<TournamentStage, string> = {
  early: "Ранняя стадия",
  middle: "Середина турнира",
  late: "Поздняя стадия",
  final: "Финальный стол",
};
const stageDepths: Record<TournamentStage, { random: string; fixed: string }> =
  {
    early: {
      random: "Случайная глубина до 150 BB, не выше стартового стека.",
      fixed: "Все игроки получают указанный стартовый стек.",
    },
    middle: { random: "Стеки 25–60 BB.", fixed: "Стеки 40 BB." },
    late: {
      random: "Ваш стек 15–25 BB, у соперников 10–40 BB.",
      fixed: "Стеки 20 BB.",
    },
    final: {
      random: "Ваш стек 10–15 BB, у соперников 8–30 BB.",
      fixed: "Стеки 12 BB.",
    },
  };
const chips = (n: number) => n.toLocaleString("ru-RU");
function actionName(action: string, currentBet: number) {
  return action === "raise" && currentBet === 0 ? "Бет" : names[action];
}
function logActionName(
  log: DecisionObservation["history"][number],
  history: DecisionObservation["history"],
) {
  const priorBet =
    log.street === "preflop" ||
    history
      .slice(0, history.indexOf(log))
      .some(
        (previous) =>
          previous.street === log.street &&
          ["raise", "all-in"].includes(previous.action) &&
          previous.total > 0,
      );
  return actionName(log.action, priorBet ? 1 : 0);
}
const defaults: DecisionSettings = {
  playerCount: 10,
  startingStack: 30000,
  smallBlind: 100,
  bigBlind: 200,
  randomDepth: true,
  tournamentStage: "early",
};
const fresh = (): DecisionSession => ({
  version: 1,
  id: crypto.randomUUID(),
  hand: null,
  decisions: [],
  settings: defaults,
  handNumber: 0,
  awaitingFeedback: false,
});
function newHand(settings: DecisionSettings, number: number) {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  return createTrainingHand(seed, { ...settings, number });
}
function parseChips(s: string) {
  const n = Number(s.trim().replace(",", "."));
  if (!s.trim() || !Number.isSafeInteger(n) || n <= 0)
    throw Error("Введите целое положительное число фишек.");
  return n;
}
function Cards({
  cards,
  backs = 0,
  small = false,
}: {
  cards?: number[];
  backs?: number;
  small?: boolean;
}) {
  return (
    <div className={"decision-cards " + (small ? "small" : "")}>
      {cards
        ? cards.map((c) => (
            <div
              key={c}
              className={
                "decision-card " + ([1, 2].includes(suit(c)) ? "red" : "")
              }
              aria-label={
                "23456789TJQKA"[rank(c) - 2] + ["♠", "♥", "♦", "♣"][suit(c)]
              }
            >
              <b>{"23456789TJQKA"[rank(c) - 2]}</b>
              <span>{["♠", "♥", "♦", "♣"][suit(c)]}</span>
            </div>
          ))
        : Array.from({ length: backs }, (_, i) => (
            <div
              className="decision-card back-card"
              key={i}
              aria-label="Закрытая карта"
            >
              ◆
            </div>
          ))}
    </div>
  );
}

export function DecisionTrainer({ onBack }: { onBack: () => void }) {
  const [session, setSession] = useState<DecisionSession | null>(null),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false),
    [infoOpen, setInfoOpen] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null),
    [thinking, setThinking] = useState(false),
    [raiseOpen, setRaiseOpen] = useState(false),
    [amount, setAmount] = useState(""),
    [retry, setRetry] = useState(0);
  const [showFolded, setShowFolded] = useState(false);
  const analyzedTurn = useRef(""),
    cancelRegrade = useRef<(() => void) | null>(null);
  const lock = useRef(false),
    request = useRef(0),
    live = useRef(true);
  useEffect(() => {
    live.current = true;
    let active = true;
    loadSession()
      .then(async (value) => {
        if (!active) return;
        if (!value) {
          value = fresh();
          await saveSession(value);
        }
        if (active) setSession(value);
      })
      .catch(() =>
        setError(
          "Не удалось открыть сохранённую тренировку. Перезагрузите страницу.",
        ),
      );
    return () => {
      active = false;
      live.current = false;
      cancelRegrade.current?.();
    };
  }, []);
  async function persist(next: DecisionSession) {
    if (next.hand?.phase === "finished") {
      await completeSession(next, {
        id: `${next.id}:${next.hand.id}`,
        sessionId: next.id,
        timestamp: Date.now(),
        hand: next.hand,
        decisions: next.decisions,
      });
    } else await saveSession(next);
    if (live.current) setSession(next);
  }
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (live.current)
        setError(
          e instanceof Error ? e.message : "Не удалось сохранить тренировку.",
        );
    } finally {
      lock.current = false;
      if (live.current) setPending(false);
    }
  }
  const hand = session?.hand;
  const turnKey = hand
    ? `${hand.id}:${hand.logs.length}:${hand.hand.actorId ?? ""}`
    : "";
  useEffect(() => {
    setAnalysis(null);
    setThinking(false);
    setRaiseOpen(false);
    setAmount("");
    if (
      !session ||
      !hand ||
      hand.phase === "finished" ||
      session.awaitingFeedback ||
      settingsOpen ||
      historyOpen ||
      infoOpen ||
      !hand.hand.actorId
    )
      return;
    const actorId = hand.hand.actorId,
      heroTurn = actorId === hand.heroId;
    const observation = observe(hand, actorId),
      id = String(++request.current),
      seed =
        (hand.seed ^ Math.imul(hand.logs.length + 1, 0x9e3779b9) ^ 0x5bd1e995) |
        0;
    const worker = new Worker(
      new URL("./decision.worker.ts", import.meta.url),
      { type: "module" },
    );
    let active = true;
    setThinking(true);
    worker.onmessage = (e) => {
      if (!active || e.data.id !== id) return;
      if (e.data.error) {
        setThinking(false);
        setError(e.data.error);
        return;
      }
      if (heroTurn) {
        if (e.data.analysis) {
          analyzedTurn.current = turnKey;
          setAnalysis(e.data.analysis);
        }
        setThinking(false);
        return;
      }
      if (e.data.action) {
        active = false;
        const choice = e.data.action;
        void run(async () => {
          const nextHand = applyAction(
            hand,
            choice.action,
            choice.total,
            choice.reason,
          );
          // A walk gives the trainee no decision. Generate a fresh whole deal;
          // never change an opponent's cards or action within a dealt hand.
          await persist({
            ...session,
            hand:
              nextHand.phase === "finished" && !session.decisions.length
                ? newHand(session.settings, session.handNumber)
                : nextHand,
          });
        });
      }
    };
    worker.onerror = () => {
      if (active) {
        setThinking(false);
        setError(
          "Не удалось рассчитать ход. Вернитесь в меню и откройте тренировку повторно.",
        );
      }
    };
    const timer = setTimeout(
      () => {
        worker.postMessage({
          id,
          mode: heroTurn ? "analyze" : "bot",
          observation,
          profile: hand.profiles[actorId],
          seed,
          samples: heroTurn ? 1800 : 350,
        });
      },
      heroTurn ? 0 : 180,
    );
    return () => {
      active = false;
      clearTimeout(timer);
      worker.terminate();
    };
  }, [
    hand,
    session?.awaitingFeedback,
    settingsOpen,
    historyOpen,
    infoOpen,
    retry,
  ]);
  if (!session)
    return (
      <>
        <header className="topbar">
          <button className="back" onClick={onBack} aria-label="В главное меню">
            ←
          </button>
          <strong>Тренажёр решений</strong>
        </header>
        <p role="status">{error || "Загружаем тренировку…"}</p>
      </>
    );
  const last = session.decisions.at(-1),
    feedback = session.awaitingFeedback ? last : undefined;
  const view: DecisionObservation | undefined =
    feedback?.observation ?? (hand ? observe(hand, hand.heroId) : undefined);
  const finished = hand?.phase === "finished" && !feedback;
  const actor = hand?.hand.players.find((p) => p.id === hand.hand.actorId);
  const heroTurn =
    !!hand && !feedback && !finished && hand.hand.actorId === hand.heroId;
  const displayedBoard = feedback?.observation.board ?? hand?.board ?? [];
  const heroCards =
    feedback?.observation.heroCards ??
    (hand ? hand.holeCards[hand.heroId] : []);
  const visibleLogs = feedback
    ? feedback.observation.history
    : (hand?.logs ?? []);
  const hero = hand?.hand.players.find((p) => p.id === hand.heroId);
  const ready =
    heroTurn &&
    !!analysis &&
    analyzedTurn.current === turnKey &&
    !thinking &&
    !pending;
  async function choose(action: ActionType, total?: number) {
    await run(async () => {
      if (!hand || !analysis || !ready) return;
      const observation = observe(hand, hand.heroId);
      const feedback = gradeDecision(observation, analysis, action, total);
      const nextHand = applyAction(hand, action, total);
      const record = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        observation,
        action,
        ...(total !== undefined ? { total } : {}),
        feedback,
      };
      await persist({
        ...session!,
        hand: nextHand,
        decisions: [...session!.decisions, record],
        awaitingFeedback: true,
      });
    });
  }
  async function deal() {
    await run(async () => {
      const number = session!.handNumber + 1;
      const nextHand = newHand(session!.settings, number);
      await persist({
        ...session!,
        hand: nextHand,
        decisions: [],
        awaitingFeedback: false,
        handNumber: number,
      });
    });
  }
  async function regrade() {
    await run(async () => {
      if (!feedback || !hand) return;
      const id = `regrade:${++request.current}`;
      const updated = await new Promise<Feedback>((resolve, reject) => {
        const worker = new Worker(
          new URL("./decision.worker.ts", import.meta.url),
          { type: "module" },
        );
        let settled = false;
        const finish = (value?: Feedback, message?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          worker.terminate();
          cancelRegrade.current = null;
          if (value) resolve(value);
          else reject(Error(message ?? "Не удалось пересчитать оценку."));
        };
        const timer = setTimeout(
          () =>
            finish(
              undefined,
              "Расчёт занял слишком много времени. Попробуйте ещё раз.",
            ),
          30000,
        );
        cancelRegrade.current = () => finish(undefined, "Расчёт отменён.");
        worker.onmessage = (event) => {
          if (event.data.id !== id) return;
          finish(event.data.feedback, event.data.error);
        };
        worker.onerror = () => finish();
        worker.postMessage({
          id,
          mode: "grade",
          observation: feedback.observation,
          action: feedback.action,
          total: feedback.total,
          seed:
            (hand.seed ^
              Math.imul(feedback.observation.history.length + 1, 0x9e3779b9) ^
              0x5bd1e995) |
            0,
          samples: 1800,
        });
      });
      if (!live.current) return;
      // Re-evaluate only the saved public decision; never replay its action or
      // consult the cards/actions revealed after it.
      await persist({
        ...session!,
        decisions: session!.decisions.map((record) =>
          record.id === feedback.id ? { ...record, feedback: updated } : record,
        ),
      });
    });
  }
  return (
    <>
      <header className="topbar">
        <button className="back" aria-label="В главное меню" onClick={onBack}>
          ←
        </button>
        <strong>Тренажёр решений</strong>
        <button
          className="settings-button"
          aria-label="Настройки решений"
          onClick={() => setSettingsOpen(true)}
        >
          ⚙
        </button>
      </header>
      {error && (
        <div role="alert" className="error">
          {error}
          <button
            className="text-button"
            onClick={() => {
              setError("");
              setRetry((n) => n + 1);
            }}
          >
            Повторить
          </button>
        </div>
      )}
      {!hand ? (
        <div className="decision-intro">
          <div className="intro-suits">♠ ♣ ♥ ♦</div>
          <h1>Ваш ход.</h1>
          <p>Сыграйте раздачу против ботов и разберите свои решения.</p>
          <button
            className="primary"
            disabled={pending}
            onClick={() => void deal()}
          >
            Получить раздачу
          </button>
          <button className="text-button" onClick={() => setHistoryOpen(true)}>
            История решений
          </button>
        </div>
      ) : (
        <>
          <div className="decision-meta">
            <span>
              {streetNames[feedback?.observation.street ?? hand.street]} · #
              {hand.number}
            </span>
            <span>
              {chips(hand.hand.smallBlind)} / {chips(hand.hand.bigBlind)} · BB
              ante
            </span>
          </div>
          <div className="decision-stage">
            <span>{stageNames[hand.tournamentStage ?? "early"]}</span>
            {hand.tournamentStage && hand.tournamentStage !== "early" && (
              <span>Без реэнтри</span>
            )}
          </div>
          <details className="decision-seats" open>
            <summary>
              Стол · {hand.hand.players.length} игроков
              {view ? " · Вы " + positionLabel(view, hand.heroId) : ""}
            </summary>
            <div className="decision-seat-grid">
              {(feedback?.observation.players ?? hand.hand.players)
                .filter(
                  (p) =>
                    finished || showFolded || !p.folded || p.id === hand.heroId,
                )
                .map((p) => (
                  <div
                    key={p.id}
                    className={
                      "decision-seat " +
                      (p.id === hand.heroId ? "you " : "") +
                      (p.folded ? "folded" : "")
                    }
                  >
                    <span>
                      {p.name}
                      {p.id === hand.heroId ? " · Вы" : ""}
                    </span>
                    <small>
                      {view ? positionLabel(view, p.id) : ""} ·{" "}
                      {(p.stack / hand.hand.bigBlind).toLocaleString("ru-RU", {
                        maximumFractionDigits: 1,
                      })}{" "}
                      BB
                    </small>
                    <b>{chips(p.stack)}</b>
                    {p.id !== hand.heroId && (
                      <small>{profileNames[hand.profiles[p.id]]}</small>
                    )}
                    <small>
                      {p.folded
                        ? "Фолд"
                        : p.allIn
                          ? "Олл-ин"
                          : p.streetCommitted
                            ? "Ставка " + chips(p.streetCommitted)
                            : ""}
                    </small>
                    {finished && <Cards cards={hand.holeCards[p.id]} small />}
                  </div>
                ))}
            </div>
            {!finished &&
              (feedback?.observation.players ?? hand.hand.players).some(
                (p) => p.folded,
              ) && (
                <button
                  className="text-button"
                  onClick={() => setShowFolded((value) => !value)}
                >
                  {showFolded ? "Скрыть фолды" : "Показать фолды"}
                </button>
              )}
          </details>
          {!finished && (
            <div className="decision-recent" aria-label="Последние действия">
              {visibleLogs
                .filter(
                  (log) =>
                    log.street ===
                      (feedback?.observation.street ?? hand.street) &&
                    !["ante", "small-blind", "big-blind"].includes(log.action),
                )
                .slice(-3)
                .map((log, i) => (
                  <span key={i}>
                    {hand.hand.players.find((p) => p.id === log.actorId)?.name}:{" "}
                    {logActionName(log, visibleLogs)}
                    {log.paid ? ` до ${chips(log.total)}` : ""}
                  </span>
                ))}
            </div>
          )}
          <div className="decision-felt">
            <div className="decision-pot">
              Банк <strong>{chips(view?.pot ?? 0)}</strong>
            </div>
            <div className="decision-board">
              {displayedBoard.length ? (
                <Cards cards={displayedBoard} />
              ) : (
                <span className="empty-board">Префлоп</span>
              )}
            </div>
            <div className="hero-hand">
              <span>Ваша рука</span>
              <Cards cards={heroCards} />
            </div>
          </div>
          {feedback ? (
            <div
              className={"decision-feedback grade-" + feedback.feedback.verdict}
              role="status"
            >
              <div className="feedback-heading">
                <span>{verdictNames[feedback.feedback.verdict]}</span>
                <small>
                  {actionName(feedback.action, feedback.observation.currentBet)}
                  {feedback.total ? " до " + chips(feedback.total) : ""}
                </small>
              </div>
              <h2>{feedback.feedback.title}</h2>
              <p>{feedback.feedback.reason}</p>
              <button
                className="primary"
                disabled={pending}
                onClick={() =>
                  void run(() =>
                    persist({ ...session, awaitingFeedback: false }),
                  )
                }
              >
                Продолжить раздачу →
              </button>
              <button
                className="text-button"
                disabled={pending}
                onClick={() => void regrade()}
              >
                {pending ? "Пересчитываем…" : "Пересчитать оценку"}
              </button>
            </div>
          ) : finished ? (
            <div className="decision-finish">
              <h2>Раздача завершена</h2>
              {hero?.stack === 0 &&
                hand.tournamentStage &&
                hand.tournamentStage !== "early" && (
                  <p className="error">
                    Вылет. В этом сценарии реэнтри закрыто.
                  </p>
                )}
              <p>
                {hero
                  ? `Ваш результат: ${hero.stack - hero.startStack >= 0 ? "+" : ""}${chips(hero.stack - hero.startStack)} фишек`
                  : ""}
              </p>
              <p className="hint">
                Результат раздачи не определяет качество решения.
              </p>
              <button
                className="primary"
                disabled={pending}
                onClick={() => void deal()}
              >
                Следующая раздача →
              </button>
              <details open>
                <summary>
                  Разбор ваших решений · {session.decisions.length}
                </summary>
                {session.decisions.map((r, i) => (
                  <div className="decision-review" key={r.id}>
                    <strong>
                      {i + 1}. {streetNames[r.observation.street]} ·{" "}
                      {actionName(r.action, r.observation.currentBet)}
                      {r.total ? " до " + chips(r.total) : ""}
                    </strong>
                    <span
                      className={"review-verdict grade-" + r.feedback.verdict}
                    >
                      {verdictNames[r.feedback.verdict]}
                    </span>
                    <p>{r.feedback.reason}</p>
                  </div>
                ))}
              </details>
            </div>
          ) : (
            <>
              <div className="decision-turn" role="status">
                <strong>
                  {heroTurn
                    ? "Ваше решение"
                    : hero?.folded
                      ? "Соперники доигрывают раздачу"
                      : `Ход: ${actor?.name ?? "соперник"}`}
                </strong>
                <span>
                  {heroTurn && view
                    ? view.toCall > 0
                      ? `Колл ${chips(view.toCall)}`
                      : "Можно чек"
                    : thinking
                      ? "Соперник думает…"
                      : ""}
                </span>
              </div>
              {heroTurn && (
                <>
                  <div className="decision-buttons">
                    <button
                      disabled={!ready || !view?.legalActions.includes("fold")}
                      onClick={() => void choose("fold")}
                    >
                      Фолд
                    </button>
                    <button
                      disabled={!ready || !!view?.toCall}
                      onClick={() => void choose("check")}
                    >
                      Чек
                    </button>
                    <button
                      disabled={!ready || !view?.toCall}
                      onClick={() => void choose("call")}
                    >
                      Колл
                    </button>
                    <button
                      disabled={!ready || !view?.canRaise}
                      onClick={() => {
                        setRaiseOpen(!raiseOpen);
                        if (view)
                          setAmount(
                            String(Math.min(view.maxRaiseTo, view.minRaiseTo)),
                          );
                      }}
                    >
                      {view?.currentBet === 0 ? "Бет" : "Рейз"}
                    </button>
                  </div>
                  {thinking && (
                    <p className="hint" role="status">
                      Подготавливаем разбор…
                    </p>
                  )}
                  {raiseOpen && view && (
                    <div className="decision-raise">
                      <label htmlFor="decision-raise-to">
                        Полная ставка на этой улице
                        <input
                          id="decision-raise-to"
                          inputMode="numeric"
                          value={amount}
                          onChange={(e) => {
                            setAmount(e.target.value);
                            setError("");
                          }}
                        />
                      </label>
                      {view.currentBet === 0 && (
                        <div
                          className="decision-bet-sizes"
                          aria-label="Размер ставки от банка"
                        >
                          {[25, 33, 50, 75, 100].map((percent) => (
                            <button
                              key={percent}
                              disabled={!ready}
                              onClick={() =>
                                setAmount(
                                  String(
                                    Math.min(
                                      view.maxRaiseTo,
                                      Math.max(
                                        view.minRaiseTo,
                                        Math.round((view.pot * percent) / 100),
                                      ),
                                    ),
                                  ),
                                )
                              }
                            >
                              {percent}%
                            </button>
                          ))}
                        </div>
                      )}
                      <button
                        disabled={!ready}
                        onClick={() =>
                          void run(async () => {
                            const total = parseChips(amount);
                            if (!hand || !analysis || !ready) return;
                            const obs = observe(hand, hand.heroId),
                              feedback = gradeDecision(
                                obs,
                                analysis,
                                "raise",
                                total,
                              );
                            const next = applyAction(hand, "raise", total);
                            await persist({
                              ...session,
                              hand: next,
                              awaitingFeedback: true,
                              decisions: [
                                ...session.decisions,
                                {
                                  id: crypto.randomUUID(),
                                  timestamp: Date.now(),
                                  observation: obs,
                                  action: "raise",
                                  total,
                                  feedback,
                                },
                              ],
                            });
                          })
                        }
                      >
                        Поставить
                      </button>
                      <button
                        disabled={!ready}
                        onClick={() => void choose("all-in")}
                      >
                        Олл-ин
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          <details className="decision-log">
            <summary>Ходы · {visibleLogs.length}</summary>
            {visibleLogs.map((log, i) => (
              <div key={i}>
                <p>
                  <small>{streetNames[log.street]}</small> ·{" "}
                  {hand.hand.players.find((p) => p.id === log.actorId)?.name}:{" "}
                  {logActionName(log, visibleLogs)}
                  {log.paid ? ` до ${chips(log.total)}` : ""}
                </p>
                {finished &&
                  "reason" in log &&
                  typeof log.reason === "string" && (
                    <p className="bot-reason">{log.reason}</p>
                  )}
              </div>
            ))}
          </details>
          <div className="decision-links">
            <button
              className="text-button"
              onClick={() => setHistoryOpen(true)}
            >
              История
            </button>
            <button className="text-button" onClick={() => setInfoOpen(true)}>
              Как устроен разбор
            </button>
          </div>
        </>
      )}
      {settingsOpen && (
        <DecisionSettingsPanel
          settings={session.settings}
          onClose={() => setSettingsOpen(false)}
          onSave={(value) =>
            void run(async () => {
              await persist({ ...session, settings: value });
              setSettingsOpen(false);
            })
          }
          onStart={(value) =>
            void run(async () => {
              const number = session.handNumber + 1;
              await persist({
                ...session,
                settings: value,
                handNumber: number,
                hand: newHand(value, number),
                decisions: [],
                awaitingFeedback: false,
              });
              setSettingsOpen(false);
            })
          }
          pending={pending}
          error={error}
        />
      )}
      {historyOpen && (
        <div className="overlay" onClick={() => setHistoryOpen(false)}>
          <div
            className="sheet decision-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="История решений"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-header">
              <h2>История решений</h2>
              <button
                aria-label="Закрыть историю решений"
                onClick={() => setHistoryOpen(false)}
              >
                ×
              </button>
            </div>
            <DecisionHistory />
          </div>
        </div>
      )}
      {infoOpen && (
        <div className="overlay" onClick={() => setInfoOpen(false)}>
          <div
            className="sheet decision-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Как устроен разбор"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-header">
              <h2>Учебный разбор</h2>
              <button
                aria-label="Закрыть описание разбора"
                onClick={() => setInfoOpen(false)}
              >
                ×
              </button>
            </div>
            <p>
              Боты принимают решения по своим картам, общему борду, ставкам и
              стилю игры. Ваши карты им неизвестны.
            </p>
            <p>
              Разбор вашего решения не видит карты соперников и будущий борд. Он
              использует предполагаемые диапазоны, шансы банка и учебные
              правила. Это не GTO и не точный расчёт прибыли.
            </p>
            <p>
              После флопа против одного соперника сравниваются чек, колл и
              конкретные размеры ставок: возможные фолды, коллы и одно ответное
              повышение на текущей улице. Учитывается и защита уязвимой руки.
              Будущие улицы приближённо считаются без новых ставок. Близкие
              варианты, эффективные повышения больше двух банков после колла и
              неподдерживаемые ситуации получают неоднозначную оценку.
            </p>
            <p>
              После раздачи можно раскрыть карты и причины ходов ботов. Проигрыш
              не означает ошибку, а выигрыш — правильное решение.
            </p>
            <p>
              Стадия турнира задаёт глубину стеков и учебную поправку на риск
              вылета. В поздних стадиях колл против покрывающего стека требует
              дополнительной осторожности. Это приближение без расчёта выплат и
              точного ICM; короткий стек по-прежнему может играть агрессивно.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

function DecisionSettingsPanel({
  settings,
  onClose,
  onSave,
  onStart,
  pending,
  error,
}: {
  settings: DecisionSettings;
  onClose: () => void;
  onSave: (s: DecisionSettings) => void;
  onStart: (s: DecisionSettings) => void;
  pending: boolean;
  error: string;
}) {
  const [count, setCount] = useState(settings.playerCount),
    [stack, setStack] = useState(String(settings.startingStack)),
    [random, setRandom] = useState(settings.randomDepth),
    [stage, setStage] = useState<TournamentStage>(
      settings.tournamentStage ?? "early",
    );
  const validStack =
    /^\d+$/.test(stack) &&
    Number(stack) >= 1000 &&
    Number.isSafeInteger(Number(stack));
  const draft: DecisionSettings = {
    ...settings,
    tournamentStage: stage,
    playerCount: count,
    startingStack: validStack ? Number(stack) : settings.startingStack,
    randomDepth: random,
  };
  const disabled = pending || (stage === "early" && !validStack);
  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="sheet decision-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Настройки решений"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <h2>Настройки</h2>
          <button aria-label="Закрыть настройки решений" onClick={onClose}>
            ×
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="decision-settings">
          <label>
            Стадия турнира
            <select
              value={stage}
              onChange={(e) => setStage(e.target.value as TournamentStage)}
            >
              <option value="early">Ранняя стадия</option>
              <option value="middle">Середина · 25–60 BB</option>
              <option value="late">Поздняя · 15–25 BB</option>
              <option value="final">Финальный стол · 10–15 BB</option>
            </select>
          </label>
          <label>
            Игроков
            <select
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            >
              {Array.from({ length: 9 }, (_, i) => (
                <option value={i + 2} key={i}>
                  {i + 2}
                </option>
              ))}
            </select>
          </label>
          {stage === "early" && (
            <label>
              Стартовый стек
              <input
                inputMode="numeric"
                value={stack}
                onChange={(e) => setStack(e.target.value)}
              />
            </label>
          )}
          <label className="decision-switch">
            <input
              type="checkbox"
              checked={random}
              onChange={(e) => setRandom(e.target.checked)}
            />
            Случайная глубина стеков
          </label>
          <p className="hint">
            {stageDepths[stage][random ? "random" : "fixed"]} Глубина до
            блайндов и анте.
            {stage !== "early" &&
              " Без реэнтри. Учёт риска вылета приближённый, без точного ICM."}
          </p>
          <p className="hint">
            Настройки применяются к следующей раздаче. Блайнды 100/200, BB ante
            200.
          </p>
          <button
            className="primary"
            disabled={disabled}
            onClick={() => onSave(draft)}
          >
            Сохранить
          </button>
          <button disabled={disabled} onClick={() => onStart(draft)}>
            Сохранить и начать новую раздачу
          </button>
          <p className="hint">
            Новая раздача заменит текущую. Незавершённая раздача не попадёт в
            историю.
          </p>
        </div>
      </div>
    </div>
  );
}

export function DecisionHistory() {
  const [history, setHistory] = useState<ArchivedTrainingHand[]>([]),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const refresh = () =>
    allArchives()
      .then(setHistory)
      .catch(() => setError("Не удалось прочитать историю."));
  useEffect(() => {
    void refresh();
  }, []);
  const records = history.flatMap((h) => h.decisions);
  return (
    <div className="decision-history">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="decision-history-metrics">
        <span>
          <b>{history.length}</b> раздач
        </span>
        <span>
          <b>{records.length}</b> решений
        </span>
      </div>
      <div className="verdict-counts">
        {Object.entries(verdictNames).map(([key, label]) => (
          <span key={key}>
            {label}: {records.filter((r) => r.feedback.verdict === key).length}
          </span>
        ))}
      </div>
      {history
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 30)
        .map((h) => (
          <details key={h.id}>
            <summary>
              #{h.hand.number} · {stageNames[h.hand.tournamentStage ?? "early"]}{" "}
              · {new Date(h.timestamp).toLocaleDateString("ru-RU")} ·{" "}
              {h.decisions.length} решений
            </summary>
            <div className="archived-cards">
              {h.hand.hand.players.map((p) => (
                <div key={p.id}>
                  <span>
                    {p.name}
                    {p.id === h.hand.heroId ? " · Вы" : ""}
                  </span>
                  <Cards cards={h.hand.holeCards[p.id]} small />
                </div>
              ))}
            </div>
            <Cards cards={h.hand.board} small />
            {h.decisions.map((r) => (
              <div className="decision-review" key={r.id}>
                <strong>
                  {streetNames[r.observation.street]} ·{" "}
                  {actionName(r.action, r.observation.currentBet)} ·{" "}
                  {verdictNames[r.feedback.verdict]}
                </strong>
                <p>{r.feedback.reason}</p>
              </div>
            ))}
          </details>
        ))}
      <div className="decision-links">
        <button
          onClick={() => {
            try {
              const url = URL.createObjectURL(
                new Blob([exportHistory(history)], {
                  type: "application/json",
                }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "poker-decisions.json";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch {
              setError("Не удалось подготовить экспорт.");
            }
          }}
        >
          Экспорт JSON
        </button>
        <label className="button">
          Импорт JSON
          <input
            type="file"
            hidden
            accept="application/json,.json"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                const data = parseHistoryImport(await file.text());
                await importHistory(data);
                await refresh();
                setMessage("История импортирована без повторных записей.");
                setError("");
              } catch {
                setError(
                  "Не удалось импортировать историю. Проверьте формат файла.",
                );
              }
            }}
          />
        </label>
      </div>
    </div>
  );
}
