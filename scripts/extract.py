#!/usr/bin/env python3
"""Yesterday's Claude Code sessions as prose, one block per session, for the morning report.

  extract.py --projects DIR --since ISO --until ISO [--session-logs DIR]

Prints JSON: {"sessions": [{"id", "project", "start", "end", "typed", "active_minutes", "text"}],
"active_minutes": <all sessions, overlaps counted once>, "projects": [{"project", "active_minutes"}]}.
Keeps what the person typed (including prompts queued mid-turn), the agent's prose, and each
subagent's task and final report; drops tool calls and results. Headless sessions (`claude -p`,
the SDK) are dropped whole; in a session where /morning-review, /morning-run or /morning-setup was
typed, everything from that entry on is dropped. The output stays under OUTPUT_CAP UTF-8 bytes. Read-only.
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import sys

NOT_TYPED = (
    "<local-command", "<system-reminder>", "<task-notification>", "[Request interrupted",
    "Caveat:", "<bash-input>", "<bash-stdout>", "<bash-stderr>",
    # Agent-to-agent relays read like typed text but were written by another session.
    "From the session", "From the owning session",
    # Machine-sent prompts: cache keepalive and the /afk relay.
    "keepalive ping", "Last keepalive ping", "automessage:",
    # The prompt the mod submits for /morning-review.
    "Run my morning review.",
)
KEEPALIVE_REPLY = "ok"
OWN_COMMAND = re.compile(r"^/(morning|morning-review|morning-run|morning-setup)(\s|$)")
IDLE_GAP = dt.timedelta(minutes=20)
TYPING_PAD = dt.timedelta(minutes=5)
RELAY_PASTE = re.compile(r"^<pasted_content[^>]*>\s*From the [^\n]{0,60}?session")
HEAD_SHARE = 0.6
TYPED_CAP = 1500
AGENT_CAP = 800
REPORT_CAP = 1500
LOG_CAP = 6000
SESSION_CAP = 60000
OUTPUT_CAP = 3_500_000  # UTF-8 bytes of the printed JSON; $.process.run keeps 4 MiB
COMMAND = re.compile(r"<command-name>/?([^<]+)</command-name>")
ARGS = re.compile(r"<command-args>(.*?)</command-args>", re.S)


def parse_ts(value):
    try:
        return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def clip(text, cap):
    text = text.strip()
    return text if len(text) <= cap else text[:cap] + f" […{len(text) - cap} more chars]"


def clip_ends(text, cap):
    """Keep the head and the tail of a text over cap, with the cut size in the middle."""
    text = text.strip()
    if len(text) <= cap:
        return text
    head = int(cap * HEAD_SHARE)
    tail = cap - head
    return f"{text[:head]}\n[…{len(text) - cap} chars cut…]\n{text[len(text) - tail:]}"


def json_bytes(text):
    return len(json.dumps(text, ensure_ascii=False).encode("utf-8")) - 2


def clip_to_bytes(text, cap_bytes):
    """clip_ends, by the largest char cap whose JSON-encoded UTF-8 form fits cap_bytes."""
    if json_bytes(text) <= cap_bytes:
        return text
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if json_bytes(clip_ends(text, mid)) <= cap_bytes:
            lo = mid
        else:
            hi = mid - 1
    return clip_ends(text, lo)


def content_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def human_queued_prompt(entry):
    """The prompt typed while a turn ran, or None. Peer relays and task notices are other origins."""
    a = entry.get("attachment")
    if not isinstance(a, dict) or a.get("type") != "queued_command":
        return None
    origin = a.get("origin")
    if a.get("commandMode") != "prompt" or not isinstance(origin, dict) or origin.get("kind") != "human":
        return None
    return content_text(a.get("prompt"))


def typed_text(entry):
    """What the person typed, or None. A slash command reads as `/name args`."""
    if entry.get("type") == "attachment":
        text = human_queued_prompt(entry)
        text = text.strip() if text else ""
    else:
        if entry.get("type") != "user" or entry.get("isMeta") or entry.get("isSidechain"):
            return None
        if entry.get("isCompactSummary") or entry.get("isVisibleInTranscriptOnly"):
            return None
        text = content_text(entry.get("message", {}).get("content")).strip()
        command = COMMAND.search(text)
        if command:
            args = ARGS.search(text)
            return f"/{command.group(1).strip()} {args.group(1).strip() if args else ''}".strip()
    if not text or text.startswith(NOT_TYPED) or text.startswith("<command-message>"):
        return None
    if RELAY_PASTE.match(text):
        return None
    if "UserPromptSubmit hook" in text[:80]:
        return None
    return text


def agent_text(entry):
    if entry.get("type") != "assistant":
        return None
    if entry.get("isApiErrorMessage") or entry.get("message", {}).get("model") == "<synthetic>":
        return None
    return content_text(entry.get("message", {}).get("content")).strip() or None


def read_entries(path):
    with open(path, errors="ignore") as f:
        for line in f:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def subagent_reports(session_dir, since, until):
    out = []
    for path in sorted(glob.glob(os.path.join(session_dir, "subagents", "agent-*.jsonl"))):
        meta = {}
        meta_path = path[: -len(".jsonl")] + ".meta.json"
        if os.path.exists(meta_path):
            try:
                with open(meta_path) as f:
                    meta = json.load(f)
            except ValueError:
                meta = {}
        report, when = None, None
        for e in read_entries(path):
            t = parse_ts(e.get("timestamp"))
            if t is None:
                continue
            when = t
            if e.get("type") != "assistant":
                continue
            text = agent_text(e)
            if text:
                report = text
            for block in e.get("message", {}).get("content") or []:
                if (
                    isinstance(block, dict)
                    and block.get("type") == "tool_use"
                    and block.get("name") == "SubagentHandback"
                ):
                    report = str((block.get("input") or {}).get("message") or report or "")
        if when is None or not (since <= when < until):
            continue
        label = f"{meta.get('agentType', 'subagent')}: {meta.get('description', '')}".strip()
        out.append((when, f"[subagent {label}] {clip(report or '(no report)', REPORT_CAP)}"))
    return out


def session_log(logs_dir, session_id):
    if not logs_dir:
        return None
    path = os.path.join(logs_dir, f"{session_id}.md")
    if not os.path.exists(path):
        return None
    with open(path, errors="ignore") as f:
        text = re.sub(r"<!--.*?-->", "", f.read(), flags=re.S)
    return clip(text, LOG_CAP)


def active_intervals(times):
    """The person's active spans: typed messages less than IDLE_GAP apart join one span, each padded by TYPING_PAD."""
    spans = []
    for t in sorted(times):
        if spans and t - spans[-1][1] <= IDLE_GAP:
            spans[-1][1] = t
        else:
            spans.append([t - TYPING_PAD, t])
    return merge_intervals(spans)


def merge_intervals(spans):
    merged = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def minutes(spans):
    return round(sum((end - start).total_seconds() for start, end in spans) / 60)


def extract_session(path, since, until, logs_dir):
    session_id = os.path.basename(path)[: -len(".jsonl")]
    rows, project, typed, typed_at = [], None, 0, []
    for e in read_entries(path):
        if str(e.get("entrypoint", "")).startswith("sdk"):
            return None
        project = project or e.get("cwd")
        t = parse_ts(e.get("timestamp"))
        if t is None:
            continue
        text = typed_text(e)
        if text is not None and OWN_COMMAND.match(text):
            until = min(until, t)
            break
        if not (since <= t < until):
            continue
        if text is not None:
            typed += 1
            typed_at.append(t)
            rows.append((t, f"[you] {clip(text, TYPED_CAP)}"))
            continue
        text = agent_text(e)
        if text and text.lower() != KEEPALIVE_REPLY:
            rows.append((t, f"[agent] {clip(text, AGENT_CAP)}"))
    rows += subagent_reports(path[: -len(".jsonl")], since, until)
    if not rows:
        return None
    rows.sort(key=lambda r: r[0])
    lines = [f"{t.astimezone().strftime('%H:%M')} {body}" for t, body in rows]
    log = session_log(logs_dir, session_id)
    if log:
        lines.append(f"--- session log ---\n{log}")
    return {
        "id": session_id,
        "project": project or os.path.basename(os.path.dirname(path)),
        "start": rows[0][0].isoformat(),
        "end": rows[-1][0].isoformat(),
        "typed": typed,
        "active_minutes": minutes(active_intervals(typed_at)),
        "_spans": active_intervals(typed_at),
        "text": clip_ends("\n".join(lines), SESSION_CAP),
    }


def extract(projects, since, until, logs_dir=None):
    sessions = []
    floor = since.timestamp()
    for path in glob.glob(os.path.join(projects, "*", "*.jsonl")):
        if os.path.getmtime(path) < floor:
            continue
        s = extract_session(path, since, until, logs_dir)
        if s:
            sessions.append(s)
    sessions.sort(key=lambda s: s["start"])
    by_project = {}
    for s in sessions:
        by_project.setdefault(s["project"], []).extend(s["_spans"])
    projects = sorted(
        ({"project": p, "active_minutes": minutes(merge_intervals(spans))} for p, spans in by_project.items()),
        key=lambda p: (-p["active_minutes"], p["project"]),
    )
    spans = merge_intervals([span for s in sessions for span in s.pop("_spans")])
    result = {"sessions": sessions, "active_minutes": minutes(spans), "projects": projects}
    fit_to_output_cap(result)
    return result


def render(result):
    return json.dumps(result, ensure_ascii=False)


def fit_to_output_cap(result):
    """Shrink the largest texts, head and tail kept, until the printed JSON fits OUTPUT_CAP bytes."""
    sessions = result["sessions"]
    blank = dict(result, sessions=[dict(s, text="") for s in sessions])
    room = OUTPUT_CAP - len(render(blank).encode("utf-8"))
    sizes = {id(s): json_bytes(s["text"]) for s in sessions}
    if sum(sizes.values()) <= room:
        return
    left = len(sessions)
    for s in sorted(sessions, key=lambda s: sizes[id(s)]):
        share = max(room // left, 0)
        used = min(sizes[id(s)], share)
        if sizes[id(s)] > share:
            s["text"] = clip_to_bytes(s["text"], share)
        room -= used
        left -= 1


def main(argv):
    p = argparse.ArgumentParser()
    p.add_argument("--projects", default=os.path.expanduser("~/.claude/projects"))
    p.add_argument("--since", required=True)
    p.add_argument("--until", required=True)
    p.add_argument("--session-logs", default="")
    a = p.parse_args(argv)
    since, until = parse_ts(a.since), parse_ts(a.until)
    if since is None or until is None:
        p.error("--since and --until take ISO timestamps with a zone")
    result = extract(a.projects, since, until, os.path.expanduser(a.session_logs) or None)
    sys.stdout.buffer.write(render(result).encode("utf-8"))


if __name__ == "__main__":
    main(sys.argv[1:])
