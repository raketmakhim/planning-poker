import json
import os
import time

import boto3

TABLE = os.environ["TABLE_NAME"]
PK = "SESSION"
STALE_MS = 10_000  # frontend polls every 1.5s; this tolerates a few missed polls before dropping someone

table = boto3.resource("dynamodb").Table(TABLE)


def empty_session():
    return {"pk": PK, "story": "", "revealed": False, "participants": {}}


def get_session():
    res = table.get_item(Key={"pk": PK})
    return res.get("Item") or empty_session()


def put_session(session):
    table.put_item(Item=session)
    return session


def prune_stale(session):
    now = int(time.time() * 1000)
    session["participants"] = {
        cid: p for cid, p in session["participants"].items() if now - p["lastSeen"] <= STALE_MS
    }
    return session


def to_public(session):
    participants = {}
    for cid, p in session["participants"].items():
        if session["revealed"]:
            participants[cid] = {"name": p["name"], "voted": p["vote"] is not None, "vote": p["vote"]}
        else:
            participants[cid] = {"name": p["name"], "voted": p["vote"] is not None}
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
    existing = session["participants"].get(body["clientId"])
    session["participants"][body["clientId"]] = {
        "name": body["name"],
        "vote": existing["vote"] if existing else None,
        "lastSeen": int(time.time() * 1000),
    }


def do_set_story(session, body):
    session["story"] = body.get("story", "")


def do_vote(session, body):
    if body["clientId"] in session["participants"]:
        session["participants"][body["clientId"]]["vote"] = body.get("vote")


def do_reveal(session, body):
    session["revealed"] = True


def do_new_round(session, body):
    session["story"] = ""
    session["revealed"] = False
    for p in session["participants"].values():
        p["vote"] = None


ROUTES = {
    ("GET", "/state"): noop,
    ("POST", "/join"): do_join,
    ("POST", "/setStory"): do_set_story,
    ("POST", "/vote"): do_vote,
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

    session = prune_stale(get_session())
    mutate(session, body)
    put_session(session)
    return response(200, to_public(session))
