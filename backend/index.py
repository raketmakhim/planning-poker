import json
import os
import time

import boto3

TABLE = os.environ["TABLE_NAME"]
PK = "SESSION"
STALE_MS = 10_000

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


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("requestContext", {}).get("http", {}).get("path", "/")
    body = json.loads(event["body"]) if event.get("body") else {}

    if method == "GET" and path == "/state":
        session = prune_stale(get_session())
        return response(200, to_public(session))

    if method == "POST" and path == "/join":
        session = prune_stale(get_session())
        existing = session["participants"].get(body["clientId"])
        session["participants"][body["clientId"]] = {
            "name": body["name"],
            "vote": existing["vote"] if existing else None,
            "lastSeen": int(time.time() * 1000),
        }
        put_session(session)
        return response(200, to_public(session))

    if method == "POST" and path == "/setStory":
        session = prune_stale(get_session())
        session["story"] = body.get("story", "")
        put_session(session)
        return response(200, to_public(session))

    if method == "POST" and path == "/vote":
        session = prune_stale(get_session())
        if body["clientId"] in session["participants"]:
            session["participants"][body["clientId"]]["vote"] = body.get("vote")
        put_session(session)
        return response(200, to_public(session))

    if method == "POST" and path == "/reveal":
        session = prune_stale(get_session())
        session["revealed"] = True
        put_session(session)
        return response(200, to_public(session))

    if method == "POST" and path == "/newRound":
        session = prune_stale(get_session())
        session["story"] = ""
        session["revealed"] = False
        for p in session["participants"].values():
            p["vote"] = None
        put_session(session)
        return response(200, to_public(session))

    return response(404, {"error": "not found"})
