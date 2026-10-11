import datetime as dt
import importlib.util
import json
import os
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("extract", os.path.join(HERE, "extract.py"))
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)

SINCE = dt.datetime(2026, 10, 5, 0, 0, tzinfo=dt.timezone.utc)
UNTIL = dt.datetime(2026, 10, 6, 0, 0, tzinfo=dt.timezone.utc)
IN = "2026-10-05T10:00:00Z"
OUT_BEFORE = "2026-10-04T10:00:00Z"
OUT_AFTER = "2026-10-06T10:00:00Z"


def user(content, ts=IN, **kw):
    return {"type": "user", "timestamp": ts, "cwd": "/work/proj", "message": {"content": content}, **kw}


def command(name, ts=IN):
    """A slash command as the engine records it: a system/local_command entry, not typed text."""
    return {"type": "system", "subtype": "local_command", "timestamp": ts, "cwd": "/work/proj",
            "content": f"<command-name>/{name}</command-name><command-message>{name}</command-message><command-args></command-args>"}


def agent(content, ts=IN, **kw):
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    return {"type": "assistant", "timestamp": ts, "cwd": "/work/proj", "message": {"content": content}, **kw}


def queued(prompt, kind="human", mode="prompt", ts=IN):
    return {
        "type": "attachment",
        "timestamp": ts,
        "cwd": "/work/proj",
        "attachment": {
            "type": "queued_command",
            "commandMode": mode,
            "origin": {"kind": kind},
            "prompt": prompt,
        },
    }


def at(minute, hour=10):
    return dt.datetime(2026, 10, 5, hour, minute, tzinfo=dt.timezone.utc)


class ExtractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.projects = os.path.join(self.tmp.name, "projects")
        self.logs = os.path.join(self.tmp.name, "logs")
        os.makedirs(os.path.join(self.projects, "p"))
        os.makedirs(self.logs)

    def write_session(self, sid, entries):
        path = os.path.join(self.projects, "p", f"{sid}.jsonl")
        with open(path, "w") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
        return path

    def write_subagent(self, sid, aid, entries, meta=None):
        d = os.path.join(self.projects, "p", sid, "subagents")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"agent-{aid}.jsonl"), "w") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
        if meta is not None:
            with open(os.path.join(d, f"agent-{aid}.meta.json"), "w") as f:
                json.dump(meta, f)

    def run_extract(self, logs=False):
        return extract.extract(self.projects, SINCE, UNTIL, self.logs if logs else None)["sessions"]

    def text_of(self, sid):
        for s in self.run_extract():
            if s["id"] == sid:
                return s["text"]
        return None

    def test_window_and_roles_and_tool_content_hidden(self):
        self.write_session("s1", [
            user("early typed", OUT_BEFORE),
            user("hello there"),
            agent([
                {"type": "text", "text": "agent prose"},
                {"type": "tool_use", "name": "Bash", "input": {"command": "SECRET_TOOL_INPUT"}},
            ]),
            user([{"type": "tool_result", "content": "SECRET_TOOL_RESULT"}]),
            agent("late agent", OUT_AFTER),
        ])
        sessions = self.run_extract()
        self.assertEqual(len(sessions), 1)
        text = sessions[0]["text"]
        self.assertIn("[you] hello there", text)
        self.assertIn("[agent] agent prose", text)
        self.assertNotIn("early typed", text)
        self.assertNotIn("late agent", text)
        self.assertNotIn("SECRET_TOOL", text)
        self.assertEqual(sessions[0]["typed"], 1)
        self.assertEqual(sessions[0]["project"], "/work/proj")

    def test_sdk_session_dropped_with_subagents(self):
        self.write_session("sdk1", [user("hi"), agent("yo", entrypoint="sdk-cli")])
        self.write_subagent("sdk1", "a1", [agent("sub report")], {"agentType": "x", "description": "d"})
        self.write_session("ok1", [user("hi", entrypoint="cli")])
        ids = [s["id"] for s in self.run_extract()]
        self.assertEqual(ids, ["ok1"])

    def test_own_slash_commands_drop_session(self):
        self.write_session("m1", [command("morning-review"), agent("report")])
        self.write_session("m2", [command("morning-run"), agent("report")])
        self.write_session("m3", [command("morning-setup"), agent("interview")])
        self.write_session("m4", [user("<command-name>/morning-run</command-name>"), agent("report")])
        self.write_session("keep", [command("build"), user("<command-name>/build</command-name><command-args>x.md</command-args>")])
        self.write_session("keep2", [user("morning-setup plans", "2026-10-05T11:00:00Z")])
        sessions = self.run_extract()
        self.assertEqual([s["id"] for s in sessions], ["keep", "keep2"])
        self.assertIn("[you] /build x.md", sessions[0]["text"])

    def test_machine_and_meta_messages_excluded(self):
        self.write_session("s", [
            user("real question"),
            user("From the session abc: do thing"),
            user("keepalive ping. Reply only: ok"),
            agent("ok"),
            user("automessage: nudge"),
            user("<system-reminder>x</system-reminder>"),
            user("<task-notification>done</task-notification>"),
            user("meta text", isMeta=True),
            user("compact summary text", isCompactSummary=True),
            agent("real answer"),
        ])
        text = self.text_of("s")
        self.assertIn("[you] real question", text)
        self.assertIn("[agent] real answer", text)
        for bad in ("From the session", "keepalive", "[agent] ok", "automessage", "system-reminder",
                    "task-notification", "meta text", "compact summary"):
            self.assertNotIn(bad, text)
        self.assertEqual(text.count("[you]"), 1)
        self.assertEqual(text.count("[agent]"), 1)

    def test_subagent_handback_report_with_meta_label(self):
        self.write_session("s", [user("go")])
        self.write_subagent("s", "a1", [
            agent([{"type": "tool_use", "name": "SubagentHandback", "input": {"message": "final handback"}}]),
        ], {"agentType": "deep-work", "description": "refactor things"})
        text = self.text_of("s")
        self.assertIn("[subagent deep-work: refactor things] final handback", text)

    def test_session_log_appended_without_html_comments(self):
        self.write_session("s", [user("go")])
        with open(os.path.join(self.logs, "s.md"), "w") as f:
            f.write("visible line\n<!-- hidden\nmulti-line note -->\nafter")
        sessions = self.run_extract(logs=True)
        text = sessions[0]["text"]
        self.assertIn("--- session log ---", text)
        self.assertIn("visible line", text)
        self.assertIn("after", text)
        self.assertNotIn("hidden", text)
        self.assertNotIn("multi-line note", text)

    def test_no_logs_dir_means_no_log(self):
        self.write_session("s", [user("go")])
        with open(os.path.join(self.logs, "s.md"), "w") as f:
            f.write("log body")
        text = self.run_extract(logs=False)[0]["text"]
        self.assertNotIn("session log", text)
        self.assertNotIn("log body", text)

    def test_typed_message_over_cap_is_clipped_with_marker(self):
        self.write_session("s", [user("a" * 1600)])
        text = self.text_of("s")
        self.assertIn("a" * 1500 + " […100 more chars]", text)
        self.assertNotIn("a" * 1501, text)

    def test_typed_message_at_cap_is_not_clipped(self):
        self.write_session("s", [user("b" * 1500)])
        text = self.text_of("s")
        self.assertIn("b" * 1500, text)
        self.assertNotIn("more chars", text)

    def test_prompts_typed_mid_turn_count_as_typed(self):
        self.write_session("s", [
            user("first"),
            queued("typed while the agent ran"),
            queued([{"type": "text", "text": "block prompt"}]),
            queued("From the session abc: relay"),
            queued("from a peer", kind="peer"),
            queued("<task-notification>done</task-notification>", kind="task-notification"),
            queued("shell thing", mode="bash"),
        ])
        sessions = self.run_extract()
        text = sessions[0]["text"]
        self.assertIn("[you] typed while the agent ran", text)
        self.assertIn("[you] block prompt", text)
        for bad in ("From the session", "from a peer", "task-notification", "shell thing"):
            self.assertNotIn(bad, text)
        self.assertEqual(sessions[0]["typed"], 3)

    def test_api_error_text_is_not_agent_prose(self):
        self.write_session("s", [
            user("go"),
            agent("Rate limited, try later", isApiErrorMessage=True),
            {**agent("synthetic reply"), "message": {"model": "<synthetic>", "content": [{"type": "text", "text": "synthetic reply"}]}},
            agent("real reply"),
        ])
        text = self.text_of("s")
        self.assertIn("[agent] real reply", text)
        self.assertNotIn("Rate limited", text)
        self.assertNotIn("synthetic reply", text)

    def test_morning_mid_session_drops_everything_after_it(self):
        self.write_session("s", [
            user("before", "2026-10-05T09:00:00Z"),
            agent("agent before", "2026-10-05T09:01:00Z"),
            command("morning-review", "2026-10-05T10:00:00Z"),
            user("The morning-report plugin sent a message: Run my morning review. The morning-report mod sent this prompt.", "2026-10-05T10:00:01Z"),
            agent("report shown", "2026-10-05T10:01:00Z"),
            user("answer after", "2026-10-05T10:02:00Z"),
        ])
        self.write_subagent("s", "late", [agent("late sub", "2026-10-05T10:30:00Z")], {"agentType": "x", "description": "d"})
        self.write_subagent("s", "early", [agent("early sub", "2026-10-05T09:30:00Z")], {"agentType": "x", "description": "d"})
        sessions = self.run_extract()
        text = sessions[0]["text"]
        self.assertIn("[you] before", text)
        self.assertIn("agent before", text)
        self.assertIn("early sub", text)
        for bad in ("morning", "report shown", "answer after", "late sub"):
            self.assertNotIn(bad, text)
        self.assertEqual(sessions[0]["typed"], 1)

    def test_morning_review_prompt_alone_is_not_typed(self):
        self.write_session("s", [user("real"), user("The morning-report plugin sent a message: Run my morning review.")])
        self.assertEqual(self.text_of("s").count("[you]"), 1)

    def test_word_morning_without_slash_does_not_drop_session(self):
        self.write_session("s", [user("morning plans for the launch"), agent("ok plan")])
        self.assertIn("[you] morning plans", self.text_of("s"))

    def test_relay_wrapped_in_pasted_content_is_excluded(self):
        wrap = lambda inner: f'\n\n<pasted_content id="1">\n{inner}\n</pasted_content id="1">\n'
        self.write_session("s", [
            user("mine"),
            user(wrap("From the session foo (not the operator; information for you)")),
            user(wrap("From the owning session in pane wK:p1 (not the operator)")),
            user(wrap("From the standard-git-workflow-setup session (pane wM:p1), not the operator.")),
            user(wrap("my pasted stack trace")),
            user(wrap("From the docs: install with npm")),
        ])
        text = self.text_of("s")
        self.assertIn("my pasted stack trace", text)
        self.assertIn("From the docs", text)
        self.assertNotIn("not the operator", text)
        self.assertEqual(text.count("[you]"), 3)

    def test_session_over_cap_keeps_head_and_tail(self):
        entries = [user(f"msg{i:03d} " + "w" * 900, f"2026-10-05T10:{i // 60:02d}:{i % 60:02d}Z") for i in range(120)]
        self.write_session("s", entries)
        text = self.text_of("s")
        self.assertLessEqual(len(text), extract.SESSION_CAP + 40)
        self.assertIn("msg000", text)
        self.assertIn("msg119", text)
        self.assertIn("chars cut…]", text)
        self.assertNotIn("msg060", text)

    def test_output_is_capped_in_utf8_bytes_with_head_and_tail(self):
        for sid in ("a", "b"):
            self.write_session(sid, [
                user("START" + "漢字🙂" * 300),
                *[user("漢字🙂" * 300, f"2026-10-05T10:00:{i:02d}Z") for i in range(40)],
                user("END" + "漢字🙂" * 300, "2026-10-05T11:00:00Z"),
            ])
        with mock.patch.object(extract, "OUTPUT_CAP", 40_000):
            raw = extract.render(extract.extract(self.projects, SINCE, UNTIL))
        self.assertLessEqual(len(raw.encode("utf-8")), 40_000)
        self.assertIn("漢字", raw)
        self.assertNotIn("\\u", raw)
        for s in json.loads(raw)["sessions"]:
            self.assertIn("START", s["text"])
            self.assertIn("END", s["text"])
            self.assertIn("chars cut…]", s["text"])

    def test_output_under_cap_is_untouched(self):
        self.write_session("s", [user("short")])
        with mock.patch.object(extract, "OUTPUT_CAP", 40_000):
            raw = extract.render(extract.extract(self.projects, SINCE, UNTIL))
        self.assertNotIn("cut", raw)

    def test_output_cap_keeps_the_top_level_active_minutes(self):
        for sid in ("a", "b"):
            self.write_session(sid, [user("x" * 1000, f"2026-10-05T10:00:{i:02d}Z") for i in range(40)])
        with mock.patch.object(extract, "OUTPUT_CAP", 20_000):
            raw = extract.render(extract.extract(self.projects, SINCE, UNTIL))
        self.assertLessEqual(len(raw.encode("utf-8")), 20_000)
        result = json.loads(raw)
        # 40 messages in 39 s, padded 5 min before the first: 5.65 min, in both sessions at once.
        self.assertEqual(result["active_minutes"], 6)
        self.assertEqual([s["active_minutes"] for s in result["sessions"]], [6, 6])


    def test_messages_19_minutes_apart_join_one_span(self):
        spans = extract.active_intervals([at(0), at(19)])
        self.assertEqual(spans, [[at(0) - dt.timedelta(minutes=5), at(19)]])
        self.assertEqual(extract.minutes(spans), 24)

    def test_messages_21_minutes_apart_split_into_two_spans(self):
        spans = extract.active_intervals([at(0), at(21)])
        self.assertEqual(len(spans), 2)
        self.assertEqual(extract.minutes(spans), 10)

    def test_a_lone_message_counts_five_minutes(self):
        self.assertEqual(extract.minutes(extract.active_intervals([at(0)])), 5)

    def test_unsorted_times_are_sorted_before_joining(self):
        self.assertEqual(extract.minutes(extract.active_intervals([at(19), at(0)])), 24)

    def test_no_times_is_zero_minutes(self):
        self.assertEqual(extract.active_intervals([]), [])
        self.assertEqual(extract.minutes([]), 0)

    def test_merge_intervals_unions_overlaps_and_keeps_gaps(self):
        merged = extract.merge_intervals([[at(30), at(40)], [at(0), at(20)], [at(10), at(25)]])
        self.assertEqual(merged, [[at(0), at(25)], [at(30), at(40)]])

    def test_overlapping_sessions_count_once_at_top_level_but_each_keeps_its_own(self):
        # A spans 09:55-10:19 (24 min); B's lone message spans 10:05-10:10 (5 min), inside A.
        self.write_session("a", [user("one", "2026-10-05T10:00:00Z"), user("two", "2026-10-05T10:19:00Z")])
        self.write_session("b", [user("lone", "2026-10-05T10:10:00Z")])
        result = extract.extract(self.projects, SINCE, UNTIL)
        by_id = {s["id"]: s["active_minutes"] for s in result["sessions"]}
        self.assertEqual(by_id, {"a": 24, "b": 5})
        self.assertEqual(result["active_minutes"], 24)

    def test_disjoint_sessions_add_up_at_top_level(self):
        self.write_session("a", [user("one", "2026-10-05T09:00:00Z")])
        self.write_session("b", [user("two", "2026-10-05T12:00:00Z")])
        self.assertEqual(extract.extract(self.projects, SINCE, UNTIL)["active_minutes"], 10)

    def test_agent_only_activity_adds_no_active_minutes(self):
        self.write_session("a", [user("go", "2026-10-05T10:00:00Z"), agent("later", "2026-10-05T14:00:00Z")])
        result = extract.extract(self.projects, SINCE, UNTIL)
        self.assertEqual(result["sessions"][0]["active_minutes"], 5)
        self.assertEqual(result["active_minutes"], 5)

    def test_the_result_holds_only_the_documented_keys(self):
        self.write_session("a", [user("one")])
        self.write_session("b", [user("two")])
        result = extract.extract(self.projects, SINCE, UNTIL)
        self.assertEqual(set(result), {"sessions", "active_minutes", "projects"})
        for s in result["sessions"]:
            self.assertEqual(set(s), {"id", "project", "start", "end", "typed", "active_minutes", "text"})
        self.assertTrue(result["projects"])
        for p in result["projects"]:
            self.assertEqual(set(p), {"project", "active_minutes"})

    def test_morning_setup_stops_the_session_without_matching_longer_commands(self):
        self.write_session("setup", [
            user("before", "2026-10-05T09:00:00Z"),
            user("<command-name>/morning-setup</command-name>", "2026-10-05T10:00:00Z"),
            user("after", "2026-10-05T10:01:00Z"),
        ])
        self.write_session("longer", [
            user("<command-name>/morning-setups</command-name>"),
            user("still here", "2026-10-05T10:01:00Z"),
        ])

        by_id = {session["id"]: session["text"] for session in self.run_extract()}

        self.assertIn("before", by_id["setup"])
        self.assertNotIn("morning-setup", by_id["setup"])
        self.assertNotIn("after", by_id["setup"])
        self.assertIn("/morning-setups", by_id["longer"])
        self.assertIn("still here", by_id["longer"])

    def test_projects_union_each_projects_spans_and_sort_by_minutes_then_name(self):
        # beta's session overlaps alpha's completely: the global total unions it, but each project owns its time.
        self.write_session("alpha", [
            user("start", "2026-10-05T10:00:00Z", cwd="/work/alpha"),
            user("end", "2026-10-05T10:19:00Z", cwd="/work/alpha"),
        ])
        self.write_session("beta-main", [
            user("start", "2026-10-05T10:00:00Z", cwd="/work/beta"),
            user("end", "2026-10-05T10:19:00Z", cwd="/work/beta"),
        ])
        self.write_session("beta-overlap", [user("inside beta", "2026-10-05T10:10:00Z", cwd="/work/beta")])
        self.write_session("gamma", [user("short", "2026-10-05T13:00:00Z", cwd="/work/gamma")])

        result = extract.extract(self.projects, SINCE, UNTIL)

        self.assertEqual(result["active_minutes"], 29)
        self.assertEqual(result["projects"], [
            {"project": "/work/alpha", "active_minutes": 24},
            {"project": "/work/beta", "active_minutes": 24},
            {"project": "/work/gamma", "active_minutes": 5},
        ])
        self.assertNotIn("_spans", extract.render(result))


if __name__ == "__main__":
    unittest.main()
