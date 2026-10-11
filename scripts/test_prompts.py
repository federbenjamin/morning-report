import json
import os
import re
import unittest

from pipeline_ts import exported


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as source:
        return source.read()


def prompt(name):
    return read("prompts", name)


def plugin_name():
    return json.loads(read(".claude-plugin", "plugin.json"))["name"]


def prompt_names():
    return sorted(name for name in os.listdir(os.path.join(ROOT, "prompts")) if name.endswith(".md"))


PIPELINE = exported()
HEADINGS = [h["heading"] for h in PIPELINE["PROFILE_HEADINGS"]]
PROGRESS, WATCH = HEADINGS[2], HEADINGS[3]
SCAN_TOOL = PIPELINE["SCAN_TOOL"]
# The system prompt of the report call: the daily core, the Monday block, the Day-14 block.
REPORT_PROMPTS = ("report.md", "report-weekly.md", "report-day14.md")
WEEKLY_HEADINGS = ("## What you're doing well", "## What's not working", "## Drift")

# Which prompt holds each text the hook fills in place of a missing input, or branches on.
SENTINEL_READERS = {
    "SETUP_NO_PROFILE": "morning-setup.md",
    "SCAN_NO_SESSIONS": "morning-setup.md",
    "SUMMARY_NO_PROFILE": "summarizer.md",
    "IS_THIS_WORKING": "report-day14.md",
}


def bold_phrases(text):
    return re.findall(r"\*\*([^*\n]+)\*\*", text)


def letters(text):
    return "".join(c for c in text.casefold() if c.isalnum())


def line_with(text, *needles):
    lines = [line for line in text.splitlines() if all(n in line for n in needles)]
    if len(lines) != 1:
        raise AssertionError(f"expected one line holding {needles!r}, found {len(lines)}")
    return lines[0]


class ProfileHeadingsTest(unittest.TestCase):
    def test_the_constant_parses_to_five_distinct_headings(self):
        self.assertEqual(len(HEADINGS), 5)
        self.assertEqual(len(set(HEADINGS)), 5)

    def test_reader_prompts_name_the_headings_in_bold(self):
        report = "".join(prompt(name) for name in REPORT_PROMPTS)
        for heading in HEADINGS:
            self.assertIn(f"**{heading}**", report)
        summarizer = prompt("summarizer.md")
        for heading in (PROGRESS, WATCH):
            self.assertIn(f"**{heading}**", summarizer)

    def test_no_bold_phrase_in_a_reader_prompt_misspells_a_heading(self):
        by_letters = {letters(h): h for h in HEADINGS}
        for name in (*REPORT_PROMPTS, "summarizer.md"):
            for phrase in bold_phrases(prompt(name)):
                heading = by_letters.get(letters(phrase))
                if heading is not None:
                    self.assertEqual(phrase, heading, f"{name} spells **{heading}** as **{phrase}**")

    def test_setup_prompt_takes_the_headings_from_the_fill_only(self):
        text = prompt("morning-setup.md")
        self.assertEqual(text.count("{{PROFILE_HEADINGS}}"), 1)
        self.assertNotIn("{{SCAN}}", text)
        for heading in HEADINGS:
            self.assertNotIn(heading, text)
            self.assertNotIn(f"## {heading}", text.splitlines())


class SentinelTest(unittest.TestCase):
    def test_each_prompt_holds_the_exact_text_the_hook_fills_for_a_missing_input(self):
        for name, reader in SENTINEL_READERS.items():
            self.assertIn(name, PIPELINE, f"hooks/pipeline.ts exports no {name}")
            self.assertIn(PIPELINE[name], prompt(reader), f"{reader} does not hold {name}")


class PromptContractTest(unittest.TestCase):
    def test_each_prompts_slots_are_the_keys_its_hook_fills(self):
        fills = PIPELINE["PROMPT_FILLS"]
        self.assertEqual(sorted(fills), prompt_names())
        for name in prompt_names():
            slots = set(re.findall(r"\{\{([A-Z_]+)\}\}", prompt(name)))
            self.assertEqual(slots, set(fills[name]), f"{name} slots differ from PROMPT_FILLS")

    def test_each_report_part_the_review_names_is_in_the_report_template(self):
        review, report = prompt("morning-review.md"), prompt("report.md")
        parts = set(re.findall(r'"([A-Z][a-z ]+)"', review))
        self.assertTrue({"Fast track", "Questions", "Calls to make"} <= parts)
        for part in parts:
            self.assertRegex(report, rf"(?m)^\s*(## {re.escape(part)}$|{re.escape(part)}:)", f"report.md has no {part}")
        self.assertIn("{{call N}}", review)
        self.assertIn("{{call 1}}", report)


class ReportPromptTest(unittest.TestCase):
    def test_profile_drives_the_optional_sections_without_changing_the_core_report_shape(self):
        text = prompt("report.md")

        self.assertEqual(text.count("{{PROFILE}}"), 1)
        for heading in (
            "# Morning report — <weekday> <date>",
            "## Yesterday",
            "## Things on the go",
            "## First move today",
            "## Fast track",
            "## Questions",
            "One thing to remember all day:",
        ):
            self.assertIn(heading, text)
        day14 = prompt("report-day14.md")
        self.assertNotIn(PIPELINE["IS_THIS_WORKING"], text)
        self.assertRegex(day14, r"(?s)`## Is this working\?` right before `## Questions`")
        self.assertIn("run `/morning-setup` to restate it", day14)

    def test_profile_progress_rules_replace_the_fixed_outward_scoreboard_and_tooling_line(self):
        text = prompt("report.md")

        self.assertRegex(text, rf"(?is)streams.*{re.escape(PROGRESS)}.*flat list")
        self.assertNotIn("Outward is the scoreboard", text)
        self.assertNotIn("**Tooling this week:**", text)
        self.assertNotRegex(text, r"\boperator\b")
        self.assertLessEqual(len(text.split()), 1269)

    def test_no_progress_split_when_counts_as_progress_is_none(self):
        text = prompt("report.md")

        rule = line_with(text, f"**{PROGRESS}**", '"(none)"', "split nothing")
        self.assertIn("first move", rule)
        self.assertIn("fast track", rule)
        yesterday = text.split("## Yesterday\n", 1)[1].splitlines()[0]
        self.assertIn(f"when **{PROGRESS}** names a split", yesterday)
        self.assertNotIn("versus background", text)

    def test_a_regular_output_with_no_named_day_gets_no_section(self):
        text = prompt("report.md")

        rule = line_with(text, "regular output gets its section")
        self.assertIn("only on a day its entry names", rule)
        self.assertIn("with no day named, only its line under Yesterday", rule)
        self.assertNotIn("days it is due", text)
        self.assertNotIn("same shape every day", text)

    def test_questions_are_open_and_set_no_rules(self):
        text = prompt("report.md")

        template = text[text.index("## Questions"):text.index("One thing to remember all day:")]
        self.assertIn("<1-2, open, no options>", template)
        self.assertNotIn("<option>", template)
        self.assertNotIn("<exactly 5>", template)
        rule = line_with(text, "**Questions are how you learn the person")
        self.assertIn("one or two open questions", rule)
        self.assertNotRegex(text, r"(?i)2-4 short options")
        self.assertIn("Never ask them to set a cap, a priority, or a deadline", text)
        self.assertIn("read them as context for how to coach, never as rules", text)
        self.assertNotIn("names the mistake and the fix", text)
        self.assertIn("never a reproach", text)

    def test_watch_for_sections_live_only_in_the_monday_block(self):
        text, weekly = prompt("report.md"), prompt("report-weekly.md")

        for heading in WEEKLY_HEADINGS:
            self.assertNotIn(heading, text)
            self.assertIn(heading, weekly)
        self.assertNotRegex(text, r"(?i)monday")
        self.assertIn(f"**{WATCH}** names anything", weekly)
        self.assertIn("Leave out any it does not ask for", weekly)

    def test_a_quiet_day_keeps_every_core_section(self):
        rule = line_with(prompt("report.md"), "**Quiet day.**")

        self.assertIn("every other daily part is still written", rule)
        for section in ("Fast track", "Questions"):
            self.assertIn(section, rule)
        self.assertNotIn("write only", rule)


class ReviewPromptTest(unittest.TestCase):
    def test_answers_are_taken_in_the_persons_words_and_rules_only_on_request(self):
        text = prompt("morning-review.md")

        step = text[text.index("3. **Questions.**"):text.index("4. **Fast track.**")]
        self.assertIn("in one message, numbered", step)
        self.assertIn("wait for my reply in my own words", step)
        self.assertNotIn("AskUserQuestion", step)
        self.assertNotIn("the report's options", step)
        self.assertIn("only when I ask for one in so many words", step)
        self.assertIn("Never infer a rule from an answer", step)
        self.assertIn("never ask me whether something should be one", step)
        self.assertIn("never edit or delete earlier lines", step)
        self.assertNotIn("sets or changes a priority", step)


class SummarizerPromptTest(unittest.TestCase):
    def test_profile_rules_replace_kind_and_make_friction_profile_specific(self):
        text = prompt("summarizer.md")

        self.assertEqual(text.count("{{PROFILE}}"), 1)
        self.assertRegex(text, r"(?is)# Who the sessions belong to.*\{\{PROFILE\}\}")
        self.assertIn("counts: toward | background | mixed", text)
        self.assertRegex(text, r"(?is)friction:.*correcting.*arguing.*re-asking")
        self.assertNotIn("kind: outward | inward | mixed", text)
        self.assertNotRegex(text, r"\boperator\b")

    def test_counts_line_is_left_out_with_no_profile_or_no_progress_heading(self):
        text = prompt("summarizer.md")

        rule = line_with(text, "Leave the `counts:` line out")
        self.assertIn(PIPELINE["SUMMARY_NO_PROFILE"], rule)
        self.assertIn(f"**{PROGRESS}** reads `(none)`", rule)

    def test_summarizer_uses_a_generic_stream_form(self):
        text = prompt("summarizer.md")

        self.assertRegex(text, r"(?is)stream:.*<.*>")
        for line in (line for line in text.splitlines() if "stream:" in line):
            self.assertNotRegex(line, r'(?i)"|e\.g\.|for example|such as|like ')


class MorningSetupPromptTest(unittest.TestCase):
    def test_setup_interview_keeps_profile_writes_explicit(self):
        text = prompt("morning-setup.md")

        self.assertIn("(none)", text)
        self.assertIn("profile-{{TODAY}}-old.md", text)
        self.assertRegex(text, r"(?is)show.*once.*stop")
        self.assertNotRegex(text, r"\boperator\b")
        self.assertIn("/morning-setup schedule", text)

    def test_consent_comes_first_and_the_scan_tool_only_after_round_one(self):
        text = prompt("morning-setup.md")
        round_one, round_two = text.index("Round one:"), text.index("Round two:")

        consent = text[: round_one]
        self.assertIn("{{PREVIEW}}", consent)
        self.assertIn("AskUserQuestion", consent)
        days = PIPELINE["SETUP_DAYS"]
        self.assertRegex(consent, rf"(?is)how many days.*from {days['min']} to {days['max']}.*skip")
        self.assertEqual(text.count(f"`{SCAN_TOOL}`"), 1)
        tool = text.index(f"`{SCAN_TOOL}`")
        self.assertGreater(tool, round_one)
        self.assertLess(tool, round_two)
        self.assertRegex(text[round_one:tool], r"(?is)only if they said yes.*never before round one is done")
        self.assertIn("a few minutes", text[tool:round_two])

    def test_the_prompt_names_the_tool_the_hook_registers_and_serves(self):
        register = read("hooks", "register.tsx")

        self.assertIn(f"`{SCAN_TOOL}`", prompt("morning-setup.md"))
        self.assertIn(f"tool: 'mcp__{plugin_name()}__{SCAN_TOOL}'", register)
        self.assertIn("name: SCAN_TOOL,", register)

    def test_every_path_without_a_scan_skips_round_two(self):
        text = prompt("morning-setup.md")
        marker = PIPELINE["SCAN_NO_SESSIONS"]
        round_one, round_two = text.index("Round one:"), text.index("Round two:")

        self.assertEqual(text.count(marker), 1)
        self.assertLess(text.index("{{PREVIEW}}"), text.index(marker))
        self.assertLess(text.index(marker), round_one)
        self.assertIn("nothing to read", text[text.index(marker):round_one])
        rule = line_with(text, "There is no round two when")
        path = text[text.index(rule):round_two]
        for case in ("they skipped", "nothing to read", "anything but a file path"):
            self.assertIn(case, path)
        self.assertIn("go straight to writing", path)


class SetupCommandFormTest(unittest.TestCase):
    def test_no_prompt_or_readme_names_a_setup_argument(self):
        texts = {name: prompt(name) for name in prompt_names()}
        texts["README.md"] = read("README.md")
        for name, text in texts.items():
            for form in ("/morning-setup goals", "/morning-setup scan", "scan [days]"):
                self.assertNotIn(form, text, f"{name} names {form}")


if __name__ == "__main__":
    unittest.main()
