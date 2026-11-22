import { TablePage } from "./table/TablePage";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useRegisterSW } from "virtual:pwa-register/react";
import { rank, suit } from "./core";
import { categories, generate, type Mode } from "./generator";
import {
  all,
  save,
  clear,
  exportData,
  parseImport,
  importRecords,
  type RecordItem,
} from "./storage";
import "./style.css";
type Result = { equity: number; win: number; tie: number };
const pct = (n: number) => `${n.toFixed(1)}%`;
const ranks = "23456789TJQKA";
const suits = ["♠", "♥", "♦", "♣"];
function App() {
  const [mode, setMode] = useState<Mode>("Mixed");
  const [cards, setCards] = useState(() => generate("Mixed"));
  const [id, setId] = useState(() => crypto.randomUUID());
  const [input, setInput] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState<"home" | "train" | "stats" | "table">(
    "home",
  );
  const [settings, setSettings] = useState<"general" | "trainer" | null>(null);
  const [theme, setTheme] = useState(
    () => localStorage.getItem("theme") || "forest",
  );
  const [history, setHistory] = useState<RecordItem[]>([]);
  const [n, setN] = useState(() => {
    const v = Number(localStorage.getItem("simulations"));
    return [10000, 50000, 100000].includes(v) ? v : 50000;
  });
  const worker = useRef<Worker | null>(null);
  const locked = useRef(false);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);
  const refresh = () =>
    all()
      .then(setHistory)
      .catch(() => setError("Не удалось прочитать историю."));
  useEffect(() => {
    void refresh();
    return () => worker.current?.terminate();
  }, []);
  function next(m = mode) {
    worker.current?.terminate();
    worker.current = null;
    locked.current = false;
    setBusy(false);
    setMode(m);
    setCards(generate(m));
    setId(crypto.randomUUID());
    setInput("");
    setResult(null);
    setError("");
  }
  function check() {
    if (locked.current) return;
    const normalized = input.trim().replace(",", ".");
    if (!/^\d+(?:\.\d+)?$/.test(normalized) || Number(normalized) > 100) {
      setError("Введите число от 0 до 100.");
      return;
    }
    locked.current = true;
    setBusy(true);
    setError("");
    const w = new Worker(new URL("./equity.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    const task = id;
    w.onmessage = async (e) => {
      if (worker.current !== w || e.data.id !== task) return;
      if (e.data.error) {
        setError("Ошибка расчёта. Попробуйте ещё раз.");
        locked.current = false;
        setBusy(false);
        w.terminate();
        return;
      }
      const r = e.data.result as Result;
      const answer = Number(normalized);
      const signed = answer - r.equity * 100;
      try {
        await save({
          id: task,
          timestamp: Date.now(),
          mode,
          cards,
          answer,
          ...r,
          simulations: n,
          signed,
          absolute: Math.abs(signed),
          categories: categories(cards),
        });
        if (worker.current !== w) return;
        setResult(r);
        void refresh();
      } catch {
        if (worker.current === w) {
          setError(
            "Не удалось сохранить ответ. Проверьте доступность хранилища.",
          );
          locked.current = false;
        }
      }
      if (worker.current === w) setBusy(false);
      w.terminate();
    };
    w.onerror = () => {
      if (worker.current === w) {
        setError("Ошибка Worker.");
        locked.current = false;
        setBusy(false);
      }
      w.terminate();
    };
    w.postMessage({
      cards,
      n,
      id: task,
      seed: crypto.getRandomValues(new Uint32Array(1))[0],
    });
  }
  const mean = (items: RecordItem[], f: (r: RecordItem) => number) =>
    items.length ? items.reduce((a, r) => a + f(r), 0) / items.length : 0;
  const sorted = [...history].sort((a, b) => b.timestamp - a.timestamp);
  const labels = [...new Set(history.flatMap((r) => r.categories))];
  return (
    <main>
      {page === "table" ? (
        <TablePage onBack={() => setPage("home")} />
      ) : (
        <>
          <header className="topbar">
            {page === "home" ? (
              <div className="brand">
                POKER <span>TRAINER</span>
              </div>
            ) : (
              <button
                className="back"
                onClick={() => {
                  setPage("home");
                  setSettings(null);
                  setError("");
                }}
                aria-label="В главное меню"
              >
                ←
              </button>
            )}
            <button
              className="settings-button"
              aria-label={
                page === "home" ? "Общие настройки" : "Настройки тренажёра"
              }
              onClick={() =>
                setSettings(page === "home" ? "general" : "trainer")
              }
            >
              ⚙
            </button>
          </header>
          {needRefresh && (
            <aside>
              Доступна новая версия.{" "}
              <button onClick={() => void updateServiceWorker(true)}>
                Обновить
              </button>
            </aside>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {page === "home" ? (
            <div className="home">
              <button className="trainer-link" onClick={() => setPage("train")}>
                <span className="trainer-icon">♠</span>
                <span className="trainer-copy">
                  <strong>Префлоп дуэль</strong>
                </span>
                <span className="arrow">↗</span>
              </button>
              <button className="trainer-link" onClick={() => setPage("table")}>
                <span className="trainer-icon">▦</span>
                <span className="trainer-copy">
                  <strong>Префлоп · стол</strong>
                </span>
                <span className="arrow">↗</span>
              </button>
              <button
                className="trainer-link stats-link"
                onClick={() => setPage("stats")}
              >
                <span className="trainer-icon">▥</span>
                <span className="trainer-copy">
                  <strong>Статистика</strong>
                </span>
                <span className="arrow">↗</span>
              </button>
            </div>
          ) : page === "train" ? (
            <div className="training">
              <div className="page-heading">
                <h1>
                  Префлоп <em>дуэль</em>
                </h1>
              </div>
              <div className="table">
                <div className="hands">
                  {["ВАША РУКА", "СОПЕРНИК"].map((name, i) => (
                    <div className="hand" key={name}>
                      <div className="hand-label">
                        <span className={i === 0 ? "dot" : ""}></span>
                        {name}
                      </div>
                      <div className="cards">
                        {cards.slice(i * 2, i * 2 + 2).map((c) => (
                          <div
                            key={c}
                            className={
                              "card " + ([1, 2].includes(suit(c)) ? "red" : "")
                            }
                          >
                            <span className="card-corner">
                              <b>{ranks[rank(c) - 2]}</b>
                              <small>{suits[suit(c)]}</small>
                            </span>
                            <span className="card-suit">{suits[suit(c)]}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="versus">VS</div>
              </div>
              <div className="answer-area">
                <label className="answer" htmlFor="answer">
                  ВАША ОЦЕНКА EQUITY
                </label>
                <div className="input-wrap">
                  <input
                    id="answer"
                    type="text"
                    inputMode="decimal"
                    placeholder="0"
                    value={input}
                    disabled={busy || !!result}
                    onChange={(e) => setInput(e.target.value)}
                  />
                  <span>%</span>
                </div>
                {!result ? (
                  <button className="primary" disabled={busy} onClick={check}>
                    {busy ? "Считаем…" : "Проверить"} <span>→</span>
                  </button>
                ) : (
                  <div className="result">
                    <div className="equity">
                      {pct(result.equity * 100)}{" "}
                      <small>equity вашей руки</small>
                    </div>
                    <div className="row result-row">
                      <span>
                        Победа <b>{pct(result.win * 100)}</b>
                      </span>
                      <span>
                        Ничья <b>{pct(result.tie * 100)}</b>
                      </span>
                    </div>
                    <p>
                      Ошибка:{" "}
                      {Number(input.replace(",", ".")) - result.equity * 100 >=
                      0
                        ? "+"
                        : ""}
                      {(
                        Number(input.replace(",", ".")) -
                        result.equity * 100
                      ).toFixed(1)}{" "}
                      п.п. · абсолютная{" "}
                      {Math.abs(
                        Number(input.replace(",", ".")) - result.equity * 100,
                      ).toFixed(1)}{" "}
                      п.п.
                    </p>
                    <button className="primary" onClick={() => next()}>
                      Следующая задача <span>→</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
              <section>
                <h2>Ваши результаты</h2>
                <div className="metrics">
                  <div>
                    <b>{history.length}</b>
                    <span>задач</span>
                  </div>
                  <div>
                    <b>{mean(history, (r) => r.absolute).toFixed(1)}</b>
                    <span>средняя ошибка, п.п.</span>
                  </div>
                  <div>
                    <b>
                      {pct(mean(history, (r) => Number(r.absolute <= 3)) * 100)}
                    </b>
                    <span>в пределах 3 п.п.</span>
                  </div>
                  <div>
                    <b>
                      {pct(mean(history, (r) => Number(r.absolute <= 5)) * 100)}
                    </b>
                    <span>в пределах 5 п.п.</span>
                  </div>
                  <div>
                    <b>{mean(history, (r) => r.signed).toFixed(1)}</b>
                    <span>средняя ошибка со знаком</span>
                  </div>
                </div>
                <h3>По категориям</h3>
                {labels.length ? (
                  labels.map((l) => {
                    const list = history.filter((r) =>
                      r.categories.includes(l),
                    );
                    return (
                      <p key={l}>
                        {l}: {list.length} ·{" "}
                        {mean(list, (r) => r.absolute).toFixed(1)} п.п.
                      </p>
                    );
                  })
                ) : (
                  <p>Пока нет ответов.</p>
                )}
                <h3>Последние ответы</h3>
                {sorted.slice(0, 10).map((r) => (
                  <p key={r.id}>
                    {new Date(r.timestamp).toLocaleDateString("ru")} ·{" "}
                    {r.cards
                      .map((c) => ranks[rank(c) - 2] + suits[suit(c)])
                      .join(" ")}{" "}
                    · {r.answer}% → {pct(r.equity * 100)} ·{" "}
                    {r.signed >= 0 ? "+" : ""}
                    {r.signed.toFixed(1)} п.п.
                  </p>
                ))}
              </section>
              <section>
                <h2>Данные</h2>
                <div className="actions">
                  <button
                    onClick={() => {
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(
                        new Blob([exportData(history, n)], {
                          type: "application/json",
                        }),
                      );
                      a.download = "poker-trainer.json";
                      a.click();
                      URL.revokeObjectURL(a.href);
                    }}
                  >
                    Экспорт JSON
                  </button>
                  <label className="button">
                    Импорт JSON
                    <input
                      type="file"
                      accept="application/json,.json"
                      hidden
                      onChange={async (e) => {
                        try {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          const d = parseImport(await f.text());
                          await importRecords(d.history);
                          setN(d.settings.simulations);
                          localStorage.setItem(
                            "simulations",
                            String(d.settings.simulations),
                          );
                          await refresh();
                          setError("");
                        } catch {
                          setError(
                            "Не удалось импортировать: проверьте файл и его версию.",
                          );
                        } finally {
                          e.target.value = "";
                        }
                      }}
                    />
                  </label>
                  <button
                    onClick={async () => {
                      if (confirm("Удалить всю историю?")) {
                        try {
                          await clear();
                          await refresh();
                        } catch {
                          setError("Не удалось очистить историю.");
                        }
                      }
                    }}
                  >
                    Очистить историю
                  </button>
                </div>
                <p className="hint">
                  История хранится на этом устройстве. Очистка данных Safari или
                  освобождение места могут её удалить.
                </p>
              </section>
            </>
          )}
          {settings && (
            <div className="overlay" onClick={() => setSettings(null)}>
              <div
                className="sheet"
                role="dialog"
                aria-modal="true"
                aria-label={
                  settings === "general"
                    ? "Общие настройки"
                    : "Настройки тренажёра"
                }
                onClick={(e) => e.stopPropagation()}
              >
                <div className="sheet-header">
                  <div>
                    <div className="eyebrow">НАСТРОЙКИ</div>
                    <h2>
                      {settings === "general" ? "Оформление" : "Префлоп дуэль"}
                    </h2>
                  </div>
                  <button
                    className="close"
                    aria-label="Закрыть настройки"
                    onClick={() => setSettings(null)}
                  >
                    ×
                  </button>
                </div>
                {settings === "general" ? (
                  <>
                    <p className="muted">Выберите цвета приложения</p>
                    <div className="themes">
                      {[
                        ["forest", "Лес", "♠"],
                        ["midnight", "Ночь", "♣"],
                        ["light", "Свет", "♦"],
                      ].map(([value, label, icon]) => (
                        <button
                          key={value}
                          className={
                            "theme-option " +
                            (theme === value ? "selected" : "")
                          }
                          onClick={() => setTheme(value)}
                        >
                          <span className={"swatch " + value}>{icon}</span>
                          <span>{label}</span>
                          {theme === value && (
                            <span className="checkmark">✓</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="settings-fields">
                    <label>
                      Режим
                      <select
                        value={mode}
                        disabled={busy}
                        onChange={(e) => next(e.target.value as Mode)}
                      >
                        <option value="Mixed">Смешанный</option>
                        <option value="Random">Случайный</option>
                        <option value="Balanced">Сбалансированный</option>
                      </select>
                    </label>
                    <p className="hint">
                      При смене режима начнётся новая задача.
                    </p>
                    <label>
                      Число симуляций
                      <select
                        disabled={busy || !!result}
                        value={n}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setN(v);
                          localStorage.setItem("simulations", String(v));
                        }}
                      >
                        <option value={10000}>10 000</option>
                        <option value={50000}>50 000</option>
                        <option value={100000}>100 000</option>
                      </select>
                    </label>
                  </div>
                )}
                <button className="primary" onClick={() => setSettings(null)}>
                  Готово
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
