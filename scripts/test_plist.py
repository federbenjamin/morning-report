import json
import os
import pathlib
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

# Calls hooks/pipeline.ts itself, so the test runs the plist and the check the schedule hook uses.
from pipeline_ts import call

PLUGIN = "morning-report"
UID = "501"
TARGET = f"gui/{UID}/com.morning-report"

CLAUDE_STUB = """#!/bin/sh
here=$(dirname "$0")
if [ "$1" = plugin ] && [ -n "$CLAUDE_CONFIG_DIR" ]; then
  cat "$here/config-dir-list.out"
  exit 0
fi
if [ "$1" = plugin ]; then
  cat "$here/list.out"
  exit "$(cat "$here/list.code")"
fi
printf '%s\\n' "$*" > "$here/ran"
env > "$here/ran-env"
"""

# What a gui domain hands every job besides the plist's EnvironmentVariables: launchd's login variables and
# anything set with `launchctl setenv`.
LOGIN_ENV = {"USER": "someone", "LOGNAME": "someone", "SHELL": "/bin/zsh", "TMPDIR": "/var/folders/xy/T/", "SSH_AUTH_SOCK": "/private/tmp/agent.sock"}

LAUNCHCTL_STUB = """#!/bin/sh
here=$(dirname "$0")
if [ -e "$HOME/Library/LaunchAgents/com.morning-report.plist" ]; then left=present; else left=gone; fi
printf '%s plist=%s\\n' "$*" "$left" >> "$here/launchctl.log"
"""

# Copies the job's log as it stands when rm runs, then runs the real rm.
RM_STUB = """#!/bin/sh
cat "$HOME/Library/Logs/com.morning-report/run.log" > "$(dirname "$0")/log-at-rm" 2>/dev/null
exec /bin/rm "$@"
"""


def plugin(id, enabled):
    return {"id": id, "version": "0.1.0", "scope": "user", "enabled": enabled, "installPath": f"/plugins/{PLUGIN}/{id}"}


def stub(path, text):
    path.write_text(text)
    path.chmod(0o755)


class Job:
    """One installed job in a scratch home: the rendered plist, its log folder, and stub claude and launchctl."""

    def __init__(self, tmp):
        self.home = tmp / "h o'm&e"
        self.bin = tmp / "b'in d"
        self.stubs = tmp / "stubs"
        for d in (self.bin, self.stubs, self.home / "Library" / "LaunchAgents", self.home / "Library" / "Logs" / "com.morning-report"):
            d.mkdir(parents=True)
        stub(self.bin / "claude", CLAUDE_STUB)
        stub(self.stubs / "launchctl", LAUNCHCTL_STUB)
        stub(self.stubs / "rm", RM_STUB)
        (self.stubs / "python3").symlink_to(sys.executable)
        path = f"{self.stubs}:/usr/bin:/bin"
        if shutil.which("launchctl", path=path) != str(self.stubs / "launchctl"):
            raise AssertionError("the launchctl stub does not shadow the real one")
        self.input = {"claudePath": str(self.bin / "claude"), "home": str(self.home), "path": path, "uid": UID, "hour": 5, "pluginName": PLUGIN}
        self.plist = self.home / "Library" / "LaunchAgents" / "com.morning-report.plist"
        self.plist.write_text(call("renderPlist", self.input))

    def lists(self, out, code=0, config_dir_out=None):
        (self.bin / "list.out").write_text(out)
        (self.bin / "list.code").write_text(str(code))
        if config_dir_out is not None:
            (self.bin / "config-dir-list.out").write_text(config_dir_out)

    def fire(self, out, code=0, domain_env=LOGIN_ENV):
        """Runs the job as launchd does: its arguments, the domain's variables under the plist's own, its folder,
        both streams appended to its log."""
        self.lists(out, code)
        job = plistlib.loads(self.plist.read_bytes())
        with open(job["StandardOutPath"], "a") as sink:
            r = subprocess.run(
                job["ProgramArguments"], env={**domain_env, **job["EnvironmentVariables"]}, cwd=job["WorkingDirectory"],
                stdin=subprocess.DEVNULL, stdout=sink, stderr=sink, timeout=30,
            )
        return subprocess.CompletedProcess(r.args, r.returncode, stdout="", stderr=pathlib.Path(job["StandardErrorPath"]).read_text())

    def log_at_rm(self):
        p = self.stubs / "log-at-rm"
        return p.read_text() if p.exists() else None

    def ran(self):
        p = self.bin / "ran"
        return p.read_text() if p.exists() else None

    def ran_env(self):
        return dict(line.split("=", 1) for line in (self.bin / "ran-env").read_text().splitlines() if "=" in line)

    def launchctl(self):
        p = self.stubs / "launchctl.log"
        return p.read_text() if p.exists() else None


class SelfRemovalTest(unittest.TestCase):
    def job(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        self.addCleanup(lambda: (tmp / "h o'm&e" / "Library" / "LaunchAgents").chmod(0o755))
        return Job(tmp)

    def assert_stays(self, job, r):
        self.assertTrue(job.plist.exists(), r.stderr)
        self.assertIsNone(job.launchctl())
        self.assertIsNone(job.ran())

    def test_a_failed_list_never_removes_the_job_even_when_it_printed_a_list_without_the_plugin(self):
        for out, code in (("", 1), ("boom", 2), ("", 127), (json.dumps([plugin("other@m", True)]), 1), ("[]", 1)):
            with self.subTest(out=out, code=code):
                job = self.job()
                r = job.fire(out, code)
                self.assertNotEqual(r.returncode, 0)
                self.assert_stays(job, r)
                self.assertIn(f"claude plugin list failed (exit {code}); the job stays", r.stderr)

    def test_an_unreadable_list_never_removes_the_job(self):
        for out in ("", "  \n", "not json", "{}", "null", '["morning-report@m"]', '[{"id": "x@m"}]', '[{"enabled": true}]', '[{"id": "x@m", "enabled": "no"}]'):
            with self.subTest(out=out):
                job = self.job()
                r = job.fire(out)
                self.assertNotEqual(r.returncode, 0)
                self.assert_stays(job, r)
                self.assertIn("could not read claude plugin list; the job stays", r.stderr)

    def test_a_list_without_the_plugin_deletes_the_plist_then_boots_the_job_out(self):
        others = [plugin("morning-reports@m", True), plugin("x-morning-report@m", True), plugin("other@morning-report", True)]
        for out in ("[]", json.dumps(others)):
            with self.subTest(out=out):
                job = self.job()
                r = job.fire(out)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertFalse(job.plist.exists())
                self.assertEqual(job.launchctl(), f"bootout {TARGET} plist=gone\n")
                self.assertIsNone(job.ran())

    def test_the_removal_writes_why_to_the_job_log_before_it_deletes_the_plist(self):
        for out in ("[]", json.dumps([plugin("other@m", True)])):
            with self.subTest(out=out):
                job = self.job()
                job.fire(out)
                line = f"morning-report: claude plugin list --json does not list {PLUGIN}; removing this job: rm -f {job.plist}, then launchctl bootout {TARGET}\n"
                self.assertEqual(job.log_at_rm(), line)
                self.assertFalse(job.plist.exists())

    def test_an_enabled_plugin_runs_the_report_and_keeps_the_job(self):
        for listed in ([plugin(f"{PLUGIN}@m", True)], [plugin(f"{PLUGIN}@a", False), plugin(f"{PLUGIN}@b", True)]):
            with self.subTest(listed=listed):
                job = self.job()
                r = job.fire(json.dumps(listed))
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(job.ran(), "-p /morning-run\n")
                self.assertTrue(job.plist.exists())
                self.assertIsNone(job.launchctl())

    def test_a_variable_set_with_launchctl_setenv_never_changes_the_list_the_job_reads(self):
        empty = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, empty, True)
        for extra in ({"CLAUDE_CONFIG_DIR": str(empty)}, {"CLAUDE_CODE_PLUGIN_DIRS": str(empty), "CLAUDE_CONFIG_DIR": str(empty)}):
            with self.subTest(extra=extra):
                job = self.job()
                job.lists("", config_dir_out="[]")
                r = job.fire(json.dumps([plugin(f"{PLUGIN}@m", True)]), domain_env={**LOGIN_ENV, **extra})
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertTrue(job.plist.exists(), r.stderr)
                self.assertIsNone(job.launchctl())
                self.assertEqual(job.ran(), "-p /morning-run\n")
                for name in extra:
                    self.assertNotIn(name, job.ran_env())

    def test_the_report_runs_with_the_plist_variables_and_only_the_login_ones_launchd_set(self):
        for domain in (LOGIN_ENV, {**LOGIN_ENV, "ANTHROPIC_MODEL": "x", "HOME": "/elsewhere"}, {}):
            with self.subTest(domain=domain):
                job = self.job()
                job.fire(json.dumps([plugin(f"{PLUGIN}@m", True)]), domain_env=domain)
                env = job.ran_env()
                # sh fills an unset SHELL from the login entry itself.
                names = [k for k in LOGIN_ENV if k in domain or k != "SHELL"]
                self.assertEqual({k: env.get(k) for k in names}, {k: domain.get(k) for k in names})
                self.assertEqual((env["HOME"], env["PATH"]), (str(job.home), job.input["path"]))
                self.assertNotIn("ANTHROPIC_MODEL", env)

    def test_a_disabled_plugin_runs_nothing_and_keeps_the_job(self):
        job = self.job()
        r = job.fire(json.dumps([plugin("other@m", True), plugin(f"{PLUGIN}@m", False)]))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assert_stays(job, r)
        self.assertIn("the plugin is disabled; nothing run", r.stderr)

    @unittest.skipIf(os.geteuid() == 0, "root deletes from a read-only folder")
    def test_a_plist_that_cannot_be_deleted_keeps_the_job_loaded(self):
        job = self.job()
        job.plist.parent.chmod(0o555)
        r = job.fire("[]")
        self.assertNotEqual(r.returncode, 0)
        self.assert_stays(job, r)


class JobPluginCheckTest(unittest.TestCase):
    """The check the schedule hook runs before it installs the job sees what the job will see."""

    def setUp(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        self.job = Job(tmp)
        self.check = call("jobPluginCheck", self.job.input)
        self.config_dir = tmp / "config"
        self.config_dir.mkdir()

    def run_as_hook(self, env):
        """As $.process.run does: the session's own environment, the check's argv and folder."""
        return subprocess.run(self.check["argv"], cwd=self.check["cwd"], env=env, capture_output=True, text=True, timeout=30)

    def test_it_runs_with_the_job_environment_and_folder(self):
        job = plistlib.loads(self.job.plist.read_bytes())
        argv = self.check["argv"]
        self.assertEqual(argv[:-1], job["ProgramArguments"][:-1])
        self.assertIn("exec /usr/bin/env -i ", argv[2])
        self.assertEqual(self.check["cwd"], job["WorkingDirectory"])

    def test_a_session_with_its_own_config_dir_gets_the_job_view_not_its_own(self):
        session_env = {**os.environ, "CLAUDE_CONFIG_DIR": str(self.config_dir), "PATH": f"{self.job.bin}:{os.environ['PATH']}"}
        cases = (
            ("[]", "absent"),
            (json.dumps([plugin("other@m", True)]), "absent"),
            (json.dumps([plugin(f"{PLUGIN}@m", False)]), "disabled"),
            (json.dumps([plugin(f"{PLUGIN}@m", True)]), "enabled"),
        )
        for job_list, state in cases:
            with self.subTest(job_list=job_list):
                self.job.lists(job_list, config_dir_out=json.dumps([plugin(f"{PLUGIN}@m", True)]))
                r = self.run_as_hook(session_env)
                self.assertEqual((r.returncode, r.stdout), (0, f"{state}\n"), r.stderr)

    def test_a_failed_list_fails_the_check(self):
        self.job.lists("", 1)
        r = self.run_as_hook(dict(os.environ))
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(r.stdout, "")
        self.assertIn("claude plugin list failed (exit 1)", r.stderr)


if __name__ == "__main__":
    unittest.main()
