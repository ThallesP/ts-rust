#!/usr/bin/env python3
"""Differential LSP oracle runner: pinned tsgo against `goport --lsp --stdio`.

Design: target/continuation-r97-goport/ls-port/map-oracle.md sections 2 and 3
(main checkout). The script mirrors these Go files (pinned dc37b5249):

  internal/jsonrpc/baseproto.go               Content-Length framing (Reader, Writer)
  internal/testutil/lsptestutil/lspclient.go  request ids, answers to server requests
  internal/lsp/replay_test.go                 @PROJECT_ROOT@ placeholders, replay format
  internal/ls/lsconv/converters.go            FileNameToDocumentURI (root URI)
  internal/fourslash/fourslash.go             default client capabilities

Commands:
  record       --battery B [--oracle BIN] [--jobs N] [--force] [--only S]
  selfcheck    --battery B [--oracle BIN] [--jobs N] [--runs N] [--only S]
  check        --battery B --goport BIN --label L [--methods m1,m2] [--jobs N] [--only S]
  summary      --label L [--baseline L0]
  show         --label L --trace T --event K [--battery B]
  replay       --trace FILE --server "CMD" [--verbose] [--simple | --super-simple]
  to-go-replay --trace FILE [--golden FILE] > x.jsonl

Files under --out-root (default /home/theo/Code/sandbox/ts-rust/target/goport-lsp):
  traces/<battery>/<trace>.jsonl[.gz]                      input (or --traces-dir)
  golden/<oracle-sha12>/<battery>/<trace>.golden.jsonl.gz  tsgo answers, frozen params
  golden/<oracle-sha12>/<battery>/<trace>.flaky.json       selfcheck result
  golden/<oracle-sha12>/<battery>/{record,selfcheck}-summary.json
  results/<label>/summary.json, summary.md                 counts only, no payloads
  results/<label>/traces/<battery>/<trace>.json            per-request classes
  results/<label>/responses/<battery>/<trace>.jsonl.gz     goport answers (for `show`)
A battery name with no directory of its own selects every `<name>-*` directory
(`--battery b1` runs b1-inline, b1-query-core, ...).

Trace format goport-lsp-trace/1 (JSONL). Line 1 is the header:
  format, name, source, root, cwd, config, compilerOptionsForInferredProjects
  root: {"kind": "materialize", "files": {"rel/path": "text" | {"symlink": "target"}}}
     or {"kind": "project", "dir": "/abs/read-only/dir"}
  Optional: positionEncoding ("utf-16" default), used only when the
  initialize event has no params.
Each later line is one event. Events are numbered from 0 (the line after the
header). Event 0 must be the `initialize` request.
  {"kind": "request", "method": M, "params": P}           params optional
  {"kind": "request", "method": M, "paramsFrom": F}       dependent request
  {"kind": "notification", "method": M, "params": P}
  {"kind": "fs", "op": "write" | "append" | "remove", "path": "rel", "content": "text"}
  {"kind": "reply", "method": M, "result": R}             answer to the next server request M
  {"kind": "expect", "event": K, "response": R}            informational fidelity check
paramsFrom: {"event": K, "pointer": "/items", "pick": PICK, "into": INTO}
  The value at `pointer` in the result of event K (normalized oracle answer).
  PICK (optional, the value must be an array):
    {"sortBy": ["sortText", "label"], "index": 0}  sort by those fields (missing
                                                   field sorts as ""), then index
    {"match": {"label": "x"}}                      first element with those fields
    {"index": 0}                                   element by position
  INTO (optional): without it the value is the params. A string pointer puts
  the value at that place in the event's own `params`. A list
  [{"to": "/range", "from": "/range"}, {"to": "/context/diagnostics/0", "from": ""}]
  puts parts of the value at several places.
  A value that cannot be found makes the request `not_run` (the id is still used).
Request ids are the request's ordinal among the trace's request events, from 1,
so both servers get the same ids. `initialized` follows the initialize answer;
`shutdown` (id N+1, no params) and `exit` end every session.

Compare: both answers drop initialize serverInfo.version, and completion items
sort. check also drops one "refactor.rewrite" from the port's initialize
codeActionKinds when Go's list lacks it (decision D1 option B, drop_d1_kind).

Exit status: 0 done, 1 a trace failed in the harness, 2 usage error or a safety
refusal, 3 a project input changed during the run.
"""

import argparse
import collections
import concurrent.futures
import copy
import difflib
import gzip
import hashlib
import itertools
import json
import os
import queue
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time

TRACE_FORMAT = "goport-lsp-trace/1"
GOLDEN_FORMAT = "goport-lsp-golden/1"
FLAKY_FORMAT = "goport-lsp-flaky/1"
RESULT_FORMAT = "goport-lsp-result/1"
SUMMARY_FORMAT = "goport-lsp-summary/1"

DEFAULT_OUT_ROOT = "/home/theo/Code/sandbox/ts-rust/target/goport-lsp"
DEFAULT_ORACLE = os.path.expanduser("~/.local/bin/tsgo-oracle")
PROJECT_INPUTS = "/home/theo/Code/sandbox/ts-rust/target/project-inputs"

# Go: lsp/replay_test.go:87 default placeholders.
ROOT_DIR_PLACEHOLDER = "@PROJECT_ROOT@"
ROOT_DIR_URI_PLACEHOLDER = "@PROJECT_ROOT_URI@"
# The per-trace temp dir (HOME lives there). Not in the Go format; it keeps
# paths of the redirected HOME equal between runs.
RUN_DIR_PLACEHOLDER = "@RUN_DIR@"
RUN_DIR_URI_PLACEHOLDER = "@RUN_DIR_URI@"

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_INPUT_CHANGED = 3
# PORTING.md "Exit codes": goport exits 70 (EX_SOFTWARE) after unported code. Always a crash.
EXIT_UNPORTED = 70

INITIALIZE_TIMEOUT = 30.0
REQUEST_TIMEOUT = {"oracle": 60.0, "goport": 120.0, "server": 120.0}
SHUTDOWN_TIMEOUT = 30.0
EXIT_WAIT = 10.0
# Go disposes idle checkers after 30 s (project/checkerpool.go:91).
TIMING_RISK_GAP = 25.0

# Go: lsp/lsproto ErrorCodeMethodNotFound
ERROR_CODE_METHOD_NOT_FOUND = -32601
ERROR_CODE_INTERNAL_ERROR = -32603

DROPPED_SERVER_METHODS = (
    "window/logMessage",
    "$/progress",
    "$/logTrace",
    "telemetry/event",
    "window/workDoneProgress/create",
)
NULL_ANSWER_METHODS = (
    "client/registerCapability",
    "client/unregisterCapability",
    "window/workDoneProgress/create",
)
FORBIDDEN_ANCESTOR_ENTRIES = ("tsconfig.json", "jsconfig.json", "package.json", "node_modules")
EVENT_KINDS = ("request", "notification", "fs", "reply", "expect")
CLASSES = (
    "same",
    "diff",
    "goport_error",
    "oracle_error_same",
    "oracle_error_diff",
    "timeout",
    "crash",
    "not_run",
    "skipped_method",
    "flaky_oracle",
)
DIVERGENT_CLASSES = ("diff", "goport_error", "oracle_error_diff", "timeout", "crash")

MISSING = object()


class UsageError(Exception):
    """Bad arguments or a safety refusal (exit 2)."""


class TraceError(Exception):
    """A trace or golden file that the harness cannot run."""


class InputChanged(Exception):
    """A project input changed during the run (exit 3)."""


# ---------------------------------------------------------------------------
# JSON-RPC framing
# ---------------------------------------------------------------------------

# Go: jsonrpc/baseproto.go:15 ErrInvalidHeader, ErrInvalidContentLength, ErrNoContentLength
ERR_INVALID_HEADER = "jsonrpc: invalid header"
ERR_INVALID_CONTENT_LENGTH = "jsonrpc: invalid content length"
ERR_NO_CONTENT_LENGTH = "jsonrpc: no content length"

_PARSE_INT_RE = re.compile(rb"[+-]?[0-9]+\Z")


class JsonRpcError(Exception):
    pass


def go_quote_bytes(b: bytes) -> str:
    # PORT: Go %q of a byte slice; json string quoting is close enough for error text.
    return json.dumps(b.decode("utf-8", errors="replace"))


class Reader:
    """Go: jsonrpc/baseproto.go:22 Reader. Reads JSON-RPC messages with Content-Length framing."""

    # Go: baseproto.go:27 NewReader
    def __init__(self, r):
        self.r = r

    # Go: baseproto.go:34 Read
    def read(self) -> bytes:
        content_length = 0

        while True:
            line = self.r.readline()
            if not line.endswith(b"\n"):
                # PORT: bufio ReadBytes('\n') fails with io.EOF when no '\n' follows.
                raise EOFError

            if line == b"\r\n":
                break

            key, sep, value = line.partition(b":")
            if not sep:
                raise JsonRpcError(f"{ERR_INVALID_HEADER}: {go_quote_bytes(line)}")

            if key == b"Content-Length":
                text = value.strip()
                if not _PARSE_INT_RE.match(text) or abs(int(text)) > 2**63 - 1:
                    raise JsonRpcError(
                        f"{ERR_INVALID_CONTENT_LENGTH}: parse error: strconv.ParseInt: "
                        f"parsing {go_quote_bytes(text)}: invalid syntax"
                    )
                content_length = int(text)
                if content_length < 0:
                    raise JsonRpcError(f"{ERR_INVALID_CONTENT_LENGTH}: negative value {content_length}")

        if content_length <= 0:
            raise JsonRpcError(ERR_NO_CONTENT_LENGTH)

        data = self.r.read(content_length)
        if len(data) != content_length:
            raise JsonRpcError("jsonrpc: read content: unexpected EOF")

        return data


class Writer:
    """Go: jsonrpc/baseproto.go:80 Writer. Writes JSON-RPC messages with Content-Length framing."""

    # Go: baseproto.go:85 NewWriter
    def __init__(self, w):
        self.w = w

    # Go: baseproto.go:92 Write
    def write(self, data: bytes):
        self.w.write(b"Content-Length: %d\r\n\r\n" % len(data))
        self.w.write(data)
        self.w.flush()


def encode_message(msg) -> bytes:
    return json.dumps(msg, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def message_kind(msg) -> str:
    if "method" in msg and "id" in msg:
        return "request"
    if "method" in msg:
        return "notification"
    return "response"


# ---------------------------------------------------------------------------
# URIs and placeholders
# ---------------------------------------------------------------------------


class Replacer:
    """Go strings.NewReplacer: left to right, no overlaps, the first matching
    old string in argument order wins at each position."""

    def __init__(self, *oldnew):
        self.table = {}
        olds = []
        for old, new in zip(oldnew[0::2], oldnew[1::2]):
            if old and old not in self.table:
                self.table[old] = new
                olds.append(old)
        self.re = re.compile("|".join(re.escape(o) for o in olds)) if olds else None

    def replace(self, s: str) -> str:
        if self.re is None:
            return s
        return self.re.sub(lambda m: self.table[m.group(0)], s)

    def value(self, v):
        """Replace in every string of a JSON value, object keys included."""
        if isinstance(v, str):
            return self.replace(v)
        if isinstance(v, list):
            return [self.value(x) for x in v]
        if isinstance(v, dict):
            return {self.replace(k): self.value(x) for k, x in v.items()}
        return v


IDENTITY = Replacer()

# Go: ls/lsconv/converters.go:86 extraEscapeReplacer
EXTRA_ESCAPE_REPLACER = Replacer(
    ":", "%3A",
    "/", "%2F",
    "?", "%3F",
    "#", "%23",
    "[", "%5B",
    "]", "%5D",
    "@", "%40",
    "!", "%21",
    "$", "%24",
    "&", "%26",
    "'", "%27",
    "(", "%28",
    ")", "%29",
    "*", "%2A",
    "+", "%2B",
    ",", "%2C",
    ";", "%3B",
    "=", "%3D",
    " ", "%20",
)


def url_path_escape(s: str) -> str:
    # Go net/url PathEscape (shouldEscape with encodePathSegment): unreserved
    # characters and "$&+:=@" stay, every other byte is %XX (upper case hex).
    out = []
    for b in s.encode("utf-8"):
        c = chr(b)
        if b < 0x80 and (c.isalnum() or c in "-_.~$&+:=@"):
            out.append(c)
        else:
            out.append("%%%02X" % b)
    return "".join(out)


# Go: tspath/path.go:1093 SplitVolumePath
def split_volume_path(path: str):
    if len(path) >= 2 and path[0].isascii() and path[0].isalpha() and path[1] == ":":
        return path[0:2].lower(), path[2:], True
    return "", path, False


# Go: ls/lsconv/converters.go:110 FileNameToDocumentURI
def file_name_to_document_uri(file_name: str) -> str:
    if file_name.startswith("bundled:///"):
        # PORT: bundled.IsBundled
        return file_name
    if file_name.startswith("^/"):
        # Go: tspath.IsDynamicFileName
        scheme, sep, rest = file_name[2:].partition("/")
        if not sep:
            raise ValueError("invalid file name: " + file_name)
        authority, sep, path = rest.partition("/")
        if not sep:
            raise ValueError("invalid file name: " + file_name)
        if authority == "ts-nul-authority":
            return scheme + ":" + path
        return scheme + "://" + authority + "/" + path

    volume, file_name, _ = split_volume_path(file_name)
    if volume != "":
        volume = "/" + EXTRA_ESCAPE_REPLACER.replace(volume)

    if file_name.startswith("//"):
        file_name = file_name[2:]

    parts = file_name.split("/")
    parts = [EXTRA_ESCAPE_REPLACER.replace(url_path_escape(part)) for part in parts]

    return "file://" + volume + "/".join(parts)


# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------


def canon(v) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def pointer_tokens(pointer: str):
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise ValueError(f"bad JSON pointer {pointer!r}")
    return [t.replace("~1", "/").replace("~0", "~") for t in pointer[1:].split("/")]


def pointer_from_path(path) -> str:
    return "".join("/" + str(t).replace("~", "~0").replace("/", "~1") for t in path)


def pointer_get(v, pointer):
    tokens = pointer_tokens(pointer) if isinstance(pointer, str) else list(pointer)
    for t in tokens:
        if isinstance(v, dict):
            if t not in v:
                return MISSING
            v = v[t]
        elif isinstance(v, list):
            if isinstance(t, int):
                i = t
            elif isinstance(t, str) and t.isdigit():
                i = int(t)
            else:
                return MISSING
            if i >= len(v):
                return MISSING
            v = v[i]
        else:
            return MISSING
    return v


def pointer_set(root, pointer: str, value):
    """Set `value` at `pointer` inside `root` (dicts are created on the way). Returns the new root."""
    tokens = pointer_tokens(pointer)
    if not tokens:
        return value
    cur = root
    for n, t in enumerate(tokens):
        last = n == len(tokens) - 1
        if isinstance(cur, list):
            if not t.isdigit() or int(t) > len(cur):
                raise TraceError(f"cannot set {pointer}: bad index {t}")
            i = int(t)
            if last:
                if i == len(cur):
                    cur.append(value)
                else:
                    cur[i] = value
                return root
            if i == len(cur):
                cur.append({})
            if not isinstance(cur[i], (dict, list)):
                cur[i] = {}
            cur = cur[i]
        elif isinstance(cur, dict):
            if last:
                cur[t] = value
                return root
            if not isinstance(cur.get(t), (dict, list)):
                cur[t] = {}
            cur = cur[t]
        else:
            raise TraceError(f"cannot set {pointer}: not a container")
    return root


def first_diff_path(a, b, path=()):
    """Path (tuple; ints for array indices) of the first difference, or None."""
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                return path + (k,)
            sub = first_diff_path(a[k], b[k], path + (k,))
            if sub is not None:
                return sub
        return None
    if isinstance(a, list) and isinstance(b, list):
        for i in range(min(len(a), len(b))):
            sub = first_diff_path(a[i], b[i], path + (i,))
            if sub is not None:
                return sub
        if len(a) != len(b):
            return path
        return None
    if canon(a) != canon(b):
        return path
    return None


def deep_sort(x):
    if isinstance(x, dict):
        return {k: deep_sort(v) for k, v in x.items()}
    if isinstance(x, list):
        return sorted((deep_sort(e) for e in x), key=canon)
    return x


def multiset_key(x) -> str:
    # Order-free key: equal for elements that differ only in inner array order.
    return canon(deep_sort(x))


def parse_pattern(pattern: str):
    return tuple(pointer_tokens(pattern))


def generalize(path):
    return tuple("*" if isinstance(t, int) else t for t in path)


def pattern_string(pattern) -> str:
    return "".join("/" + ("*" if t == "*" else str(t).replace("~", "~0").replace("/", "~1")) for t in pattern)


def apply_multisets(v, patterns):
    """Sort every array whose generalized path (array index = "*") is in `patterns`.
    Inner arrays sort first. Rule 6 of map-oracle.md 3.4."""
    if not patterns:
        return v
    pats = {parse_pattern(p) for p in patterns}

    def walk(x, path):
        if isinstance(x, dict):
            return {k: walk(val, path + (k,)) for k, val in x.items()}
        if isinstance(x, list):
            items = [walk(e, path + ("*",)) for e in x]
            if path in pats:
                items.sort(key=multiset_key)
            return items
        return x

    return walk(v, ())


def find_unstable(a0, b0, max_rounds=64):
    """Compare two oracle results. Returns (multiset patterns, unstable pointer or None)."""
    patterns = []
    for _ in range(max_rounds):
        a = apply_multisets(a0, patterns)
        b = apply_multisets(b0, patterns)
        d = first_diff_path(a, b)
        if d is None:
            return patterns, None
        found = False
        for k in range(len(d), -1, -1):
            p = d[:k]
            va, vb = pointer_get(a, p), pointer_get(b, p)
            if not (isinstance(va, list) and isinstance(vb, list)) or len(va) != len(vb):
                continue
            pat = pattern_string(generalize(p))
            if pat in patterns:
                continue
            if sorted(map(multiset_key, va)) == sorted(map(multiset_key, vb)):
                patterns.append(pat)
                found = True
                break
        if not found:
            return patterns, pointer_from_path(d)
    return patterns, "(too many rounds)"


# ---------------------------------------------------------------------------
# Session setup: capabilities, configuration, ATA
# ---------------------------------------------------------------------------

# Go: fourslash/fourslash.go:344 defaultSemanticTokenTypes
DEFAULT_SEMANTIC_TOKEN_TYPES = [
    "namespace", "class", "enum", "interface", "struct", "typeParameter", "type", "parameter",
    "variable", "property", "enumMember", "decorator", "event", "function", "method", "macro",
    "label", "comment", "string", "keyword", "number", "regexp", "operator",
]
# Go: fourslash/fourslash.go:372 defaultSemanticTokenModifiers
DEFAULT_SEMANTIC_TOKEN_MODIFIERS = [
    "declaration", "definition", "readonly", "static", "deprecated", "abstract", "async",
    "modification", "documentation", "defaultLibrary", "local",
]


# Go: fourslash/fourslash.go:562 getCapabilitiesWithDefaults (capabilities == nil)
def get_capabilities_with_defaults(position_encoding: str):
    # PORT: Go always uses utf-8; sweeps pass utf-16 (map-oracle.md 3.3).
    markdown_plain = ["markdown", "plaintext"]
    diagnostic_tags = {"valueSet": [1, 2]}  # DiagnosticTagUnnecessary, DiagnosticTagDeprecated
    return {
        "general": {"positionEncodings": [position_encoding]},
        "experimental": {"hoverVerbosityLevel": True},
        "textDocument": {
            "completion": {
                "completionItem": {
                    "snippetSupport": True,
                    "commitCharactersSupport": True,
                    "preselectSupport": True,
                    "labelDetailsSupport": True,
                    "insertReplaceSupport": True,
                    "documentationFormat": markdown_plain,
                },
                "completionList": {"itemDefaults": ["commitCharacters", "editRange"]},
            },
            "diagnostic": {"relatedInformation": True, "tagSupport": diagnostic_tags},
            "publishDiagnostics": {"relatedInformation": True, "tagSupport": diagnostic_tags},
            "semanticTokens": {
                "requests": {"full": True},
                "tokenTypes": DEFAULT_SEMANTIC_TOKEN_TYPES,
                "tokenModifiers": DEFAULT_SEMANTIC_TOKEN_MODIFIERS,
                "formats": ["relative"],
            },
            "definition": {"linkSupport": True},
            "typeDefinition": {"linkSupport": True},
            "implementation": {"linkSupport": True},
            "hover": {"contentFormat": markdown_plain},
            "signatureHelp": {
                "signatureInformation": {
                    "documentationFormat": markdown_plain,
                    "parameterInformation": {"labelOffsetSupport": True},
                    "activeParameterSupport": True,
                },
                "contextSupport": True,
            },
            "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
            "foldingRange": {
                "rangeLimit": 5000,
                "foldingRangeKind": {"valueSet": ["comment", "imports", "region"]},
                "foldingRange": {"collapsedText": True},
            },
        },
        "workspace": {
            "fileOperations": {"willRename": True},
            "workspaceEdit": {"documentChanges": True, "resourceOperations": ["rename"]},
            "configuration": True,
        },
    }


def default_initialize_params(header):
    return {
        "processId": None,
        "rootUri": ROOT_DIR_URI_PLACEHOLDER,
        "locale": "en-US",
        "capabilities": get_capabilities_with_defaults(header.get("positionEncoding") or "utf-16"),
        "initializationOptions": {"disablePushDiagnostics": True, "logVerbosity": 0},
    }


def with_ata_off(section):
    """Copy of a `js/ts` settings object with tsserver.automaticTypeAcquisition.enabled = false.
    Go reads that path last and it wins over every other ATA setting
    (ls/lsutil/userpreferences.go ParseUserPreferences, IsAutomaticTypeAcquisitionDisabled)."""
    s = copy.deepcopy(section) if isinstance(section, dict) else {}
    cur = s
    for part in ("tsserver", "automaticTypeAcquisition"):
        nxt = cur.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[part] = nxt
        cur = nxt
    cur["enabled"] = False
    return s


def initialize_params(ev, header):
    """Params of the initialize event, with the harness settings forced (placeholder form)."""
    params = copy.deepcopy(ev["params"]) if isinstance(ev.get("params"), dict) else default_initialize_params(header)
    # A real process id makes the server watch that process; never send one.
    params["processId"] = None
    opts = params.get("initializationOptions")
    opts = copy.deepcopy(opts) if isinstance(opts, dict) else {}
    opts.setdefault("disablePushDiagnostics", True)
    opts.setdefault("logVerbosity", 0)
    caps = params.get("capabilities") if isinstance(params.get("capabilities"), dict) else {}
    workspace = caps.get("workspace") if isinstance(caps.get("workspace"), dict) else {}
    # Go: lsp/server.go RequestConfiguration reads initializationOptions.userPreferences
    # as the js/ts section when the client has no workspace.configuration.
    if workspace.get("configuration") is not True or isinstance(opts.get("userPreferences"), dict):
        opts["userPreferences"] = with_ata_off(opts.get("userPreferences"))
    params["initializationOptions"] = opts
    return params


def notification_params(ev):
    """Params of a notification event, ATA forced off in workspace/didChangeConfiguration."""
    if "params" not in ev:
        return MISSING
    params = copy.deepcopy(ev["params"])
    if ev.get("method") == "workspace/didChangeConfiguration" and isinstance(params, dict):
        settings = params.get("settings")
        # Go: lsp/server.go handleDidChangeWorkspaceConfiguration ignores nil and non-object settings.
        if isinstance(settings, dict):
            settings["js/ts"] = with_ata_off(settings.get("js/ts"))
    return params


def configuration_result(req_params, config, reply_result=MISSING):
    """Answer to workspace/configuration: the recorded reply or the header config, ATA off."""
    items = req_params.get("items") if isinstance(req_params, dict) else None
    items = items if isinstance(items, list) else []
    if reply_result is not MISSING:
        result = copy.deepcopy(reply_result)
    else:
        config = config if isinstance(config, dict) else {}
        result = [copy.deepcopy(config.get(it.get("section"))) if isinstance(it, dict) else None for it in items]
    if isinstance(result, list):
        for j, it in enumerate(items):
            if j < len(result) and isinstance(it, dict) and it.get("section") == "js/ts":
                result[j] = with_ata_off(result[j])
    return result


# ---------------------------------------------------------------------------
# Normalization and classification (map-oracle.md 3.4, 3.5)
# ---------------------------------------------------------------------------


def normalize_response(method, msg, norm: Replacer):
    """Returns (status, record). status is "ok" or "error"."""
    err = msg.get("error")
    if err is not None:
        err = err if isinstance(err, dict) else {"message": str(err)}
        message = str(err.get("message", "")).split("\n", 1)[0]
        return "error", {"error": {"code": err.get("code"), "message": norm.replace(message)}}
    if "result" not in msg:
        return "ok", {"missingResult": True}
    result = norm.value(msg["result"])
    if method == "initialize" and isinstance(result, dict) and isinstance(result.get("serverInfo"), dict):
        result["serverInfo"].pop("version", None)
    if method == "textDocument/completion":
        # Go map order makes the item order random (map-oracle.md 2).
        if isinstance(result, dict) and isinstance(result.get("items"), list):
            result["items"] = sorted(result["items"], key=canon)
        elif isinstance(result, list):
            result = sorted(result, key=canon)
    return "ok", {"result": result}


# Decision D1 option B (Theo, 2026-10-11, note theo-decisions-approval-2026-10-11):
# the port lists "refactor.rewrite" in the initialize answer's
# capabilities.codeActionProvider.codeActionKinds, as effect-tsgo 0.51.1 patch 017
# does. Plain Go does not.
D1_EXTRA_KIND = "refactor.rewrite"


def initialize_code_action_kinds(result):
    """The codeActionKinds list of an initialize result, or None."""
    caps = result.get("capabilities") if isinstance(result, dict) else None
    provider = caps.get("codeActionProvider") if isinstance(caps, dict) else None
    kinds = provider.get("codeActionKinds") if isinstance(provider, dict) else None
    return kinds if isinstance(kinds, list) else None


def drop_d1_kind(method, g_result, r_result):
    """Returns the port's result (r_result) to compare with Go's (g_result).

    For initialize only, when Go's codeActionKinds lacks D1_EXTRA_KIND and the
    port's has it, it returns a copy of r_result without one D1_EXTRA_KIND.
    Every other kind and every other part of the answer stays. In all other
    cases it returns r_result as it is (an E0 oracle that lists the kind
    compares it as usual). The saved responses keep the port's answer.
    """
    if method != "initialize":
        return r_result
    g_kinds = initialize_code_action_kinds(g_result)
    r_kinds = initialize_code_action_kinds(r_result)
    if g_kinds is None or r_kinds is None or D1_EXTRA_KIND in g_kinds or D1_EXTRA_KIND not in r_kinds:
        return r_result
    out = copy.deepcopy(r_result)
    out["capabilities"]["codeActionProvider"]["codeActionKinds"].remove(D1_EXTRA_KIND)
    return out


_UNPORTED_RE = re.compile(r"unported Go code: (.*)$")


def error_class(err) -> str:
    message = str(err.get("message", ""))
    m = _UNPORTED_RE.search(message)
    if m:
        return "unported:" + m.group(1).strip()
    if "unported" in message:
        return "unported:?"
    code = err.get("code")
    if code == ERROR_CODE_METHOD_NOT_FOUND:
        return "method_not_found"
    if code == ERROR_CODE_INTERNAL_ERROR:
        return "internal"
    return "other"


def classify(golden_rec, run_rec, flaky_ev):
    """Returns (class, sub, pointer) for one request."""
    rs = run_rec.get("status")
    if rs not in ("ok", "error"):
        return rs, run_rec.get("reason"), None
    gs = golden_rec.get("status")
    g_resp, r_resp = golden_rec.get("response"), run_rec.get("response")
    sub = error_class(r_resp["error"]) if rs == "error" else None
    if sub is not None and sub.startswith("unported:"):
        return "goport_error", sub, None
    if gs == "error":
        if rs == "error" and canon(g_resp) == canon(r_resp):
            return "oracle_error_same", None, None
        return "oracle_error_diff", sub, None
    if rs == "error":
        return "goport_error", sub, None
    if flaky_ev and flaky_ev.get("unstable"):
        return "flaky_oracle", None, None
    if "result" not in g_resp or "result" not in r_resp:
        same = canon(g_resp) == canon(r_resp)
        return ("same", None, None) if same else ("diff", None, "")
    patterns = (flaky_ev or {}).get("multiset") or []
    a = apply_multisets(g_resp["result"], patterns)
    b = apply_multisets(drop_d1_kind(golden_rec.get("method"), g_resp["result"], r_resp["result"]), patterns)
    if canon(a) == canon(b):
        return "same", None, None
    d = first_diff_path(a, b)
    return "diff", None, pointer_from_path(d or ())


def method_selected(method, methods):
    if not methods:
        return True
    return method in methods or method.rsplit("/", 1)[-1] in methods


# ---------------------------------------------------------------------------
# Safety
# ---------------------------------------------------------------------------


def is_within(path, root) -> bool:
    path, root = os.path.realpath(path), os.path.realpath(root)
    return path == root or path.startswith(root.rstrip("/") + "/")


def guard_dir_for(project_dir: str) -> str:
    # Same rule as scripts/tsgo-oracle.sh: protect the whole prepared input root.
    m = re.match(r"^(.*/project-inputs/[^/]+/source)/", project_dir.rstrip("/") + "/")
    return m.group(1) if m else project_dir


def check_materialized_root(root: str):
    if not re.fullmatch(r"[a-z0-9/_-]+", root):
        raise UsageError(
            f"materialized root {root} has characters outside [a-z0-9/_-]; set TMPDIR to such a path (for example /tmp)"
        )
    p = os.path.dirname(root)
    while True:
        for name in FORBIDDEN_ANCESTOR_ENTRIES:
            if os.path.lexists(os.path.join(p, name)):
                raise UsageError(f"refusing materialized root {root}: {os.path.join(p, name)} exists (tsgo walks up)")
        if p == "/":
            break
        p = os.path.dirname(p)


def check_input_unchanged(guard: str, marker: str):
    out = subprocess.run(
        ["find", guard, "-newer", marker, "-not", "-type", "d", "-print", "-quit"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    return out.stdout.strip() or None


def safe_join(root: str, rel: str) -> str:
    if not isinstance(rel, str) or not rel or os.path.isabs(rel):
        raise TraceError(f"bad relative path {rel!r}")
    norm = os.path.normpath(rel)
    if norm == ".." or norm.startswith("../") or norm == ".":
        raise TraceError(f"path {rel!r} leaves the root")
    path = os.path.join(root, norm)
    if not is_within(os.path.dirname(path), root):
        raise TraceError(f"path {rel!r} leaves the root through a symlink")
    return path


def write_root_file(root: str, rel: str, content, expand: Replacer):
    path = safe_join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if isinstance(content, str):
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(expand.replace(content))
    elif isinstance(content, dict) and isinstance(content.get("symlink"), str):
        target = expand.replace(content["symlink"])
        resolved = target if os.path.isabs(target) else os.path.join(os.path.dirname(path), target)
        if not is_within(resolved, root):
            raise TraceError(f"symlink {rel!r} -> {target!r} leaves the root")
        os.symlink(target, path)
    else:
        raise TraceError(f"file {rel!r}: content must be a string or {{\"symlink\": target}}")


# ---------------------------------------------------------------------------
# Trace and golden files
# ---------------------------------------------------------------------------


def load_trace(path):
    """Returns (header, events, sha256 of the file)."""
    with open(path, "rb") as f:
        raw = f.read()
    text = gzip.decompress(raw).decode("utf-8") if path.endswith(".gz") else raw.decode("utf-8")
    lines = [line for line in text.split("\n") if line.strip()]
    if not lines:
        raise TraceError("empty trace")
    try:
        header = json.loads(lines[0])
        events = [json.loads(line) for line in lines[1:]]
    except ValueError as e:
        raise TraceError(f"invalid JSON: {e}") from None
    validate_trace(header, events)
    return header, events, sha256_bytes(raw)


def validate_trace(header, events):
    if not isinstance(header, dict) or header.get("format") != TRACE_FORMAT:
        raise TraceError(f"header format is not {TRACE_FORMAT}")
    root = header.get("root")
    if not isinstance(root, dict) or root.get("kind") not in ("materialize", "project"):
        raise TraceError("header root.kind must be materialize or project")
    if not events or events[0].get("kind") != "request" or events[0].get("method") != "initialize":
        raise TraceError("event 0 must be the initialize request")
    for i, ev in enumerate(events):
        if not isinstance(ev, dict) or ev.get("kind") not in EVENT_KINDS:
            raise TraceError(f"event {i}: unknown kind")
        if ev["kind"] in ("request", "notification", "reply") and not isinstance(ev.get("method"), str):
            raise TraceError(f"event {i}: missing method")
        pf = ev.get("paramsFrom")
        if pf is not None:
            if ev["kind"] != "request" or not isinstance(pf, dict) or not isinstance(pf.get("event"), int):
                raise TraceError(f"event {i}: bad paramsFrom")
            if not 0 <= pf["event"] < i:
                raise TraceError(f"event {i}: paramsFrom must name an earlier event")
        if ev["kind"] == "fs":
            if ev.get("op") not in ("write", "append", "remove") or not isinstance(ev.get("path"), str):
                raise TraceError(f"event {i}: bad fs event")
            if root.get("kind") == "project":
                raise TraceError(f"event {i}: fs events are refused on read-only project roots")


def write_golden(path, header_line, records):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=6) as f:
        f.write(json.dumps(header_line, ensure_ascii=False, separators=(",", ":")) + "\n")
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(tmp, path)


def read_golden(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        header = json.loads(f.readline())
        records = [json.loads(line) for line in f if line.strip()]
    if header.get("format") != GOLDEN_FORMAT:
        raise TraceError(f"{path}: not a {GOLDEN_FORMAT} file")
    return header, records


def read_golden_header(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.loads(f.readline())


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=1, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def expand_batteries(base: str, battery: str):
    """[(battery name, dir)] for a comma list; `b1` selects `b1-*` when `b1` has no dir."""
    out = []
    for name in [b for b in battery.split(",") if b]:
        d = os.path.join(base, name)
        if os.path.isdir(d):
            out.append((name, d))
            continue
        subs = sorted(x for x in os.listdir(base) if x.startswith(name + "-") and os.path.isdir(os.path.join(base, x))) if os.path.isdir(base) else []
        if not subs:
            raise UsageError(f"no battery {name!r} under {base}")
        out.extend((s, os.path.join(base, s)) for s in subs)
    return out


def list_files(base: str, suffixes):
    """Sorted [(name, path)]: name is the path under base without the suffix."""
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames.sort()
        for fn in sorted(filenames):
            for suf in suffixes:
                if fn.endswith(suf):
                    path = os.path.join(dirpath, fn)
                    out.append((os.path.relpath(path, base)[: -len(suf)], path))
                    break
    out.sort()
    return out


def golden_path(golden_root, battery, name):
    return os.path.join(golden_root, battery, name + ".golden.jsonl.gz")


def flaky_path(golden_root, battery, name):
    return os.path.join(golden_root, battery, name + ".flaky.json")


# ---------------------------------------------------------------------------
# LSP client over a stdio server
# ---------------------------------------------------------------------------

ACTIVE_LOCK = threading.Lock()
ACTIVE_CLIENTS = set()
ABORT = threading.Event()
PRINT_LOCK = threading.Lock()
RUN_COUNTER = itertools.count()


def log(*parts):
    with PRINT_LOCK:
        print(*parts, file=sys.stderr, flush=True)


class LspClient:
    """Go: testutil/lsptestutil/lspclient.go:61 LSPClient, talking to a server process over stdio."""

    # Go: lspclient.go:85 NewLSPClient
    def __init__(self, argv, cwd, env, on_server_request, on_message=None):
        try:
            self.proc = subprocess.Popen(
                argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
        except OSError as e:
            raise UsageError(f"cannot start {argv[0]}: {e}") from None
        self.input_writer = Writer(self.proc.stdin)
        self.output_reader = Reader(self.proc.stdout)
        # PORT: Go NextID starts at 0; the oracle numbers requests 1..N (map-oracle.md 3.2).
        self.id = 1
        self.on_server_request = on_server_request
        self.on_message = on_message
        self.inbox = queue.Queue()
        self.stderr_tail = collections.deque(maxlen=40)
        self.stderr_done = threading.Event()
        threading.Thread(target=self.message_router, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        with ACTIVE_LOCK:
            ACTIVE_CLIENTS.add(self)

    # Go: lspclient.go:124 NextID
    def next_id(self):
        id_ = self.id
        self.id += 1
        return id_

    # Go: lspclient.go:134 MessageRouter
    def message_router(self):
        # PORT: this thread only reads. Routing runs in wait_for_response on the
        # session thread, because exactly one request is in flight.
        while True:
            try:
                data = self.output_reader.read()
            except EOFError:
                self.inbox.put(("eof", None))
                return
            except (JsonRpcError, OSError, ValueError) as e:
                self.inbox.put(("error", f"failed to read message: {e}"))
                return
            try:
                msg = json.loads(data)
            except ValueError as e:
                self.inbox.put(("error", f"failed to decode message as JSON: {e}"))
                return
            if not isinstance(msg, dict):
                self.inbox.put(("error", "message is not a JSON object"))
                return
            self.inbox.put(("msg", msg))

    def _read_stderr(self):
        for line in self.proc.stderr:
            self.stderr_tail.append(line.decode("utf-8", errors="replace").rstrip()[:300])
        self.stderr_done.set()

    # Go: lspclient.go:196 handleServerRequest
    def handle_server_request(self, req):
        response = None

        if self.on_server_request is not None:
            response = self.on_server_request(req)

        if response is None:
            # Default: unknown server request
            response = {
                "jsonrpc": req.get("jsonrpc"),
                "id": req.get("id"),
                "error": {
                    "code": ERROR_CODE_METHOD_NOT_FOUND,
                    "message": f"Unknown method: {req.get('method')}",
                },
            }

        self.write_msg(response)

    # Go: lspclient.go:231 WriteMsg
    def write_msg(self, msg):
        self.input_writer.write(encode_message(msg))
        if self.on_message is not None:
            self.on_message("C->S", msg)

    # Go: lspclient.go:280 SendRequestWorker
    def send_request_worker(self, method, params, req_id, timeout, sink):
        msg = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not MISSING:
            msg["params"] = params
        try:
            self.write_msg(msg)
        except OSError as e:
            return "crash", f"write failed: {e}"
        return self.wait_for_response(req_id, timeout, sink)

    # Go: lspclient.go:295 waitForResponse
    def wait_for_response(self, req_id, timeout, sink):
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return "timeout", None
            try:
                kind, msg = self.inbox.get(timeout=left)
            except queue.Empty:
                return "timeout", None
            if kind != "msg":
                self.inbox.put((kind, msg))  # later waits see the same end
                return "crash", msg or "server closed its output"
            if self.on_message is not None:
                self.on_message("S->C", msg)
            mk = message_kind(msg)
            if mk == "request":
                sink(msg)
                try:
                    self.handle_server_request(msg)
                except OSError as e:
                    return "crash", f"write failed: {e}"
            elif mk == "notification":
                sink(msg)
            elif msg.get("id") == req_id:
                return "ok", msg
            else:
                sink(msg)

    # Go: lspclient.go:318 SendNotification
    def send_notification(self, method, params=MISSING):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not MISSING:
            msg["params"] = params
        self.write_msg(msg)

    def kill(self):
        try:
            self.proc.kill()
        except OSError:
            pass

    def close(self, wait=EXIT_WAIT):
        """Close stdin, wait for the exit and return the exit code (or "killed")."""
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            code = self.proc.wait(timeout=wait)
        except subprocess.TimeoutExpired:
            self.kill()
            self.proc.wait()
            code = "killed"
        self.stderr_done.wait(timeout=2.0)
        with ACTIVE_LOCK:
            ACTIVE_CLIENTS.discard(self)
        return code


def kill_all_clients():
    with ACTIVE_LOCK:
        clients = list(ACTIVE_CLIENTS)
    for c in clients:
        c.kill()


# ---------------------------------------------------------------------------
# One session
# ---------------------------------------------------------------------------


class Root:
    def __init__(self, path, cwd, trace_dir, home, guard):
        self.path = path
        self.uri = file_name_to_document_uri(path)
        self.cwd = cwd
        self.trace_dir = trace_dir
        self.home = home
        self.guard = guard
        run_uri = file_name_to_document_uri(trace_dir)
        # Go: lsp/replay_test.go:100 rootDirReplacer
        self.expand = Replacer(
            ROOT_DIR_PLACEHOLDER, path,
            ROOT_DIR_URI_PLACEHOLDER, self.uri,
            RUN_DIR_PLACEHOLDER, trace_dir,
            RUN_DIR_URI_PLACEHOLDER, run_uri,
        )
        # Normalization rule 1: the longest actual string first.
        pairs = [
            (self.uri, ROOT_DIR_URI_PLACEHOLDER),
            (path, ROOT_DIR_PLACEHOLDER),
            (run_uri, RUN_DIR_URI_PLACEHOLDER),
            (trace_dir, RUN_DIR_PLACEHOLDER),
        ]
        pairs.sort(key=lambda p: -len(p[0]))
        self.normalize = Replacer(*[x for p in pairs for x in p])


def prepare_root(header, run_dir, key):
    for salt in itertools.count():
        trace_dir = os.path.join(run_dir, hashlib.sha256(f"{key}#{salt}".encode()).hexdigest()[:8])
        try:
            os.makedirs(trace_dir)
            break
        except FileExistsError:
            continue
    try:
        return _prepare_root(header, run_dir, trace_dir)
    except BaseException:
        shutil.rmtree(trace_dir, ignore_errors=True)
        raise


def _prepare_root(header, run_dir, trace_dir):
    home = os.path.join(trace_dir, "home")
    os.makedirs(os.path.join(home, ".cache"))
    spec = header["root"]
    if spec["kind"] == "materialize":
        path = os.path.join(trace_dir, "r")
        check_materialized_root(path)
        os.makedirs(path)
        guard = None
    else:
        d = spec.get("dir")
        if not isinstance(d, str) or not os.path.isabs(d) or not os.path.isdir(d):
            raise TraceError(f"project root {d!r} is not an absolute directory")
        path = os.path.realpath(d)
        guard = guard_dir_for(path)
        if is_within(run_dir, guard):
            raise UsageError(f"run directory {run_dir} is inside the project input {guard}")
    cwd_rel = header.get("cwd") or ""
    cwd = path if cwd_rel in ("", ".") else safe_join(path, cwd_rel)
    root = Root(path, cwd, trace_dir, home, guard)
    if spec["kind"] == "materialize":
        files = spec.get("files") or {}
        if not isinstance(files, dict):
            raise TraceError("root.files must be an object")
        for rel in sorted(files):
            write_root_file(path, rel, files[rel], root.expand)
    return root


def session_env(root: Root):
    env = dict(os.environ)
    env["HOME"] = root.home
    env["XDG_CACHE_HOME"] = os.path.join(root.home, ".cache")
    env["XDG_CONFIG_HOME"] = os.path.join(root.home, ".config")
    env["XDG_DATA_HOME"] = os.path.join(root.home, ".local", "share")
    return env


def resolve_params_from(pf, ev, results):
    """Params for a dependent request, or (MISSING, reason). `results` maps event -> normalized result."""
    src = results.get(pf["event"], MISSING)
    if src is MISSING:
        return MISSING, f"event {pf['event']} has no result"
    value = pointer_get(src, pf.get("pointer", ""))
    if value is MISSING:
        return MISSING, f"no value at {pf.get('pointer', '')}"
    pick = pf.get("pick")
    if pick is not None:
        if not isinstance(value, list):
            return MISSING, "pick on a non-array value"
        if "match" in pick:
            want = pick["match"]
            hits = [e for e in value if isinstance(e, dict) and all(canon(e.get(k)) == canon(v) for k, v in want.items())]
            if not hits:
                return MISSING, "no element matches"
            value = hits[0]
        else:
            items = value
            if "sortBy" in pick:
                fields = pick["sortBy"]

                def key(e):
                    vals = []
                    for f in fields:
                        x = e.get(f, "") if isinstance(e, dict) else ""
                        vals.append(x if isinstance(x, str) else canon(x))
                    return (vals, canon(e))

                items = sorted(value, key=key)
            index = pick.get("index", 0)
            if not isinstance(index, int) or not -len(items) <= index < len(items):
                return MISSING, f"index {index} out of range ({len(items)} elements)"
            value = items[index]
    into = pf.get("into")
    if into is None:
        return copy.deepcopy(value), None
    params = copy.deepcopy(ev.get("params", {}))
    if isinstance(into, str):
        return pointer_set(params, into, copy.deepcopy(value)), None
    for placement in into:
        part = pointer_get(value, placement.get("from", ""))
        if part is MISSING:
            return MISSING, f"no value at {placement.get('from', '')}"
        params = pointer_set(params, placement["to"], copy.deepcopy(part))
    return params, None


class SessionRun:
    """Runs one trace (record mode) or one golden (frozen mode) against one server.

    Record mode resolves paramsFrom against this server's answers. Frozen mode
    sends exactly the params stored in the golden and skips requests the oracle
    did not answer."""

    def __init__(self, *, header, events, frozen, argv, role, run_dir, key, marker,
                 request_timeout=None, methods=None, printer=None, keep=False):
        self.header = header
        self.events = events  # [(index, event)]
        self.frozen = frozen
        self.argv = argv
        self.role = role
        self.run_dir = run_dir
        self.key = key
        self.marker = marker
        self.request_timeout = request_timeout or REQUEST_TIMEOUT[role]
        self.methods = methods
        self.printer = printer
        self.keep = keep
        self.replies = collections.defaultdict(collections.deque)

    def on_server_request(self, req):
        method = req.get("method")
        queue_ = self.replies.get(method)
        if queue_:
            reply = queue_.popleft()
            result = self.root.expand.value(reply.get("result"))
            if method == "workspace/configuration":
                result = configuration_result(req.get("params"), None, result)
        elif method == "workspace/configuration":
            config = self.root.expand.value(self.header.get("config"))
            result = configuration_result(req.get("params"), config)
        elif method in NULL_ANSWER_METHODS:
            result = None
        else:
            return None
        return {"jsonrpc": req.get("jsonrpc", "2.0"), "id": req.get("id"), "result": result}

    def run(self):
        start = time.monotonic()
        self.root = prepare_root(self.header, self.run_dir, self.key)
        try:
            result = self._run()
        except BaseException:
            if not self.keep:
                shutil.rmtree(self.root.trace_dir, ignore_errors=True)
            raise
        result["wallMs"] = round((time.monotonic() - start) * 1000, 1)
        return result

    def _run(self):
        root = self.root
        records = []
        results = {}
        expects = []
        dead = None
        last_send = None
        max_gap = 0.0
        client = LspClient(self.argv, root.cwd, session_env(root), self.on_server_request, self.printer)
        shutdown = {}
        code = None
        try:
            next_id = 0
            for i, ev in self.events:
                kind = ev.get("kind")
                if kind == "request":
                    next_id += 1
                    method = ev["method"]
                    rec = {"i": i, "kind": "request", "method": method, "id": next_id}
                    if self.frozen:
                        params = copy.deepcopy(ev["params"]) if "params" in ev else MISSING
                        if ev.get("status") not in ("ok", "error"):
                            rec.update(status="not_run", reason="oracle:" + str(ev.get("status")))
                    elif i == 0:
                        params = initialize_params(ev, self.header)
                    elif "paramsFrom" in ev:
                        rec["paramsFrom"] = ev["paramsFrom"]
                        params, why = resolve_params_from(ev["paramsFrom"], ev, results)
                        if params is MISSING:
                            rec.update(status="not_run", reason="paramsFrom: " + why)
                    else:
                        params = copy.deepcopy(ev["params"]) if "params" in ev else MISSING
                    if params is not MISSING:
                        rec["params"] = params
                    if "status" not in rec and dead is not None:
                        rec.update(status="crash" if dead == "crash" else "not_run", reason="after " + dead)
                    if "status" not in rec and i != 0 and not method_selected(method, self.methods):
                        rec["status"] = "skipped_method"
                    if "status" in rec:
                        records.append(rec)
                        continue
                    traffic, dropped = [], collections.Counter()

                    def sink(msg, traffic=traffic, dropped=dropped):
                        m = msg.get("method")
                        if m in DROPPED_SERVER_METHODS:
                            dropped[m] += 1
                            return
                        entry = {"dir": message_kind(msg), "method": m}
                        if "params" in msg:
                            entry["params"] = root.normalize.value(msg["params"])
                        if entry["dir"] == "response":
                            entry.update(root.normalize.value({k: v for k, v in msg.items() if k != "jsonrpc"}))
                        traffic.append(entry)

                    now = time.monotonic()
                    if last_send is not None:
                        max_gap = max(max_gap, now - last_send)
                    last_send = now
                    timeout = INITIALIZE_TIMEOUT if i == 0 else self.request_timeout
                    st, msg = client.send_request_worker(method, root.expand.value(params), next_id, timeout, sink)
                    rec["ms"] = round((time.monotonic() - now) * 1000, 2)
                    if st == "ok":
                        status, resp = normalize_response(method, msg, root.normalize)
                        rec["status"] = status
                        rec["response"] = resp
                        if status == "ok" and "result" in resp:
                            results[i] = resp["result"]
                    elif st == "timeout":
                        rec["status"] = "timeout"
                        dead = "timeout"
                        client.kill()
                    else:
                        rec["status"] = "crash"
                        rec["reason"] = str(msg)[:300]
                        dead = "crash"
                    traffic.sort(key=lambda e: (str(e.get("method")), canon(e)))
                    rec["traffic"] = traffic
                    if dropped:
                        rec["dropped"] = dict(sorted(dropped.items()))
                    records.append(rec)
                    if i == 0 and dead is None:
                        try:
                            client.send_notification("initialized", {})
                        except OSError:
                            dead = "crash"
                elif kind == "notification":
                    if self.frozen:
                        params = copy.deepcopy(ev["params"]) if "params" in ev else MISSING
                    else:
                        params = notification_params(ev)
                    rec = {"i": i, "kind": "notification", "method": ev["method"]}
                    if params is not MISSING:
                        rec["params"] = params
                    records.append(rec)
                    if dead is None:
                        try:
                            client.send_notification(ev["method"], root.expand.value(params))
                        except OSError:
                            dead = "crash"
                elif kind == "fs":
                    rec = {k: ev[k] for k in ("op", "path", "content") if k in ev}
                    rec = {"i": i, "kind": "fs", **rec}
                    records.append(rec)
                    if dead is None:
                        self.apply_fs(ev)
                elif kind == "reply":
                    self.replies[ev["method"]].append(ev)
                    records.append({"i": i, "kind": "reply", "method": ev["method"], "result": ev.get("result")})
                elif kind == "expect":
                    rec = {"i": i, "kind": "expect", "event": ev.get("event"), "response": ev.get("response")}
                    expects.append(rec)
                    records.append(rec)
            if dead is None:
                sd = []
                st, msg = client.send_request_worker("shutdown", MISSING, next_id + 1, SHUTDOWN_TIMEOUT, sd.append)
                shutdown = {"id": next_id + 1, "status": st}
                if st == "ok":
                    shutdown["status"], shutdown["response"] = normalize_response("shutdown", msg, root.normalize)
                if st != "crash":
                    try:
                        client.send_notification("exit")
                    except OSError:
                        pass
            else:
                shutdown = {"id": next_id + 1, "status": "not_run"}
        finally:
            code = client.close()
            changed = None
            if root.guard is not None:
                changed = check_input_unchanged(root.guard, self.marker)
            if changed:
                ABORT.set()
                kill_all_clients()
                raise InputChanged(f"the run wrote into the project input: {changed}")
        fidelity = collections.Counter()
        by_index = {r["i"]: r for r in records if r["kind"] == "request"}
        for rec in expects:
            target = by_index.get(rec.get("event"))
            if target is None or target.get("status") not in ("ok", "error"):
                rec["fidelity"] = "not_run"
            else:
                exp = rec.get("response")
                if isinstance(exp, dict) and ("result" in exp or "error" in exp) and set(exp) <= {"jsonrpc", "id", "result", "error"}:
                    msg = exp
                else:
                    msg = {"result": exp}
                _, norm = normalize_response(target["method"], msg, IDENTITY)
                rec["fidelity"] = "same" if canon(norm) == canon(target["response"]) else "diff"
            fidelity[rec["fidelity"]] += 1
        # A kill by the harness (after a timeout, or no exit after `exit`) is not a crash of the server.
        killed_by_harness = dead == "timeout" or code == "killed"
        exit_crash = not killed_by_harness and isinstance(code, int) and (
            code < 0 or (self.role == "goport" and code == EXIT_UNPORTED)
        )
        return {
            "records": records,
            "exit": {
                "code": code,
                "crash": bool(exit_crash),
                "killedByHarness": killed_by_harness,
                "stderrTail": list(client.stderr_tail)[-8:],
            },
            "shutdown": shutdown,
            "timingRisk": max_gap > TIMING_RISK_GAP,
            "maxGapSec": round(max_gap, 2),
            "unusedReplies": sum(len(q) for q in self.replies.values()),
            "fidelity": dict(fidelity),
            "root": root,
        }

    def apply_fs(self, ev):
        root = self.root.path
        path = safe_join(root, ev["path"])
        op = ev["op"]
        if op in ("write", "append"):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            if os.path.lexists(path) and not is_within(path, root):
                raise TraceError(f"fs {op} {ev['path']!r} leaves the root through a symlink")
            with open(path, "w" if op == "write" else "a", encoding="utf-8", newline="") as f:
                f.write(self.root.expand.replace(ev.get("content") or ""))
        elif os.path.islink(path) or os.path.isfile(path):
            os.remove(path)
        elif os.path.isdir(path):
            if not is_within(path, root) or os.path.realpath(path) == os.path.realpath(root):
                raise TraceError(f"fs remove {ev['path']!r} leaves the root")
            shutil.rmtree(path)


def cleanup_trace_dir(result, keep):
    if keep or result is None:
        return
    shutil.rmtree(result["root"].trace_dir, ignore_errors=True)


def request_counts(records):
    status = collections.Counter()
    methods = collections.defaultdict(collections.Counter)
    errors = collections.Counter()
    dropped = collections.Counter()
    for r in records:
        if r["kind"] != "request":
            continue
        status[r["status"]] += 1
        methods[r["method"]][r["status"]] += 1
        if r["status"] == "error":
            errors[error_class(r["response"]["error"])] += 1
        for m, n in (r.get("dropped") or {}).items():
            dropped[m] += n
    return {
        "status": dict(status),
        "methods": {m: dict(c) for m, c in sorted(methods.items())},
        "errors": dict(errors),
        "dropped": dict(dropped),
    }


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


class Context:
    def __init__(self, args, command):
        self.args = args
        self.out_root = os.path.realpath(args.out_root)
        if is_within(self.out_root, PROJECT_INPUTS):
            raise UsageError(f"--out-root {self.out_root} is inside the project inputs")
        self.traces_dir = os.path.realpath(getattr(args, "traces_dir", None) or os.path.join(self.out_root, "traces"))
        base = os.path.join(os.path.realpath(tempfile.gettempdir()), "goport-lsp")
        self.run_dir = os.path.join(base, f"{command}-{os.getpid()}-{int(time.time())}")
        if is_within(self.run_dir, PROJECT_INPUTS):
            raise UsageError(f"run directory {self.run_dir} is inside the project inputs")
        os.makedirs(self.run_dir)
        self.marker = os.path.join(self.run_dir, ".start")
        with open(self.marker, "w"):
            pass
        self.keep = getattr(args, "keep_temp", False)

    def key(self, *parts):
        return "/".join(str(p) for p in parts) + f"#{next(RUN_COUNTER)}"

    def close(self):
        if not self.keep:
            shutil.rmtree(self.run_dir, ignore_errors=True)
            base = os.path.dirname(self.run_dir)
            try:
                os.rmdir(base)
            except OSError:
                pass


def oracle_info(args):
    path = os.path.realpath(os.path.expanduser(args.oracle))
    sha = getattr(args, "oracle_sha", None)
    if sha:
        return path, sha
    if not os.path.isfile(path):
        raise UsageError(f"oracle binary {path} not found")
    return path, sha256_file(path)


def golden_root_for(out_root, sha):
    return os.path.join(out_root, "golden", sha[:12])


def run_jobs(jobs, items, fn):
    """Runs fn(item) for each item with `jobs` threads. Stops early after ABORT."""
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        futures = [pool.submit(fn, it) for it in items]
        try:
            for f in futures:
                results.append(f.result())
        except BaseException:
            ABORT.set()
            kill_all_clients()
            for f in futures:
                f.cancel()
            raise
    return results


def cmd_record(args):
    ctx = Context(args, "record")
    status = EXIT_OK
    try:
        oracle, sha = oracle_info(args)
        groot = golden_root_for(ctx.out_root, sha)
        batteries = expand_batteries(ctx.traces_dir, args.battery)
        for battery, bdir in batteries:
            traces = [(n, p) for n, p in list_files(bdir, (".jsonl.gz", ".jsonl")) if not args.only or args.only in n]
            outcome = collections.Counter()

            def one(item, battery=battery):
                name, path = item
                if ABORT.is_set():
                    return "aborted"
                try:
                    header, events, trace_sha = load_trace(path)
                except (TraceError, OSError) as e:
                    log(f"invalid trace {battery}/{name}: {e}")
                    return "invalid"
                gpath = golden_path(groot, battery, name)
                if not args.force and os.path.exists(gpath):
                    try:
                        if read_golden_header(gpath).get("traceSha256") == trace_sha:
                            return "skipped"
                    except (OSError, ValueError):
                        pass
                try:
                    result = SessionRun(
                        header=header, events=list(enumerate(events)), frozen=False,
                        argv=[oracle, "--lsp", "--stdio"], role="oracle", run_dir=ctx.run_dir,
                        key=ctx.key(battery, name, "record"), marker=ctx.marker,
                        request_timeout=args.request_timeout, keep=ctx.keep,
                    ).run()
                except TraceError as e:
                    log(f"trace {battery}/{name} failed: {e}")
                    return "failed"
                counts = request_counts(result["records"])
                header_line = {
                    "format": GOLDEN_FORMAT,
                    "battery": battery,
                    "trace": name,
                    "traceFile": path,
                    "traceSha256": trace_sha,
                    "header": header,
                    "oracle": {"path": oracle, "sha256": sha},
                    "recorded": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                    "exit": result["exit"],
                    "shutdown": result["shutdown"],
                    "timingRisk": result["timingRisk"],
                    "maxGapSec": result["maxGapSec"],
                    "unusedReplies": result["unusedReplies"],
                    "fidelity": result["fidelity"],
                    "counts": counts,
                    "wallMs": result["wallMs"],
                }
                write_golden(gpath, header_line, result["records"])
                cleanup_trace_dir(result, ctx.keep)
                st = counts["status"]
                log(f"record {battery}/{name}: {sum(st.values())} requests "
                    + " ".join(f"{k} {v}" for k, v in sorted(st.items())) + f" ({result['wallMs'] / 1000:.1f}s)")
                return "recorded"

            for r in run_jobs(args.jobs, traces, one):
                outcome[r] += 1
            if outcome["invalid"] or outcome["failed"]:
                status = EXIT_FAILED
            summary = record_summary(groot, battery, oracle, sha, outcome)
            write_json(os.path.join(groot, battery, "record-summary.json"), summary)
            print(format_record_summary(summary))
    finally:
        ctx.close()
    return status


def record_summary(groot, battery, oracle, sha, outcome):
    status = collections.Counter()
    methods = collections.defaultdict(collections.Counter)
    errors = collections.Counter()
    dropped = collections.Counter()
    fidelity = collections.Counter()
    exits = collections.Counter()
    timing = 0
    goldens = list_files(os.path.join(groot, battery), (".golden.jsonl.gz",))
    for _, gpath in goldens:
        h = read_golden_header(gpath)
        c = h.get("counts", {})
        status.update(c.get("status", {}))
        for m, mc in c.get("methods", {}).items():
            methods[m].update(mc)
        errors.update(c.get("errors", {}))
        dropped.update(c.get("dropped", {}))
        fidelity.update(h.get("fidelity", {}))
        exits[str(h.get("exit", {}).get("code"))] += 1
        timing += bool(h.get("timingRisk"))
    return {
        "format": "goport-lsp-record-summary/1",
        "battery": battery,
        "oracle": {"path": oracle, "sha256": sha},
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "thisRun": dict(outcome),
        "goldens": len(goldens),
        "requests": dict(status),
        "methods": {m: dict(c) for m, c in sorted(methods.items())},
        "errors": dict(errors),
        "dropped": dict(dropped),
        "fidelity": dict(fidelity),
        "exitCodes": dict(exits),
        "timingRisk": timing,
    }


def format_record_summary(s):
    lines = [f"record {s['battery']}: oracle {s['oracle']['sha256'][:12]}, {s['goldens']} goldens; this run "
             + ", ".join(f"{k} {v}" for k, v in sorted(s["thisRun"].items()))]
    lines.append("  requests: " + ", ".join(f"{k} {v}" for k, v in sorted(s["requests"].items())))
    if s["errors"]:
        lines.append("  oracle errors: " + ", ".join(f"{k} {v}" for k, v in sorted(s["errors"].items())))
    if s["fidelity"]:
        lines.append("  fidelity: " + ", ".join(f"{k} {v}" for k, v in sorted(s["fidelity"].items())))
    lines.append("  exit codes: " + ", ".join(f"{k} {v}" for k, v in sorted(s["exitCodes"].items()))
                 + f"; timing-risk {s['timingRisk']}")
    return "\n".join(lines)


def golden_events(records):
    return [(r["i"], r) for r in records]


def cmd_selfcheck(args):
    ctx = Context(args, "selfcheck")
    status = EXIT_OK
    try:
        oracle, sha = oracle_info(args)
        groot = golden_root_for(ctx.out_root, sha)
        batteries = expand_batteries(groot, args.battery)
        for battery, bdir in batteries:
            goldens = [(n, p) for n, p in list_files(bdir, (".golden.jsonl.gz",)) if not args.only or args.only in n]
            totals = collections.Counter()

            def one(item, battery=battery):
                name, gpath = item
                if ABORT.is_set():
                    return None
                header, records = read_golden(gpath)
                if header.get("oracle", {}).get("sha256") != sha:
                    log(f"golden {battery}/{name} was recorded by another oracle; skipped")
                    return None
                gsha = sha256_file(gpath)
                fpath = flaky_path(groot, battery, name)
                previous = None
                if os.path.exists(fpath):
                    previous = read_json(fpath)
                    if previous.get("goldenSha256") != gsha:
                        previous = None
                events = dict((previous or {}).get("events", {}))
                problems = dict((previous or {}).get("rerunProblems", {}))
                runs = (previous or {}).get("runs", 0)
                by_i = {r["i"]: r for r in records if r["kind"] == "request"}
                for _ in range(args.runs):
                    try:
                        result = SessionRun(
                            header=header["header"], events=golden_events(records), frozen=True,
                            argv=[oracle, "--lsp", "--stdio"], role="oracle", run_dir=ctx.run_dir,
                            key=ctx.key(battery, name, "selfcheck"), marker=ctx.marker,
                            request_timeout=args.request_timeout, keep=ctx.keep,
                        ).run()
                    except TraceError as e:
                        log(f"selfcheck {battery}/{name} failed: {e}")
                        return "failed"
                    runs += 1
                    for rec in result["records"]:
                        if rec["kind"] != "request":
                            continue
                        g = by_i[rec["i"]]
                        if g.get("status") not in ("ok", "error"):
                            continue
                        key = str(rec["i"])
                        if rec["status"] not in ("ok", "error"):
                            problems[key] = rec["status"]
                            continue
                        if canon(g.get("response")) == canon(rec.get("response")):
                            continue
                        entry = events.get(key) or {"method": rec["method"], "multiset": []}
                        if g["status"] == "ok" and rec["status"] == "ok" and "result" in g["response"] and "result" in rec["response"]:
                            pats, bad = find_unstable(g["response"]["result"], rec["response"]["result"])
                        else:
                            pats, bad = [], "(status or error differs)"
                        entry["multiset"] = sorted(set(entry["multiset"]) | set(pats))
                        if bad is not None:
                            entry["unstable"] = True
                            entry.setdefault("pointer", bad)
                        events[key] = entry
                    cleanup_trace_dir(result, ctx.keep)
                write_json(fpath, {
                    "format": FLAKY_FORMAT,
                    "golden": gpath,
                    "goldenSha256": gsha,
                    "oracleSha256": sha,
                    "runs": runs,
                    "checked": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                    "events": dict(sorted(events.items(), key=lambda kv: int(kv[0]))),
                    "rerunProblems": problems,
                })
                n_unstable = sum(1 for e in events.values() if e.get("unstable"))
                n_multi = sum(1 for e in events.values() if e.get("multiset") and not e.get("unstable"))
                log(f"selfcheck {battery}/{name}: {len(by_i)} requests, multiset {n_multi}, unstable {n_unstable}, rerun problems {len(problems)}")
                return {"requests": len(by_i), "multiset": n_multi, "unstable": n_unstable, "problems": len(problems)}

            for r in run_jobs(args.jobs, goldens, one):
                if r == "failed":
                    status = EXIT_FAILED
                    totals["failed"] += 1
                elif isinstance(r, dict):
                    totals["traces"] += 1
                    totals.update(r)
            summary = {"format": "goport-lsp-selfcheck-summary/1", "battery": battery, "oracleSha256": sha,
                       "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **dict(totals)}
            write_json(os.path.join(groot, battery, "selfcheck-summary.json"), summary)
            print(f"selfcheck {battery}: " + ", ".join(f"{k} {v}" for k, v in sorted(totals.items())))
    finally:
        ctx.close()
    return status


def cmd_check(args):
    ctx = Context(args, "check")
    status = EXIT_OK
    try:
        _, sha = oracle_info(args)
        groot = golden_root_for(ctx.out_root, sha)
        goport = os.path.realpath(args.goport)
        if not os.path.isfile(goport) or not os.access(goport, os.X_OK):
            raise UsageError(f"--goport {goport} is not an executable file")
        goport_sha = sha256_file(goport)
        label_dir = os.path.join(ctx.out_root, "results", args.label)
        methods = set(m for m in (args.methods or "").split(",") if m) or None
        batteries = expand_batteries(groot, args.battery)
        for battery, _ in batteries:
            if os.path.exists(os.path.join(label_dir, "traces", battery)):
                raise UsageError(f"results for {args.label}/{battery} exist; use a new label (results are never replaced)")
        for battery, bdir in batteries:
            goldens = [(n, p) for n, p in list_files(bdir, (".golden.jsonl.gz",)) if not args.only or args.only in n]

            def one(item, battery=battery):
                name, gpath = item
                if ABORT.is_set():
                    return None
                header, records = read_golden(gpath)
                gsha = sha256_file(gpath)
                fpath = flaky_path(groot, battery, name)
                flaky = {}
                if os.path.exists(fpath):
                    f = read_json(fpath)
                    if f.get("goldenSha256") == gsha:
                        flaky = f.get("events", {})
                    else:
                        log(f"{battery}/{name}: flaky file is for another golden; ignored")
                        fpath = None
                else:
                    fpath = None
                try:
                    result = SessionRun(
                        header=header["header"], events=golden_events(records), frozen=True,
                        argv=[goport, "--lsp", "--stdio"], role="goport", run_dir=ctx.run_dir,
                        key=ctx.key(battery, name, "check"), marker=ctx.marker,
                        request_timeout=args.request_timeout, methods=methods, keep=ctx.keep,
                    ).run()
                except TraceError as e:
                    log(f"check {battery}/{name} failed: {e}")
                    return "failed"
                g_by_i = {r["i"]: r for r in records if r["kind"] == "request"}
                events = []
                counts = collections.Counter()
                subs = collections.Counter()
                first = None
                traffic_diff = 0
                responses = []
                for rec in result["records"]:
                    if rec["kind"] != "request":
                        continue
                    g = g_by_i[rec["i"]]
                    cls, sub, ptr = classify(g, rec, flaky.get(str(rec["i"])))
                    ev = {"i": rec["i"], "method": rec["method"], "class": cls}
                    if sub:
                        ev["sub"] = sub
                    if ptr is not None:
                        ev["pointer"] = ptr
                    if "ms" in rec:
                        ev["ms"] = rec["ms"]
                    if "ms" in g:
                        ev["oracleMs"] = g["ms"]
                    if rec.get("status") in ("ok", "error") and g.get("status") in ("ok", "error"):
                        same_traffic = canon(g.get("traffic", [])) == canon(rec.get("traffic", []))
                        ev["traffic"] = "same" if same_traffic else "diff"
                        traffic_diff += not same_traffic
                    events.append(ev)
                    counts[cls] += 1
                    if cls == "goport_error":
                        subs[sub] += 1
                    if first is None and cls in DIVERGENT_CLASSES:
                        first = {k: ev[k] for k in ("i", "method", "class", "sub", "pointer") if k in ev}
                    responses.append({k: rec[k] for k in ("i", "method", "status", "response", "traffic", "reason") if k in rec})
                rpath = os.path.join(label_dir, "responses", battery, name + ".jsonl.gz")
                os.makedirs(os.path.dirname(rpath), exist_ok=True)
                with gzip.open(rpath, "wt", encoding="utf-8") as f:
                    for r in responses:
                        f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
                trace_result = {
                    "format": RESULT_FORMAT,
                    "label": args.label,
                    "battery": battery,
                    "trace": name,
                    "golden": gpath,
                    "goldenSha256": gsha,
                    "oracleSha256": header.get("oracle", {}).get("sha256"),
                    "flaky": fpath,
                    "responses": rpath,
                    "goport": {"path": goport, "sha256": goport_sha},
                    "methodsFilter": sorted(methods) if methods else None,
                    "checked": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                    "exit": result["exit"],
                    "oracleExit": header.get("exit", {}).get("code"),
                    "timingRisk": result["timingRisk"],
                    "maxGapSec": result["maxGapSec"],
                    "trafficDiff": traffic_diff,
                    "counts": dict(counts),
                    "goportErrors": dict(subs),
                    "firstDivergence": first,
                    "wallMs": result["wallMs"],
                    "events": events,
                }
                write_json(os.path.join(label_dir, "traces", battery, name + ".json"), trace_result)
                cleanup_trace_dir(result, ctx.keep)
                log(f"check {battery}/{name}: " + " ".join(f"{k} {v}" for k, v in sorted(counts.items()))
                    + f"; exit {result['exit']['code']} ({result['wallMs'] / 1000:.1f}s)")
                return "checked"

            for r in run_jobs(args.jobs, goldens, one):
                if r == "failed":
                    status = EXIT_FAILED
        summary = build_summary(ctx.out_root, args.label, None)
        print(summary_markdown(summary))
    finally:
        ctx.close()
    return status


def load_label(out_root, label):
    tdir = os.path.join(out_root, "results", label, "traces")
    if not os.path.isdir(tdir):
        raise UsageError(f"no results for label {label!r}")
    return [read_json(p) for _, p in list_files(tdir, (".json",))]


def build_summary(out_root, label, baseline):
    traces = load_label(out_root, label)
    batteries = {}
    methods = collections.defaultdict(collections.Counter)
    unported = collections.Counter()
    firsts = []
    oracle_shas, goports, golden_lines = set(), set(), []
    filters = set()
    for t in traces:
        b = batteries.setdefault(t["battery"], {
            "traces": 0, "requests": 0, "classes": collections.Counter(), "goportErrors": collections.Counter(),
            "exitCodes": collections.Counter(), "crashExits": 0, "timingRisk": 0, "trafficDiff": 0,
        })
        b["traces"] += 1
        b["requests"] += len(t["events"])
        b["classes"].update(t["counts"])
        b["goportErrors"].update(t.get("goportErrors", {}))
        b["exitCodes"][str(t["exit"]["code"])] += 1
        b["crashExits"] += bool(t["exit"].get("crash"))
        b["timingRisk"] += bool(t.get("timingRisk"))
        b["trafficDiff"] += t.get("trafficDiff", 0)
        for ev in t["events"]:
            methods[ev["method"]][ev["class"]] += 1
            if ev.get("sub", "").startswith("unported:"):
                unported[ev["sub"][len("unported:"):]] += 1
        if t.get("firstDivergence"):
            firsts.append({"battery": t["battery"], "trace": t["trace"], **t["firstDivergence"]})
        oracle_shas.add(t.get("oracleSha256"))
        goports.add((t["goport"]["path"], t["goport"]["sha256"]))
        golden_lines.append(f"{t['battery']}/{t['trace']} {t['goldenSha256']}")
        filters.add(",".join(t["methodsFilter"]) if t.get("methodsFilter") else "")
    summary = {
        "format": SUMMARY_FORMAT,
        "label": label,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "oracleSha256": sorted(s for s in oracle_shas if s),
        "goport": [{"path": p, "sha256": s} for p, s in sorted(goports)],
        "traceSetSha256": sha256_bytes("\n".join(sorted(golden_lines)).encode()),
        "methodsFilter": sorted(filters),
        "batteries": {
            name: {**{k: v for k, v in b.items() if not isinstance(v, collections.Counter)},
                   "classes": dict(b["classes"]), "goportErrors": dict(b["goportErrors"]),
                   "exitCodes": dict(b["exitCodes"])}
            for name, b in sorted(batteries.items())
        },
        "methods": {m: dict(c) for m, c in sorted(methods.items())},
        "unportedTop": unported.most_common(30),
        "firstDivergences": firsts[:50],
        "firstDivergenceCount": len(firsts),
    }
    if baseline:
        summary["baseline"] = compare_labels(out_root, baseline, traces)
    label_dir = os.path.join(out_root, "results", label)
    write_json(os.path.join(label_dir, "summary.json"), summary)
    with open(os.path.join(label_dir, "summary.md"), "w", encoding="utf-8") as f:
        f.write(summary_markdown(summary))
    return summary


def compare_labels(out_root, baseline, traces):
    before = {}
    for t in load_label(out_root, baseline):
        for ev in t["events"]:
            before[(t["battery"], t["trace"], ev["i"])] = ev["class"]
    now = {}
    for t in traces:
        for ev in t["events"]:
            now[(t["battery"], t["trace"], ev["i"])] = (ev["class"], ev["method"])
    counts = collections.Counter()
    lost = []
    for key, cls in before.items():
        if cls != "same":
            continue
        if key not in now:
            counts["absent"] += 1
        elif now[key][0] == "same":
            counts["retained"] += 1
        elif now[key][0] in ("not_run", "skipped_method"):
            counts["unrun"] += 1
        else:
            counts["lost"] += 1
            lost.append({"battery": key[0], "trace": key[1], "event": key[2], "method": now[key][1], "class": now[key][0]})
    for key, (cls, _) in now.items():
        if cls == "same" and before.get(key) != "same":
            counts["new"] += 1
    return {"label": baseline, **{k: counts[k] for k in ("retained", "new", "lost", "unrun", "absent")}, "lostFirst": lost[:50]}


def summary_markdown(s):
    out = [f"# LSP oracle check: {s['label']}", ""]
    out.append(f"- oracle sha256: {', '.join(x[:12] for x in s['oracleSha256']) or '?'}")
    out.append("- goport: " + ", ".join(f"{g['path']} ({g['sha256'][:12]})" for g in s["goport"]))
    out.append(f"- trace set sha256: {s['traceSetSha256'][:12]}")
    out.append(f"- methods filter: {', '.join(f or 'all' for f in s['methodsFilter'])}")
    out.append("")
    cols = list(CLASSES)
    out.append("## Batteries")
    out.append("")
    out.append("| battery | traces | requests | " + " | ".join(cols) + " | exit crash | timing-risk | traffic diff |")
    out.append("|---|" + "---:|" * (len(cols) + 5))
    for name, b in s["batteries"].items():
        out.append(f"| {name} | {b['traces']} | {b['requests']} | "
                   + " | ".join(str(b["classes"].get(c, 0)) for c in cols)
                   + f" | {b['crashExits']} | {b['timingRisk']} | {b['trafficDiff']} |")
    out.append("")
    out.append("## Methods")
    out.append("")
    out.append("| method | total | " + " | ".join(cols) + " |")
    out.append("|---|" + "---:|" * (len(cols) + 1))
    for m, c in s["methods"].items():
        out.append(f"| {m} | {sum(c.values())} | " + " | ".join(str(c.get(x, 0)) for x in cols) + " |")
    errs = collections.Counter()
    for b in s["batteries"].values():
        errs.update(b["goportErrors"])
    if errs:
        out.append("")
        out.append("## goport errors")
        out.append("")
        out.append("| class | count |")
        out.append("|---|---:|")
        for k, v in errs.most_common(40):
            out.append(f"| {k} | {v} |")
    if s["unportedTop"]:
        out.append("")
        out.append("## Top unported Go names")
        out.append("")
        out.append("| Go name | requests |")
        out.append("|---|---:|")
        for k, v in s["unportedTop"]:
            out.append(f"| {k} | {v} |")
    if s["firstDivergences"]:
        out.append("")
        out.append(f"## First divergences ({len(s['firstDivergences'])} of {s['firstDivergenceCount']})")
        out.append("")
        out.append("| battery | trace | event | method | class | detail |")
        out.append("|---|---|---:|---|---|---|")
        for d in s["firstDivergences"]:
            detail = d.get("sub") or (f"at `{d['pointer']}`" if "pointer" in d else "")
            out.append(f"| {d['battery']} | {d['trace']} | {d['i']} | {d['method']} | {d['class']} | {detail} |")
    if s.get("baseline"):
        bl = s["baseline"]
        out.append("")
        out.append(f"## Against {bl['label']}")
        out.append("")
        out.append("| retained | new | lost | unrun | absent |")
        out.append("|---:|---:|---:|---:|---:|")
        out.append(f"| {bl['retained']} | {bl['new']} | {bl['lost']} | {bl['unrun']} | {bl['absent']} |")
        if bl["lostFirst"]:
            out.append("")
            out.append("| lost: battery | trace | event | method | class now |")
            out.append("|---|---|---:|---|---|")
            for d in bl["lostFirst"]:
                out.append(f"| {d['battery']} | {d['trace']} | {d['event']} | {d['method']} | {d['class']} |")
    return "\n".join(out) + "\n"


def cmd_summary(args):
    s = build_summary(os.path.realpath(args.out_root), args.label, args.baseline)
    print(summary_markdown(s), end="")
    return EXIT_OK


def cmd_show(args):
    out_root = os.path.realpath(args.out_root)
    traces = load_label(out_root, args.label)
    hits = [t for t in traces if (t["trace"] == args.trace or f"{t['battery']}/{t['trace']}" == args.trace)
            and (not args.battery or t["battery"] == args.battery)]
    if len(hits) != 1:
        raise UsageError(f"{len(hits)} traces match {args.trace!r} in {args.label}; give --battery or battery/name")
    t = hits[0]
    _, records = read_golden(t["golden"])
    g = next((r for r in records if r["i"] == args.event), None)
    if g is None:
        raise UsageError(f"no event {args.event} in {t['golden']}")
    if g["kind"] != "request":
        print(json.dumps(g, indent=1, sort_keys=True, ensure_ascii=False))
        return EXIT_OK
    run = None
    with gzip.open(t["responses"], "rt", encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            if r["i"] == args.event:
                run = r
                break
    ev = next((e for e in t["events"] if e["i"] == args.event), {})
    flaky = {}
    if t.get("flaky") and os.path.exists(t["flaky"]):
        flaky = read_json(t["flaky"]).get("events", {}).get(str(args.event), {})
    print(f"{t['battery']}/{t['trace']} event {args.event} {g['method']}: {ev.get('class')}"
          + (f" {ev['sub']}" if ev.get("sub") else "") + (f" at {ev['pointer']}" if "pointer" in ev else ""))
    if flaky:
        print(f"flaky: {json.dumps(flaky)}")
    patterns = flaky.get("multiset") or []

    def side(rec):
        if rec is None:
            return {"status": "absent"}
        resp = rec.get("response")
        if isinstance(resp, dict) and "result" in resp:
            resp = {"result": apply_multisets(resp["result"], patterns)}
        return {"status": rec.get("status"), "response": resp, "reason": rec.get("reason")}

    a = json.dumps(side(g), indent=1, sort_keys=True, ensure_ascii=False).splitlines()
    b = json.dumps(side(run), indent=1, sort_keys=True, ensure_ascii=False).splitlines()
    diff = list(difflib.unified_diff(a, b, "oracle", "goport", n=3, lineterm=""))
    print("\n".join(diff) if diff else "(no difference)")
    return EXIT_OK


# Go: lsp/replay_test.go:216 isInitializationMessage
def is_initialization_message(msg):
    return msg["method"] == "initialize" or msg["method"] == "initialized"


# Go: lsp/replay_test.go:220 isExitMessage
def is_exit_message(msg):
    return msg["method"] == "exit" or msg["method"] == "shutdown"


def filter_messages(messages, simple, super_simple):
    """Go: lsp/replay_test.go:131 the --simple and --superSimple filters."""
    if simple:
        # Include only initialization, file opening/changing/closing, and shutdown messages, plus the final request.
        new_messages = []
        i = 0
        while i < len(messages) and is_initialization_message(messages[i]):
            new_messages.append(messages[i])
            i += 1
        j = len(messages) - 1
        while j >= 0 and is_exit_message(messages[j]):
            j -= 1
        for k in range(i, j + 1):
            msg = messages[k]
            if msg["method"] in ("textDocument/didOpen", "textDocument/didChange", "textDocument/didClose"):
                new_messages.append(msg)
        for k in range(max(i, j), len(messages)):
            new_messages.append(messages[k])
        return new_messages
    if super_simple:
        # Include only initialization, shutdown, the last file open and the final request.
        # We assume here the final request will be for the file that was opened last.
        new_messages = []
        i = 0
        while i < len(messages) and is_initialization_message(messages[i]):
            new_messages.append(messages[i])
            i += 1
        j = len(messages) - 1
        while j >= 0 and is_exit_message(messages[j]):
            j -= 1
        open_idx = j
        while open_idx >= i:
            msg = messages[open_idx]
            if msg["method"] == "textDocument/didOpen":
                new_messages.append(msg)
                break
            open_idx -= 1
        for k in range(max(open_idx + 1, j), len(messages)):
            new_messages.append(messages[k])
        return new_messages
    return messages


def filtered_events(events, simple, super_simple):
    """[(index, event)] after the Go replay filters. Non-message events keep their place."""
    if not simple and not super_simple:
        return list(enumerate(events))
    # PORT: the harness sends initialized, shutdown and exit itself; they take part in the filter as in Go.
    messages = [{"method": "initialize", "i": 0}, {"method": "initialized", "i": None}]
    messages += [{"method": ev["method"], "i": i} for i, ev in enumerate(events)
                 if i > 0 and ev["kind"] in ("request", "notification")]
    messages += [{"method": "shutdown", "i": None}, {"method": "exit", "i": None}]
    kept = collections.Counter(m["i"] for m in filter_messages(messages, simple, super_simple) if m["i"] is not None)
    out = []
    for i, ev in enumerate(events):
        if ev["kind"] in ("request", "notification"):
            out.extend([(i, ev)] * kept[i])
        else:
            out.append((i, ev))
    return out


class Printer:
    def __init__(self, verbose):
        self.start = time.monotonic()
        self.verbose = verbose

    def __call__(self, direction, msg):
        k = message_kind(msg)
        ms = (time.monotonic() - self.start) * 1000
        head = f"{ms:9.1f}ms {direction} {k:12s} id={str(msg.get('id')):6s} {msg.get('method', '')}"
        if self.verbose or k == "response":
            payload = msg.get("params", msg.get("result", msg.get("error")))
            text = json.dumps(payload, ensure_ascii=False)
            if not self.verbose and len(text) > 400:
                text = text[:400] + f"... ({len(text)} chars)"
            head += "\n        " + text
        with PRINT_LOCK:
            print(head, flush=True)


def cmd_replay(args):
    header, events, _ = load_trace(args.trace)
    ctx = Context(args, "replay")
    try:
        printer = Printer(args.verbose)
        run = SessionRun(
            header=header, events=filtered_events(events, args.simple, args.super_simple), frozen=False,
            argv=shlex.split(args.server), role="server", run_dir=ctx.run_dir,
            key=ctx.key("replay", args.trace), marker=ctx.marker,
            request_timeout=args.request_timeout, printer=printer, keep=ctx.keep,
        )
        print(f"# server: {args.server}\n# trace: {args.trace} ({header.get('name')})", flush=True)
        result = run.run()
        print(f"# root: {result['root'].path}")
        for r in result["records"]:
            if r["kind"] == "request":
                extra = r.get("reason") or (error_class(r["response"]["error"]) if r["status"] == "error" else "")
                print(f"# event {r['i']:4d} id {r['id']:4d} {r['method']:40s} {r['status']:14s} {r.get('ms', '')} {extra}")
        print(f"# shutdown: {result['shutdown'].get('status')}; exit code {result['exit']['code']}")
        if result["exit"]["stderrTail"]:
            print("# stderr (last lines):")
            for line in result["exit"]["stderrTail"]:
                print("   ", line)
        cleanup_trace_dir(result, ctx.keep)
    finally:
        ctx.close()
    return EXIT_OK


def cmd_to_go_replay(args):
    header, events, _ = load_trace(args.trace)
    frozen = None
    if args.golden:
        _, records = read_golden(args.golden)
        frozen = {r["i"]: r for r in records}
    out = sys.stdout

    def emit(obj):
        out.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")

    # Go: lsp/replay_test.go:29 initialArguments
    emit({"rootDirUriPlaceholder": ROOT_DIR_URI_PLACEHOLDER, "rootDirPlaceholder": ROOT_DIR_PLACEHOLDER})
    skipped = 0
    for i, ev in enumerate(events):
        kind = ev["kind"]
        if kind not in ("request", "notification"):
            continue
        if frozen is not None:
            g = frozen.get(i, {})
            if kind == "request" and g.get("status") not in ("ok", "error"):
                skipped += 1
                continue
            params = g.get("params", MISSING)
        elif i == 0:
            params = initialize_params(ev, header)
        elif "paramsFrom" in ev:
            skipped += 1
            continue
        elif kind == "notification":
            params = notification_params(ev)
        else:
            params = ev.get("params", MISSING)
        # Go: lsp/replay_test.go:35 rawMessage
        line = {"kind": kind, "method": ev["method"]}
        if params is not MISSING:
            line["params"] = params
        emit(line)
        if i == 0:
            emit({"kind": "notification", "method": "initialized", "params": {}})
    emit({"kind": "request", "method": "shutdown"})
    emit({"kind": "notification", "method": "exit"})
    if skipped:
        log(f"to-go-replay: {skipped} requests skipped (paramsFrom without --golden, or not answered by the oracle)")
    return EXIT_OK


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="command", required=True)

    def common(p, runs=True):
        p.add_argument("--out-root", default=DEFAULT_OUT_ROOT)
        if runs:
            p.add_argument("--traces-dir", help="trace root (default <out-root>/traces)")
            p.add_argument("--oracle", default=DEFAULT_ORACLE)
            p.add_argument("--oracle-sha", help="golden set sha256 (default: hash of --oracle)")
            p.add_argument("--jobs", type=int, default=1)
            p.add_argument("--only", help="only traces whose name contains this text")
            p.add_argument("--request-timeout", type=float)
            p.add_argument("--keep-temp", action="store_true")

    p = sub.add_parser("record", help="run tsgo once per trace and write goldens")
    common(p)
    p.add_argument("--battery", required=True)
    p.add_argument("--force", action="store_true", help="re-record goldens that match the trace")

    p = sub.add_parser("selfcheck", help="run tsgo again on the goldens and write .flaky.json")
    common(p)
    p.add_argument("--battery", required=True)
    p.add_argument("--runs", type=int, default=1)

    p = sub.add_parser("check", help="run goport on the goldens and classify each request")
    common(p)
    p.add_argument("--battery", required=True)
    p.add_argument("--goport", required=True)
    p.add_argument("--label", required=True)
    p.add_argument("--methods", help="comma list of methods to send (full or last segment)")

    p = sub.add_parser("summary", help="rebuild summary.json and summary.md for a label")
    common(p, runs=False)
    p.add_argument("--label", required=True)
    p.add_argument("--baseline", help="earlier label: retained, new, lost, unrun and absent same counts")

    p = sub.add_parser("show", help="print one request's diff")
    common(p, runs=False)
    p.add_argument("--label", required=True)
    p.add_argument("--trace", required=True)
    p.add_argument("--event", type=int, required=True)
    p.add_argument("--battery")

    p = sub.add_parser("replay", help="run one trace against any server and print the message flow")
    p.add_argument("--out-root", default=DEFAULT_OUT_ROOT)
    p.add_argument("--trace", required=True)
    p.add_argument("--server", required=True)
    p.add_argument("--verbose", action="store_true")
    p.add_argument("--request-timeout", type=float)
    p.add_argument("--keep-temp", action="store_true")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--simple", action="store_true")
    g.add_argument("--super-simple", action="store_true")

    p = sub.add_parser("to-go-replay", help="write the Go TestReplay format to stdout")
    p.add_argument("--trace", required=True)
    p.add_argument("--golden", help="take frozen params (resolved paramsFrom) from this golden")

    args = ap.parse_args(argv)
    if getattr(args, "jobs", 1) < 1:
        ap.error("--jobs must be at least 1")
    commands = {
        "record": cmd_record,
        "selfcheck": cmd_selfcheck,
        "check": cmd_check,
        "summary": cmd_summary,
        "show": cmd_show,
        "replay": cmd_replay,
        "to-go-replay": cmd_to_go_replay,
    }
    try:
        return commands[args.command](args)
    except UsageError as e:
        kill_all_clients()
        log(f"lsp_oracle: {e}")
        return EXIT_USAGE
    except InputChanged as e:
        kill_all_clients()
        log(f"lsp_oracle: {e}")
        return EXIT_INPUT_CHANGED
    except TraceError as e:
        kill_all_clients()
        log(f"lsp_oracle: {e}")
        return EXIT_FAILED
    except KeyboardInterrupt:
        kill_all_clients()
        return 130


if __name__ == "__main__":
    sys.exit(main())
