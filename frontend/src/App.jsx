import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./index.css";

const API_URL = import.meta.env.VITE_API_URL;
const DECK = ["1", "2", "3", "5", "8", "13", "21", "?"];
const CHIPS = [10, 20, 50, 100];
const POLL_MS = 1500;
const IDLE_MS = 10 * 60 * 1000;
// Deliberate interaction only - no mousemove/scroll, those fire just from switching back to the tab.
const ACTIVITY_EVENTS = ["mousedown", "keydown", "touchstart"];

const rank = (vote) => (vote == null ? DECK.length : DECK.indexOf(vote));

function getClientId() {
  let id = sessionStorage.getItem("clientId");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("clientId", id);
  }
  return id;
}

async function api(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export default function App() {
  const clientId = useRef(getClientId());
  const [name, setName] = useState(sessionStorage.getItem("name") || "");
  const [joined, setJoined] = useState(!!sessionStorage.getItem("name"));
  const [session, setSession] = useState({ story: "", revealed: false, participants: {} });
  const [storyDraft, setStoryDraft] = useState("");
  const lastActivity = useRef(Date.now());
  const syncs = useRef(0);
  const wasRevealed = useRef(false);

  // Cards fly from each person's roster card to their spot on the table (FLIP).
  useLayoutEffect(() => {
    const was = wasRevealed.current;
    wasRevealed.current = session.revealed;
    // syncs < 2: first poll after load, so a round that was already revealed doesn't replay.
    if (!session.revealed || was || syncs.current < 2) return;
    document.querySelectorAll(".table-card").forEach((card, n) => {
      const dot = document.querySelector(`.roster [data-id="${card.dataset.id}"] .dot`);
      if (!dot) return;
      const from = dot.getBoundingClientRect();
      const to = card.querySelector(".face").getBoundingClientRect();
      const dx = from.left + from.width / 2 - (to.left + to.width / 2);
      const dy = from.top + from.height / 2 - (to.top + to.height / 2);
      const timing = { duration: 750, delay: n * 90, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
      card.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(0.35) rotate(-20deg)`, opacity: 1 },
          { transform: `translate(${dx * 0.3}px, ${dy * 0.3 - 40}px) scale(0.85) rotate(8deg)`, opacity: 1, offset: 0.6 },
          { transform: "none", opacity: 1 },
        ],
        { ...timing, fill: "backwards" }
      );
    });
  }, [session.revealed]);

  useEffect(() => {
    function markActive() {
      lastActivity.current = Date.now();
    }
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, markActive, { passive: true }));
    return () => ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, markActive));
  }, []);

  useEffect(() => {
    if (!joined) return;
    let cancelled = false;

    let inFlight = false;
    let failures = 0;
    let retryAt = 0;
    async function heartbeat() {
      // Interval keeps ticking while idle, this just skips the network call until activity resumes.
      // inFlight: a slow request (cold start) must not let polls stack up behind it.
      // retryAt: after errors (network down, backend erroring) back off 3s, 6s, then 8s instead of hammering at 1.5s (capped below STALE_MS so a blip doesn't drop us from the room).
      if (inFlight || Date.now() < retryAt || Date.now() - lastActivity.current > IDLE_MS) return;
      inFlight = true;
      try {
        const state = await api("/join", { clientId: clientId.current, name });
        if (!state.participants) throw new Error(state.error || "bad response");
        failures = 0;
        if (!cancelled) {
          syncs.current++;
          setSession(state);
        }
      } catch {
        failures++;
        retryAt = Date.now() + Math.min(8000, POLL_MS * 2 ** failures);
      } finally {
        inFlight = false;
      }
    }

    heartbeat();
    const interval = setInterval(heartbeat, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [joined, name]);

  useEffect(() => {
    setStoryDraft(session.story);
  }, [session.story]);

  function handleJoin(e) {
    e.preventDefault();
    if (!name.trim()) return;
    sessionStorage.setItem("name", name.trim());
    setName(name.trim());
    setJoined(true);
  }

  // Every action returns the new state. An error body ({error: "busy"}) has no participants and must not replace it.
  async function act(path, body) {
    try {
      const state = await api(path, body);
      if (state.participants) setSession(state);
    } catch {
      // network blip: the next poll resyncs
    }
  }

  const handleVote = (vote) => act("/vote", { clientId: clientId.current, vote });
  const handleBet = (bet) => act("/bet", { clientId: clientId.current, bet });
  const handleStorySubmit = (e) => {
    e.preventDefault();
    return act("/setStory", { story: storyDraft });
  };
  const handleReveal = () => act("/reveal", {});
  const handleNewRound = () => act("/newRound", {});

  if (!joined) {
    return (
      <main className="join-screen">
        <h1>Planning Poker</h1>
        <form onSubmit={handleJoin}>
          <input
            autoFocus
            placeholder="Your name"
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit">Join</button>
        </form>
      </main>
    );
  }

  const me = session.participants[clientId.current];
  const myVote = me?.vote;
  const myChips = me?.chips ?? 0;
  const myBet = me?.bet ?? 0;

  const votes = Object.values(session.participants).map((p) => p.vote).filter((v) => v != null);
  const numeric = votes.filter((v) => v !== "?").map(Number);
  const average = numeric.length ? (numeric.reduce((a, b) => a + b, 0) / numeric.length).toFixed(1) : null;
  const consensus = votes.length > 1 && votes.every((v) => v === votes[0]);

  const people = Object.entries(session.participants).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  // Lowest to highest ("?" last); ties by name. Only used once revealed.
  const revealed = people.filter(([, p]) => p.vote != null).sort(([, a], [, b]) => rank(a.vote) - rank(b.vote));

  return (
    <main className="board">
      <h1>Planning Poker</h1>

      <form className="story-form" onSubmit={handleStorySubmit}>
        <input
          placeholder="What are we estimating?"
          value={storyDraft}
          onChange={(e) => setStoryDraft(e.target.value)}
        />
        <button type="submit">Set story</button>
      </form>

      <div className="layout">
        <div className="side">
        <ul className="roster">
          {people.map(([id, p]) => (
            <li key={id} data-id={id} className={session.revealed ? "" : p.voted ? "voted" : "waiting"}>
              <span className="dot" />
              <span className="roster-name">{p.name}</span>
              <span className="chips">{p.chips}</span>
            </li>
          ))}
        </ul>

        {people.length > 1 && (
          <div className="standings">
            <h2>Standings</h2>
            <ol>
              {[...people]
                .sort(([, a], [, b]) => b.chips - a.chips || a.name.localeCompare(b.name))
                .map(([id, p]) => (
                  <li key={id}>
                    <span className="roster-name">{p.name}</span>
                    <span className="chips">{p.chips}</span>
                  </li>
                ))}
            </ol>
          </div>
        )}
        </div>

        <div className="center">
          <div className="table">
            {session.revealed ? (
              revealed.map(([id, p]) => (
                <div key={id} data-id={id} className="table-card">
                  <div className="face">{p.vote}</div>
                  <span className="name">{p.name}</span>
                  {p.delta !== 0 && <span className={p.delta > 0 ? "delta win" : "delta lose"}>{p.delta > 0 ? "+" : ""}{p.delta}</span>}
                </div>
              ))
            ) : (
              <p className="hint">{people.filter(([, p]) => p.voted).length} of {people.length} voted</p>
            )}
          </div>

          {session.revealed && average && (
            <p className="summary">
              {consensus ? "Consensus" : "Average"} <strong>{consensus ? votes[0] : average}</strong>
            </p>
          )}

          <div className="controls">
            <button className="primary" onClick={handleReveal}>Reveal</button>
            <button className="ghost" onClick={handleNewRound}>New round</button>
          </div>

          <div className="bet">
            <span className="bet-label">Bet <strong>{myBet}</strong> of {myChips}</span>
            {CHIPS.map((v) => (
              <button
                key={v}
                className={`chip c${v}`}
                disabled={session.revealed || myBet + v > myChips}
                onClick={() => handleBet(myBet + v)}
              >
                {v}
              </button>
            ))}
            <button className="ghost" disabled={session.revealed || !myBet} onClick={() => handleBet(0)}>Clear</button>
          </div>

          <div className="deck">
            {DECK.map((value, i) => (
              <button
                key={value}
                className={myVote === value ? "card selected" : "card"}
                style={{ "--i": i - (DECK.length - 1) / 2 }}
                onClick={() => handleVote(value)}
              >
                <span className="corner">{value}</span>
                <span className="face">{value}</span>
                <span className="corner br">{value}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
