import json
import os
import random
import time
from collections import Counter

import boto3
from botocore.exceptions import ClientError

TABLE = os.environ["TABLE_NAME"]
PK = "SESSION"
STALE_MS = 10_000  # frontend polls every 1.5s; this tolerates a few missed polls before dropping someone
START_CHIPS = 200
WALLET_TTL_S = 2 * 60 * 60  # idle wallets are deleted by DynamoDB TTL; refreshed on join and on settlement
MAX_NAME = 40  # /join is unauthenticated: bound what one request can add to the 400KB item
MAX_PLAYERS = 30
MAX_STORY = 200
VOTES = {"1", "2", "3", "5", "8", "13", "21", "?"}  # keep in sync with DECK in frontend/src/App.jsx

table = boto3.resource("dynamodb").Table(TABLE)


# Wallet writes queued by mutate; run only after the session write commits, so a lost-race retry doesn't repeat them.
AFTER = []


def later(fn, *args):
    AFTER.append((fn, args))


def wallet_key(name):
    return "WALLET#" + name.strip().lower()[:40]


def conditional_failed(e):
    return e.response["Error"]["Code"] == "ConditionalCheckFailedException"


def save_wallet(name, chips):
    # update (not put) so the player's saved pending vote/bet survives
    table.update_item(
        Key={"pk": wallet_key(name)},
        UpdateExpression="SET chips = :c, expires_at = :e",
        ExpressionAttributeValues={":c": chips, ":e": int(time.time()) + WALLET_TTL_S},
    )


def save_pending(session, p):
    """Remember this round's vote and bet by name, so a tab pruned for idling gets them back on rejoin."""
    try:
        table.update_item(
            Key={"pk": wallet_key(p["name"])},
            UpdateExpression="SET pending = :p",
            ConditionExpression="attribute_exists(pk)",
            ExpressionAttributeValues={":p": {"round": session.get("round", 0), "vote": p["vote"], "bet": p["bet"]}},
        )
    except ClientError as e:
        if not conditional_failed(e):
            raise


def load_wallet(name):
    item = table.get_item(Key={"pk": wallet_key(name)}).get("Item")
    # TTL deletion can lag by hours, so an expired-but-present item counts as missing.
    alive = item and item["expires_at"] > time.time()
    chips = (int(item["chips"]) if alive else 0) or START_CHIPS  # broke players are topped up
    # Skip the write unless something changed or the TTL is past half-way, so a flaky tab rejoining doesn't cost a put each time.
    if not alive or int(item["chips"]) != chips or float(item["expires_at"]) - time.time() < WALLET_TTL_S / 2:
        later(save_wallet, name, chips)
    return chips, (item.get("pending") if alive else None)


def empty_session():
    return {"pk": PK, "story": "", "revealed": False, "participants": {}}


def get_session():
    res = table.get_item(Key={"pk": PK})
    return res.get("Item") or empty_session()


def put_session(session):
    # Optimistic lock: every request reads then rewrites the whole item, so without this an overlapping poll
    # silently overwrites a vote or a reveal. Raises ConditionalCheckFailed if someone wrote since our read.
    seen = session.get("version", 0)
    session["version"] = seen + 1
    table.put_item(
        Item=session,
        ConditionExpression="attribute_not_exists(version) OR version = :seen",
        ExpressionAttributeValues={":seen": seen},
    )
    return session


def fingerprint(session):
    """State minus lastSeen, to tell whether a request changed anything. default=int: DynamoDB numbers are Decimals."""
    people = {c: {k: v for k, v in p.items() if k != "lastSeen"} for c, p in session["participants"].items()}
    return json.dumps({**session, "participants": people}, sort_keys=True, default=int)


def prune_stale(session):
    now = int(time.time() * 1000)
    session["participants"] = {
        cid: p for cid, p in session["participants"].items() if now - p["lastSeen"] <= STALE_MS
    }
    return session


def to_public(session, viewer_id=None):
    participants = {}
    for cid, p in session["participants"].items():
        # Hide other people's votes and bets until reveal, but let viewers see their own so the UI can highlight them.
        pub = {"name": p["name"], "voted": p["vote"] is not None, "chips": int(p.get("chips", 0))}
        if session["revealed"] or cid == viewer_id:
            pub.update(vote=p["vote"], bet=int(p.get("bet", 0)))
        if session["revealed"]:
            pub["delta"] = int(p.get("delta", 0))
        participants[cid] = pub
    return {"story": session["story"], "revealed": session["revealed"], "participants": participants}


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }


def noop(session, body):
    pass  # GET /state still goes through the same save step, so pruned participants persist


def do_join(session, body):
    cid, name = body["clientId"], body["name"].strip()[:MAX_NAME]
    existing = session["participants"].get(cid, {})
    if not name or len(cid) > 64 or (not existing and len(session["participants"]) >= MAX_PLAYERS):
        raise ValueError("bad join")
    chips, pending = (existing["chips"], None) if "chips" in existing else load_wallet(name)
    restored = {}
    if pending and pending["round"] == session.get("round", 0) and not session["revealed"]:
        restored = {"vote": pending["vote"], "bet": min(int(pending["bet"]), chips)}
    session["participants"][cid] = {
        "vote": None,
        "bet": 0,
        "delta": 0,
        **restored,
        **existing,
        "name": name,
        "lastSeen": int(time.time() * 1000),
        "chips": chips,
    }


def do_set_story(session, body):
    session["story"] = str(body.get("story", ""))[:MAX_STORY]


def do_vote(session, body):
    if body["clientId"] in session["participants"]:
        vote = body.get("vote")
        if vote is not None and vote not in VOTES:
            raise ValueError("bad vote")
        p = session["participants"][body["clientId"]]
        if p["vote"] != vote:  # a repeated identical click costs no wallet write
            p["vote"] = vote
            later(save_pending, session, p)


def do_bet(session, body):
    p = session["participants"].get(body["clientId"])
    bet = int(body.get("bet", 0))
    if p and not session["revealed"] and bet % 10 == 0 and 0 <= bet <= p["chips"]:
        if p["bet"] != bet:
            p["bet"] = bet
            later(save_pending, session, p)


def do_reveal(session, body):
    if session["revealed"]:
        return  # settle once
    session["revealed"] = True
    # Consensus = strict most-common vote, at least 2 people. A tie or all-different means no consensus: bets are returned.
    top = Counter(p["vote"] for p in session["participants"].values() if p["vote"] is not None).most_common(2)
    winner = top[0][0] if top and top[0][1] >= 2 and (len(top) == 1 or top[0][1] > top[1][1]) else None
    for p in session["participants"].values():
        p["delta"] = 0
        if winner is not None and p["bet"] and p["vote"] is not None:
            p["delta"] = p["bet"] if p["vote"] == winner else -p["bet"]
            p["chips"] += p["delta"]
            later(save_wallet, p["name"], int(p["chips"]))


def do_new_round(session, body):
    session["round"] = session.get("round", 0) + 1  # invalidates every saved pending vote/bet
    session["story"] = ""
    session["revealed"] = False
    for p in session["participants"].values():
        p["vote"] = None
        p["bet"] = 0
        p["delta"] = 0
        if p["chips"] <= 0:
            p["chips"] = START_CHIPS
            later(save_wallet, p["name"], START_CHIPS)


ROUTES = {
    ("GET", "/state"): noop,
    ("POST", "/join"): do_join,
    ("POST", "/setStory"): do_set_story,
    ("POST", "/vote"): do_vote,
    ("POST", "/bet"): do_bet,
    ("POST", "/reveal"): do_reveal,
    ("POST", "/newRound"): do_new_round,
}


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("requestContext", {}).get("http", {}).get("path", "/")
    body = json.loads(event["body"]) if event.get("body") else {}

    mutate = ROUTES.get((method, path))
    if mutate is None:
        return response(404, {"error": "not found"})

    for attempt in range(3):  # re-read and re-apply if another request wrote first
        AFTER.clear()
        raw = get_session()
        before = fingerprint(raw)
        session = prune_stale(raw)
        prev_seen = session["participants"].get(body.get("clientId"), {}).get("lastSeen")
        try:
            mutate(session, body)
        except (KeyError, ValueError, TypeError, AttributeError):  # malformed body: reject instead of a 500
            return response(400, {"error": "bad request"})
        # Most polls change nothing but lastSeen. Skip the write (and the version bump other requests collide on)
        # unless state changed or this player's presence is due a refresh well inside STALE_MS.
        due = prev_seen is not None and time.time() * 1000 - float(prev_seen) > STALE_MS * random.uniform(0.35, 0.5)  # jittered so polls don't all bump version together
        if fingerprint(session) != before or due:
            try:
                put_session(session)
            except ClientError as e:
                if not conditional_failed(e):
                    raise
                time.sleep(random.uniform(0, 0.05 * (attempt + 1)))
                continue
        for fn, args in AFTER:
            fn(*args)
        return response(200, to_public(session, viewer_id=body.get("clientId")))
    return response(409, {"error": "busy"})
