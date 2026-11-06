"""Plumb's optional, dependency-free Python syntax and structural policy adapter."""

import ast
import hashlib
import io
import json
import keyword
import os
from pathlib import Path
import re
import stat
import sys
import tokenize
import warnings

VERSION = "1.0.0"
PYTHON = ".".join(map(str, sys.version_info[:3]))
CAPABILITIES = ["syntax", "policy"]
LIMIT = 16 * 1024 * 1024
MODULE = r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*"
DIRECTIVE = re.compile(
    r"(?:^|#)\s*(?:(?:(?:ruff|flake8)\s*:\s*)?noqa\b|type\s*:\s*ignore\b|"
    r"fmt\s*:\s*(?:off|skip)\b|yapf\s*:\s*disable\b|isort\s*:\s*(?:off|skip(?:_file)?)\b|"
    r"autopep8\s*:\s*off\b|black\s*:\s*skip\b|pylint\s*:\s*(?:disable(?:-next)?|skip-file)\b|"
    r"pyright\s*:\s*ignore\b|mypy\s*:\s*ignore-errors\b)", re.IGNORECASE
)
RULES = [
    ("syntax", "Python source parses and compiles without execution.", "Correct the Python syntax, then rerun all checks.", "syntax", False),
    ("input", "Every selected source has the expected bytes and remains readable.", "Restore the selected input and rerun the complete check.", "syntax", False),
    ("protocol", "Requests use the supported protocol and explicit options.", "Correct the adapter request or installation.", "syntax", False),
    ("directive", "Listed lint, type and formatting suppression directives are prohibited.", "Remove the suppression directive and correct the underlying source.", "policy", False),
    ("import", "Import statements respect declared module boundaries.", "Use an allowed import or review a scoped core policy exception.", "policy", True),
]
OPTIONS_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {"forbiddenImports": {
        "type": "array", "uniqueItems": True, "items": {
            "type": "object", "additionalProperties": False, "required": ["module", "reason"],
            "properties": {"module": {"type": "string", "pattern": "^" + MODULE + "$"},
                           "reason": {"type": "string", "minLength": 1, "pattern": r"\S"}},
        },
    }},
}


class Invalid(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Invalid(message)


def shape(value, required, optional=()):
    require(type(value) is dict and set(required) <= value.keys()
            and value.keys() <= set(required) | set(optional), "Unexpected or missing object fields")


def relative_name(value, allow_dot=False):
    require(isinstance(value, str) and value and "\x00" not in value and "\\" not in value
            and not value.startswith("/") and not re.match(r"^[A-Za-z]:", value), "Expected a normalized repository-relative path")
    if value == "." and allow_dot:
        return value
    require(all(part not in ("", ".", "..", ".git", ".hg", ".svn", "node_modules") for part in value.split("/")),
            "Unsafe or non-normalized repository path")
    return value


def safe_path(root, name, directory=False):
    path = root
    for part in ([] if name == "." else name.split("/")):
        path = path / part
        require(not path.is_symlink(), "Symbolic links are not followed")
    mode = path.stat().st_mode
    require(stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode), "Expected a regular directory" if directory else "Expected a regular source file")
    require(path.resolve().is_relative_to(root), "Path escapes the repository")
    return path


def read_source(root, name):
    path = safe_path(root, name)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), "Expected a regular source file")
        value = stream.read(LIMIT + 1)
    require(len(value) <= LIMIT, "Source exceeds the 16 MiB adapter limit")
    safe_path(root, name)
    return value


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def file_hash(path):
    value = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(65536), b""):
            value.update(block)
    return value.hexdigest()


def manifest():
    interpreter, script = str(Path(sys.executable).resolve()), str(Path(__file__).resolve())
    return {"schemaVersion": 1, "adapters": [{
        "id": "python", "version": VERSION, "files": ["**/*.py", "**/*.pyi"], "capabilities": CAPABILITIES,
        "command": [interpreter, "-I", "-S", script],
        "integrity": [{"path": path, "sha256": file_hash(path)} for path in (interpreter, script)],
        "environment": [], "inputs": [], "tools": {"python": PYTHON}, "optionsSchema": OPTIONS_SCHEMA,
        "rules": [{"id": "python/" + name, "description": description, "remedy": remedy,
                   "capability": capability, "suppressible": suppressible}
                  for name, description, remedy, capability, suppressible in RULES],
    }]}


def diagnostic(rule, path, message, status="incomplete", line=None, column=None):
    value = {"rule": "python/" + rule, "path": path, "message": message, "status": status}
    if type(line) is int and line > 0:
        value["line"] = line
    if type(column) is int and column > 0:
        value["column"] = column
    return value


def response(diagnostics=(), coverage=(), inputs=()):
    status = "incomplete" if any(item["status"] == "incomplete" for item in diagnostics) else "violation" if diagnostics else "pass"
    return {"schemaVersion": 1, "adapter": "python", "version": VERSION, "status": status,
            "diagnostics": list(diagnostics), "coverage": list(coverage), "inputs": list(inputs), "versions": {"python": PYTHON}}


def validate(request):
    shape(request, ("schemaVersion", "action", "adapter", "version", "root", "project", "files", "inputs", "capabilities"))
    require(type(request["schemaVersion"]) is int and request["schemaVersion"] == 1, "Unsupported protocol schemaVersion")
    require(request["adapter"] == "python" and request["version"] == VERSION, "Unsupported adapter identity or version")
    require(request["action"] in ("check", "doctor"), "Unsupported action")
    require(type(request["capabilities"]) is list and sorted(request["capabilities"]) == sorted(CAPABILITIES), "Request must declare syntax and policy capabilities exactly once")
    shape(request["project"], ("root", "profile"), ("options", "prepare"))
    project = request["project"]
    require(project["profile"] == "python", "Unsupported project profile")
    if "prepare" in project:
        commands = project["prepare"]
        require(type(commands) is list and commands and all(
            type(command) is list and command and all(isinstance(argument, str) and argument for argument in command)
            for command in commands), "prepare must contain nonempty command argument arrays")
    project_root = relative_name(project["root"], allow_dot=True)
    require(isinstance(request["root"], str) and "\x00" not in request["root"] and os.path.isabs(request["root"]), "Repository root must be absolute")
    root = Path(request["root"]).resolve(strict=True)
    require(root.is_dir(), "Repository root must be a directory")
    safe_path(root, project_root, directory=True)
    options = project.get("options", {})
    shape(options, (), ("forbiddenImports",))
    restrictions = options.get("forbiddenImports", [])
    require(type(restrictions) is list, "forbiddenImports must be an array")
    modules = set()
    for entry in restrictions:
        shape(entry, ("module", "reason"))
        module = entry["module"]
        require(isinstance(module, str) and re.fullmatch(MODULE, module)
                and not any(keyword.iskeyword(part) for part in module.split(".")), "Forbidden module must be a dotted Python identifier")
        require(module not in modules, "Duplicate forbidden module")
        modules.add(module)
        require(isinstance(entry["reason"], str) and entry["reason"].strip(), "Forbidden imports need a nonempty reason")
    observed = []
    for key in ("files", "inputs"):
        require(type(request[key]) is list and len(request[key]) <= 10000, "Input lists must contain at most 10000 files")
        values = {}
        for entry in request[key]:
            shape(entry, ("path", "sha256"))
            path = relative_name(entry["path"])
            require(path.endswith((".py", ".pyi")), "Only .py and .pyi source inputs are supported")
            require(project_root == "." or path.startswith(project_root + "/"), "Source is outside its project root")
            require(path not in values, "Duplicate source input")
            require(entry["sha256"] is None or isinstance(entry["sha256"], str)
                    and re.fullmatch(r"[a-f0-9]{64}", entry["sha256"]), "Input hashes must be SHA-256 or null")
            values[path] = entry["sha256"]
        observed.append(values)
    require(observed[0] == observed[1], "Input evidence must match the selected sources exactly")
    require(request["action"] == "doctor" or observed[0], "No Python source files were selected")
    return root, project_root, restrictions, observed[0]


def import_findings(tree, source, path, project_root, restrictions):
    findings = []
    local = path if project_root == "." else path[len(project_root) + 1:]
    package = local.split("/")[:-1]
    lines = source.splitlines()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        column = len(lines[node.lineno - 1].encode("utf8")[:node.col_offset].decode("utf8")) + 1
        if isinstance(node, ast.Import):
            names, base, star = [alias.name for alias in node.names], "", False
        else:
            if node.level > len(package) + 1:
                findings.append(diagnostic("import", path, "Relative import escapes the declared project namespace; its import policy cannot be checked.", line=node.lineno, column=column))
                continue
            prefix = package[:len(package) - node.level + 1] if node.level else []
            base = ".".join(prefix + ([node.module] if node.module else []))
            names = ([base] if base else []) + [".".join(filter(None, (base, alias.name))) for alias in node.names if alias.name != "*"]
            star = any(alias.name == "*" for alias in node.names)
        for entry in restrictions:
            module = entry["module"]
            if any(name == module or name.startswith(module + ".") for name in names):
                findings.append(diagnostic("import", path, f"Import of {module} is forbidden: {entry['reason']}", "violation", node.lineno, column))
            elif star and (not base or module.startswith(base + ".")):
                findings.append(diagnostic("import", path, f"Wildcard import may select forbidden {module}; use explicit imports to check this boundary.", line=node.lineno, column=column))
    return findings


def check(request):
    root, project_root, restrictions, selected = validate(request)
    if request["action"] == "doctor":
        return response()
    diagnostics, inputs = [], []
    coverage = {capability: [] for capability in CAPABILITIES}
    for path, expected in sorted(selected.items()):
        actual = None
        try:
            raw = read_source(root, path)
            actual = sha256(raw)
            require(actual == expected, "Source hash differs from the requested input")
        except (OSError, ValueError) as error:
            diagnostics.append(diagnostic("input", path, str(error)))
            inputs.append({"path": path, "sha256": actual})
            continue
        inputs.append({"path": path, "sha256": actual})
        coverage["syntax"].append(path)
        try:
            encoding, _ = tokenize.detect_encoding(io.BytesIO(raw).readline)
            source = raw.decode(encoding)
            tokens = list(tokenize.tokenize(io.BytesIO(raw).readline))
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", SyntaxWarning)
                warnings.simplefilter("ignore", DeprecationWarning)
                tree = ast.parse(raw, filename=path, mode="exec")
                compile(tree, path, "exec", dont_inherit=True, optimize=0)
        except (SyntaxError, UnicodeError, LookupError, tokenize.TokenError, ValueError, RecursionError) as error:
            line, column = getattr(error, "lineno", None), getattr(error, "offset", None)
            if isinstance(error, tokenize.TokenError):
                line, column = error.args[1][0], error.args[1][1] + 1
            diagnostics.append(diagnostic("syntax", path, f"{getattr(error, 'msg', str(error))}; structural policy inspection is incomplete.", line=line, column=column))
            continue
        coverage["policy"].append(path)
        for token in tokens:
            if token.type == tokenize.COMMENT and DIRECTIVE.search(token.string[1:]):
                diagnostics.append(diagnostic("directive", path, "Protected suppression directive: " + token.string, "violation", token.start[0], token.start[1] + 1))
        if restrictions:
            diagnostics.extend(import_findings(tree, source, path, project_root, restrictions))
    for item in inputs:
        try:
            current = sha256(read_source(root, item["path"]))
        except (OSError, ValueError):
            current = None
        if current != item["sha256"]:
            diagnostics.append(diagnostic("input", item["path"], "Source changed during the check; rerun against stable inputs."))
    diagnostics.sort(key=lambda item: (item["path"], item.get("line", 0), item.get("column", 0), item["rule"], item["message"]))
    return response(diagnostics, [{"capability": name, "files": files} for name, files in coverage.items()], inputs)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON object field")
        result[key] = value
    return result


def main():
    path = "."
    try:
        require(sys.version_info >= (3, 10), "Python 3.10 or newer is required")
        require(sys.flags.isolated and sys.flags.no_site, "Launch the adapter with Python -I -S")
        if sys.argv[1:] == ["--manifest"]:
            print(json.dumps(manifest(), indent=2))
            return 0
        require(not sys.argv[1:], "Unsupported adapter arguments")
        raw = sys.stdin.buffer.read(LIMIT + 1)
        require(len(raw) <= LIMIT, "Request exceeds the 16 MiB adapter limit")
        request = json.loads(raw.decode("utf8"), object_pairs_hook=unique_object,
                             parse_constant=lambda value: require(False, "Invalid JSON constant " + value))
        if isinstance(request, dict) and isinstance(request.get("project"), dict):
            path = relative_name(request["project"].get("root"), allow_dot=True)
        result = check(request)
    except (OSError, ValueError, TypeError, RecursionError) as error:
        result = response([diagnostic("protocol", path, str(error))])
    print(json.dumps(result, separators=(",", ":")))
    return {"pass": 0, "violation": 1, "incomplete": 2}[result["status"]]


if __name__ == "__main__":
    sys.exit(main())
