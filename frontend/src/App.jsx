import { useEffect, useRef, useState } from "react";
import "./index.css";

const API_URL = import.meta.env.VITE_API_URL;
const DECK = ["1", "2", "3", "5", "8", "13", "21", "?"];
const POLL_MS = 1500;
const IDLE_MS = 10 * 60 * 1000;
// Deliberate interaction only - no mousemove/scroll, those fire just from switching back to the tab.
const ACTIVITY_EVENTS = ["mousedown", "keydown", "touchstart"];

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

    async function heartbeat() {
      // Interval keeps ticking while idle, this just skips the network call until activity resumes.
      if (Date.now() - lastActivity.current > IDLE_MS) return;
      const state = await api("/join", { clientId: clientId.current, name });
      if (!cancelled) setSession(state);
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

  async function handleVote(value) {
    const state = await api("/vote", { clientId: clientId.current, vote: value });
    setSession(state);
  }

  async function handleStorySubmit(e) {
    e.preventDefault();
    const state = await api("/setStory", { story: storyDraft });
    setSession(state);
  }

  async function handleReveal() {
    const state = await api("/reveal", {});
    setSession(state);
  }

  async function handleNewRound() {
    const state = await api("/newRound", {});
    setSession(state);
  }

  if (!joined) {
    return (
      <main className="join-screen">
        <h1>Planning Poker</h1>
        <form onSubmit={handleJoin}>
          <input
            autoFocus
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit">Join</button>
        </form>
      </main>
    );
  }

  const myVote = session.participants[clientId.current]?.vote;

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

      <div className="deck">
        {DECK.map((value) => (
          <button
            key={value}
            className={myVote === value ? "card selected" : "card"}
            onClick={() => handleVote(value)}
          >
            {value}
          </button>
        ))}
      </div>

      <div className="controls">
        <button onClick={handleReveal}>Reveal</button>
        <button onClick={handleNewRound}>New round</button>
      </div>

      <ul className="participants">
        {Object.entries(session.participants)
          .sort(([, a], [, b]) => a.name.localeCompare(b.name))
          .map(([id, p]) => (
          <li key={id}>
            <span>{p.name}</span>
            <span>
              {session.revealed ? (p.vote ?? "—") : p.voted ? "✓" : "…"}
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
