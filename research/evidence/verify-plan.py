"""Offline integrity checks for the planning deliverables, not runtime QA."""
from pathlib import Path
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
FILES = [
    ROOT / "TECHNICAL_DESIGN.md",
    ROOT / "docs/agentic-roadmap.md",
    *[ROOT / "research" / name for name in (
        "01-clicky-product.md", "02-harness-options.md",
        "03-execution-and-safety.md", "04-codebase-assessment.md",
        "05-verification.md", "06-design-review.md",
    )],
]
for file in FILES:
    assert file.is_file(), file
    text = file.read_text()
    assert text.endswith("\n"), file
    assert not any(line != line.rstrip() for line in text.splitlines()), file

roadmap = FILES[1].read_text()
phase_ids = re.findall(r"^## Phase (\d+) —", roadmap, flags=re.M)
assert phase_ids == list(map(str, range(9))), phase_ids
tickets = re.findall(r"^\| (P\d+\.\d+) \|", roadmap, flags=re.M)
assert len(tickets) == len(set(tickets)), "duplicate ticket"
references = set(re.findall(r"\bP\d+\.\d+\b", roadmap))
assert references <= set(tickets), references - set(tickets)

# Current-code citations must refer to real files and real line bounds.
# Proposed repository trees/interfaces without line numbers are intentionally not checked.
citations = []
for file in FILES[:2]:
    for match in re.finditer(r"((?:apps|crates)/[\w./-]+\.[\w]+):(\d+)(?:-(\d+))?", file.read_text()):
        path, first, last = match.groups()
        target = ROOT / path
        assert target.is_file(), (file, path)
        total = len(target.read_text().splitlines())
        assert 1 <= int(first) <= int(last or first) <= total, (path, first, last, total)
        citations.append((path, first, last))

# No downloaded movies/pages/upstream source trees are accidentally offered to Git.
untracked = subprocess.run(
    ["git", "ls-files", "--others", "--exclude-standard", "-z"],
    cwd=ROOT, check=True, capture_output=True,
).stdout.decode().split("\0")
untracked = [path for path in untracked if path]
assert not any(path.endswith((".raw", ".jpg", ".mp4", ".html")) for path in untracked), untracked
tracked_changes = subprocess.run(
    ["git", "diff", "--name-only"], cwd=ROOT, check=True,
    capture_output=True, text=True,
).stdout.splitlines()
assert not any(path.startswith(("apps/", "crates/")) for path in tracked_changes), tracked_changes
subprocess.run(["git", "diff", "--check"], cwd=ROOT, check=True)

probe = json.loads((ROOT / "research/evidence/harness-ai-probe-result.json").read_text())
checks = probe["checks"]
assert probe["version"] == "7.0.156", probe["version"]
assert checks["deniedExecutionCount"] == 0
assert checks["approvalCount"] == 1
assert checks["steeringOutcome"]["type"] == "delivered"
assert checks["streamedText"] == "stream-ok"
assert checks["unguardedAbortToolInvocations"] == 1
assert checks["guardedAbortToolInvocations"] == 0

print(json.dumps({
    "deliverables_present": len(FILES),
    "phases": phase_ids,
    "unique_roadmap_tasks": len(tickets),
    "all_ticket_references_resolve": True,
    "current_code_citations_checked": len(citations),
    "no_runtime_source_changes": True,
    "no_bulky_downloads_unignored": True,
    "sdk_probe_assertions": "pass",
    "limits": "Document integrity and recorded mock checks only; not a harness, sandbox or live-provider certification.",
}, indent=2))
