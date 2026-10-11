"""hooks/pipeline.ts as the Python tests read it, through node: its exported values, and a call of one of its functions."""
import functools
import json
import pathlib
import subprocess

PIPELINE = (pathlib.Path(__file__).resolve().parent.parent / "hooks" / "pipeline.ts").as_uri()
VALUES = "import(process.argv[1]).then(m => process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v !== 'function')))))"
CALL = "import(process.argv[1]).then(m => process.stdout.write(JSON.stringify(m[process.argv[2]](JSON.parse(process.argv[3])))))"


def node(script, *args):
    r = subprocess.run(["node", "-e", script, PIPELINE, *args], capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


@functools.cache
def exported():
    return node(VALUES)


def call(name, arg):
    return node(CALL, name, json.dumps(arg))
