#!/usr/bin/env python3
"""Request battery generator for the LSP parity oracle (trace format goport-lsp-trace/1).

Writes one trace per source file. lsp_oracle.py replays each trace against
tsgo-oracle and goport. Project roots are only read, never written.

Usage:
  lsp_battery.py build [--battery b1] [--out DIR]
  lsp_battery.py sweep --root DIR --name BATTERY --out TRACES [--include PAT]... [--exclude PAT]...
                       [--k N] [--caps POSITIONS,DOTS,CALLS]
  lsp_battery.py selftest

build reads scripts/goport/lsp-battery/<battery>.json and writes one directory
per part, <out>/traces/<part>/<file>.jsonl (the layout lsp_oracle.py reads:
`--battery b1` selects every b1-* directory), plus <out>/traces/<battery>.index.json.
The fourslash part copies its listed traces into its own directory
(<out>/traces/b1-fourslash/ for b1).
<out> defaults to target/goport-lsp in the main checkout. sweep writes the
traces of one project directory into TRACES/BATTERY/. selftest checks the lsconv port.

The trace and paramsFrom format is the one in the lsp_oracle.py docstring.
Dependent requests use fixed indexes ("resolve lens i", "quick fix for
diagnostic i", up to a cap); the harness marks an index with no value not_run.

Position math (UTF-8 byte offsets to LSP line and character) is a literal port
of internal/ls/lsconv/linemap.go and converters.go at dc37b5249. The Go line
references are at fed0bf24149f (N prime, Go code under tsc/). There the
position math is the same code (lineAndCharacterToPosition and
positionToLineAndCharacter are no longer exported), and the converters also
map through a span map (content-mapped files) and take rooted paths. For a
script with no span map and a plain file path, the result is the same.
Dynamic file names and FromLSPTextChange follow dc37b5249.
"""

import argparse
import bisect
import fnmatch
import hashlib
import json
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
BATTERY_DIR = SCRIPT_DIR / "lsp-battery"
TRACE_FORMAT = "goport-lsp-trace/1"
ROOT_URI_PLACEHOLDER = "@PROJECT_ROOT_URI@"


def unported(go_name: str):
    raise NotImplementedError(f"unported: {go_name}")


# ---------------------------------------------------------------------------
# Go runtime pieces used by lsconv (unicode/utf8, unicode/utf16, net/url,
# strings, bundled, tspath). Go strings are byte strings: text is `bytes`.
# ---------------------------------------------------------------------------

RUNE_ERROR = 0xFFFD
RUNE_SELF = 0x80


# Go: unicode/utf8/utf8.go:219 DecodeRuneInString (s[pos:]); invalid input gives (RuneError, 1)
def decode_rune_in_string(s: bytes, pos: int = 0) -> tuple[int, int]:
    n = len(s) - pos
    if n < 1:
        return RUNE_ERROR, 0
    s0 = s[pos]
    if s0 < RUNE_SELF:
        return s0, 1
    # Go: first[s0] and acceptRanges, spelled out.
    if 0xC2 <= s0 <= 0xDF:
        sz, lo, hi = 2, 0x80, 0xBF
    elif s0 == 0xE0:
        sz, lo, hi = 3, 0xA0, 0xBF
    elif s0 == 0xED:
        sz, lo, hi = 3, 0x80, 0x9F
    elif 0xE1 <= s0 <= 0xEF:
        sz, lo, hi = 3, 0x80, 0xBF
    elif s0 == 0xF0:
        sz, lo, hi = 4, 0x90, 0xBF
    elif 0xF1 <= s0 <= 0xF3:
        sz, lo, hi = 4, 0x80, 0xBF
    elif s0 == 0xF4:
        sz, lo, hi = 4, 0x80, 0x8F
    else:
        return RUNE_ERROR, 1
    if n < sz:
        return RUNE_ERROR, 1
    s1 = s[pos + 1]
    if s1 < lo or hi < s1:
        return RUNE_ERROR, 1
    if sz <= 2:
        return (s0 & 0x1F) << 6 | (s1 & 0x3F), 2
    s2 = s[pos + 2]
    if s2 < 0x80 or 0xBF < s2:
        return RUNE_ERROR, 1
    if sz <= 3:
        return (s0 & 0x0F) << 12 | (s1 & 0x3F) << 6 | (s2 & 0x3F), 3
    s3 = s[pos + 3]
    if s3 < 0x80 or 0xBF < s3:
        return RUNE_ERROR, 1
    return (s0 & 0x07) << 18 | (s1 & 0x3F) << 12 | (s2 & 0x3F) << 6 | (s3 & 0x3F), 4


# Go: unicode/utf16/utf16.go:57 RuneLen
def utf16_rune_len(r: int) -> int:
    if 0 <= r < 0xD800 or 0xE000 <= r < 0x10000:
        return 1
    if 0x10000 <= r <= 0x10FFFF:
        return 2
    return -1


# Go: net/url/url.go:80 shouldEscape(c, encodePathSegment) (rules in gen_encoding_table.go)
def should_escape_path_segment(c: int) -> bool:
    if 0x61 <= c <= 0x7A or 0x41 <= c <= 0x5A or 0x30 <= c <= 0x39:
        return False
    if c in b"-_.~":
        return False
    if c in b"$&+,/:;=?@":
        return c in b"/;,?"
    return True


# Go: net/url/url.go:192 PathEscape
def path_escape(s: str) -> str:
    return "".join(f"%{c:02X}" if should_escape_path_segment(c) else chr(c) for c in s.encode("utf-8"))


# Go: bundled/embed.go:26 IsBundled
def bundled_is_bundled(path: str) -> bool:
    return path.startswith("bundled:///")


# Go: tspath/path.go:42 IsDynamicFileName
def tspath_is_dynamic_file_name(file_name: str) -> bool:
    return file_name.startswith("^/")


# Go: tspath/path.go:147 IsVolumeCharacter
def tspath_is_volume_character(char: str) -> bool:
    return "a" <= char <= "z" or "A" <= char <= "Z"


# Go: tspath/path.go:1184 SplitVolumePath
def tspath_split_volume_path(path: str) -> tuple[str, str, bool]:
    if len(path) >= 2 and tspath_is_volume_character(path[0]) and path[1] == ":":
        return path[0:2].lower(), path[2:], True
    return "", path, False


# ---------------------------------------------------------------------------
# Go: internal/ls/lsconv/linemap.go
# ---------------------------------------------------------------------------


# Go: linemap.go:14 LSPLineMap (LineStarts is linemap.go:12 LSPLineStarts)
class LSPLineMap:
    __slots__ = ("line_starts", "ascii_only")

    def __init__(self, line_starts: list[int], ascii_only: bool):
        self.line_starts = line_starts
        self.ascii_only = ascii_only  # TODO(jakebailey): collect ascii-only info per line

    # Go: linemap.go:56 ComputeIndexOfLineStart
    def compute_index_of_line_start(self, target_pos: int) -> int:
        # port of computeLineOfPosition(lineStarts: readonly number[], position: number, lowerBound?: number): number {
        line_number = bisect.bisect_left(self.line_starts, target_pos)
        ok = line_number < len(self.line_starts) and self.line_starts[line_number] == target_pos
        if not ok and line_number > 0:
            # If the actual position was not found, the binary search returns where the target line start would be inserted
            # if the target was in the slice.
            # e.g. if the line starts at [5, 10, 23, 80] and the position requested was 20
            # then the search will return (3, false).
            #
            # We want the index of the previous line start, so we subtract 1.
            line_number = line_number - 1
        return line_number


# Go: linemap.go:19 ComputeLSPLineStarts
def compute_lsp_line_starts(text: bytes) -> LSPLineMap:
    # This is like core.ComputeLineStarts, but only considers "\n", "\r", and "\r\n" as line breaks,
    # and reports when the text is ASCII-only.
    line_starts: list[int] = []
    ascii_only = True

    text_len = len(text)
    pos = 0
    line_start = 0
    while pos < text_len:
        b = text[pos]
        if b < RUNE_SELF:
            pos += 1
            if b == 0x0D:  # '\r'
                if pos < text_len and text[pos] == 0x0A:
                    pos += 1
                # fallthrough
                line_starts.append(line_start)
                line_start = pos
            elif b == 0x0A:  # '\n'
                line_starts.append(line_start)
                line_start = pos
        else:
            _, size = decode_rune_in_string(text, pos)
            pos += size
            ascii_only = False
    line_starts.append(line_start)

    return LSPLineMap(line_starts, ascii_only)


# ---------------------------------------------------------------------------
# Go: internal/ls/lsconv/converters.go
# lsproto.Position and Range are their JSON dicts; core.TextRange is (pos, end).
# ---------------------------------------------------------------------------

POSITION_ENCODING_KIND_UTF8 = "utf-8"
POSITION_ENCODING_KIND_UTF16 = "utf-16"

# Go: core/scriptkind.go ScriptKind values (at N prime, 5 is reserved: formerly External)
SCRIPT_KIND_UNKNOWN, SCRIPT_KIND_JS, SCRIPT_KIND_JSX, SCRIPT_KIND_TS, SCRIPT_KIND_TSX = 0, 1, 2, 3, 4
SCRIPT_KIND_EXTERNAL, SCRIPT_KIND_JSON = 5, 6


# Go: converters.go:44 Script
class Script:
    __slots__ = ("_file_name", "_text")

    def __init__(self, file_name: str, text: bytes):
        self._file_name = file_name
        self._text = text

    def file_name(self) -> str:
        return self._file_name

    def text(self) -> bytes:
        return self._text


# Go: converters.go:25 Converters
class Converters:
    __slots__ = ("get_line_map", "position_encoding")

    def __init__(self, get_line_map, position_encoding: str):
        self.get_line_map = get_line_map
        self.position_encoding = position_encoding

    # Go: converters.go:66 ToLSPRange
    def to_lsp_range(self, script: Script, text_range: tuple[int, int]) -> dict:
        return {
            "start": self.position_to_line_and_character(script, text_range[0]),
            "end": self.position_to_line_and_character(script, text_range[1]),
        }

    # Go: converters.go:127 FromLSPRange
    def from_lsp_range(self, script: Script, text_range: dict) -> tuple[int, int]:
        return (
            self.line_and_character_to_position(script, text_range["start"]),
            self.line_and_character_to_position(script, text_range["end"]),
        )

    # Go dc37b5249: converters.go:54 FromLSPTextChange (core.TextChange is (TextRange, NewText); not at N prime)
    def from_lsp_text_change(self, script: Script, change: dict) -> tuple[tuple[int, int], str]:
        return self.from_lsp_range(script, change["range"]), change["text"]

    # Go: converters.go:107 ToLSPLocation
    def to_lsp_location(self, script: Script, rng: tuple[int, int]) -> dict:
        return {"uri": file_name_to_document_uri(script.file_name()), "range": self.to_lsp_range(script, rng)}

    # Go: converters.go:360 lineAndCharacterToPosition
    def line_and_character_to_position(self, script: Script, line_and_character: dict) -> int:
        # UTF-8/16 0-indexed line and character to UTF-8 offset

        line_map = self.get_line_map(script.file_name())

        line = line_and_character["line"]
        char = line_and_character["character"]

        text_len = len(script.text())

        # Clamp line to valid range.
        if line >= len(line_map.line_starts):
            return text_len

        start = line_map.line_starts[line]

        # Determine the end of this line (start of next line, or end of text).
        if line + 1 < len(line_map.line_starts):
            line_end = line_map.line_starts[line + 1]
        else:
            line_end = text_len

        if line_map.ascii_only or self.position_encoding == POSITION_ENCODING_KIND_UTF8:
            return max(start, min(start + char, line_end))

        # Scan from line start counting UTF-16 code units to find the byte position.
        # Uses DecodeRuneInString (not range + RuneLen) so that invalid UTF-8 bytes
        # advance by their actual size (1) rather than RuneLen(RuneError) == 3.
        # This matches the approach in scanner.ComputePositionOfLineAndUTF16Character.
        utf16_char = 0
        pos = start
        end = line_end
        text = script.text()
        while pos < end:
            r, size = decode_rune_in_string(text, pos)
            u16_len = utf16_rune_len(r)
            if utf16_char + u16_len > char:
                break
            utf16_char += u16_len
            pos += size

        return pos

    # Go: converters.go:411 positionToLineAndCharacter
    def position_to_line_and_character(self, script: Script, position: int) -> dict:
        # UTF-8 offset to UTF-8/16 0-indexed line and character

        position = max(0, min(position, len(script.text())))

        line_map = self.get_line_map(script.file_name())

        line = bisect.bisect_left(line_map.line_starts, position)
        is_line_start = line < len(line_map.line_starts) and line_map.line_starts[line] == position
        if not is_line_start:
            line -= 1
        line = max(0, min(line, len(line_map.line_starts) - 1))

        # The current line ranges from lineMap.LineStarts[line] (or 0) to lineMap.LineStarts[line+1] (or len(text)).

        start = line_map.line_starts[line]

        if line_map.ascii_only or self.position_encoding == POSITION_ENCODING_KIND_UTF8:
            character = position - start
        else:
            # We need to rescan the text as UTF-16 to find the character offset.
            character = 0
            segment = script.text()[start:position]  # Go: for _, r := range text[start:position]
            i = 0
            while i < len(segment):
                r, size = decode_rune_in_string(segment, i)
                character += utf16_rune_len(r)
                i += size

        return {"line": line, "character": character}


# Go: converters.go:52 NewConverters
def new_converters(position_encoding: str, get_line_map) -> Converters:
    return Converters(get_line_map, position_encoding)


# Go: converters.go:290 LanguageKindToScriptKind
def language_kind_to_script_kind(language_id: str) -> int:
    return {
        "typescript": SCRIPT_KIND_TS,
        "typescriptreact": SCRIPT_KIND_TSX,
        "javascript": SCRIPT_KIND_JS,
        "javascriptreact": SCRIPT_KIND_JSX,
        "json": SCRIPT_KIND_JSON,
    }.get(language_id, SCRIPT_KIND_UNKNOWN)


# Go: converters.go:308 extraEscapeReplacer
# https://github.com/microsoft/vscode-uri/blob/edfdccd976efaf4bb8fdeca87e97c47257721729/src/uri.ts#L455
EXTRA_ESCAPE_REPLACER = {
    ":": "%3A", "/": "%2F", "?": "%3F", "#": "%23", "[": "%5B", "]": "%5D", "@": "%40",
    "!": "%21", "$": "%24", "&": "%26", "'": "%27", "(": "%28", ")": "%29", "*": "%2A",
    "+": "%2B", ",": "%2C", ";": "%3B", "=": "%3D",
    " ": "%20",
}


def extra_escape_replace(s: str) -> str:
    # Go strings.Replacer with one-byte keys replaces byte by byte.
    return "".join(EXTRA_ESCAPE_REPLACER.get(ch, ch) for ch in s)


# Go: converters.go:332 FileNameToDocumentURI and :336 PathToDocumentURI
def file_name_to_document_uri(file_name: str) -> str:
    if bundled_is_bundled(file_name):
        return file_name
    if tspath_is_dynamic_file_name(file_name):
        scheme, sep, rest = file_name[2:].partition("/")
        if not sep:
            raise RuntimeError("invalid file name: " + file_name)
        authority, sep, path = rest.partition("/")
        if not sep:
            raise RuntimeError("invalid file name: " + file_name)
        if authority == "ts-nul-authority":
            return scheme + ":" + path
        return scheme + "://" + authority + "/" + path

    volume, file_name, _ = tspath_split_volume_path(file_name)
    if volume != "":
        volume = "/" + extra_escape_replace(volume)

    file_name = file_name[2:] if file_name.startswith("//") else file_name

    parts = file_name.split("/")
    for i, part in enumerate(parts):
        parts[i] = extra_escape_replace(path_escape(part))

    return "file://" + volume + "/".join(parts)


# Go: converters.go:453 DiagnosticToLSPPull. The battery never converts diagnostics;
# the server-side conversion needs ast.Diagnostic, locale and diagnosticwriter.
def diagnostic_to_lsp_pull(ctx, converters, diagnostic, report_style_checks_as_warnings):
    unported("DiagnosticToLSPPull")


# Go: converters.go:465 DiagnosticToLSPPush
def diagnostic_to_lsp_push(ctx, converters, diagnostic):
    unported("DiagnosticToLSPPush")


# Go: converters.go:476 styleCheckDiagnostics (needs the diagnostics table) and
# converters.go:487 diagnosticToLSP
def diagnostic_to_lsp(ctx, converters, diagnostic, opts):
    unported("diagnosticToLSP")


# Go: converters.go:615 messageChainToString
def message_chain_to_string(diagnostic, locale):
    unported("messageChainToString")


# Go: converters.go:624 ptrToSliceIfNonEmpty
def ptr_to_slice_if_non_empty(s: list):
    if len(s) == 0:
        return None
    return s


# ---------------------------------------------------------------------------
# Lexer. It only finds identifiers, dots, call parentheses and commas. It skips
# comments, strings, template text and (by heuristic) regex literals. A lexer
# mistake only changes which positions are asked; both servers get the same.
# ---------------------------------------------------------------------------

# Go: scanner/scanner.go textToKeyword keys
KEYWORDS = frozenset(
    "abstract accessor any as asserts assert bigint boolean break case catch class continue const "
    "constructor debugger declare default defer delete do else enum export extends false finally for "
    "from function get if immediate implements import in infer instanceof interface intrinsic is keyof "
    "let module namespace never new null number object package private protected public override out "
    "readonly require global return satisfies set static string super switch symbol this throw true try "
    "type typeof undefined unique unknown using var void while with yield async await of".split()
)
# Keywords after which an expression (or a regex literal) starts.
EXPR_KEYWORDS = frozenset("return typeof instanceof in of new delete void throw case do else yield await".split())
EXPR_PREV_PUNCT = frozenset(["=", "(", ",", "[", "{", ";", ":", "?", "!", "&", "|", "+", "-", "*", "%", "<", ">",
                             "=>", "^", "~"])
WHITESPACE = frozenset(b" \t\n\r\v\f")
ID_START = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$")
ID_PART = ID_START | frozenset(b"0123456789")
DIGITS = frozenset(b"0123456789")
UNICODE_SPACES = frozenset([0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF, *range(0x2000, 0x200B)])
NAME_KINDS = ("id", "priv")


class Tok:
    """kind is "id", "priv" (#name), "num", "str", "tmpl", "rx", or the punctuator text."""

    __slots__ = ("kind", "start", "end", "text")

    def __init__(self, kind: str, start: int, end: int, text: str):
        self.kind, self.start, self.end, self.text = kind, start, end, text


def lex(src: bytes) -> list[Tok]:
    toks: list[Tok] = []
    n = len(src)
    braces: list[str] = []  # "c": code brace, "t": template substitution

    def emit(kind: str, s: int, e: int):
        toks.append(Tok(kind, s, e, src[s:e].decode("utf-8", "replace")))

    def scan_ident(j: int) -> int:
        while j < n:
            ch = src[j]
            if ch in ID_PART:
                j += 1
            elif ch >= RUNE_SELF:
                r, size = decode_rune_in_string(src, j)
                if r in UNICODE_SPACES:
                    break
                j += size
            else:
                break
        return j

    def scan_template(j: int) -> tuple[int, bool]:
        # Template text from j; True when a ${ substitution starts.
        while j < n:
            ch = src[j]
            if ch == 0x5C:
                j += 2
            elif ch == 0x60:
                return j + 1, False
            elif ch == 0x24 and j + 1 < n and src[j + 1] == 0x7B:
                return j + 2, True
            else:
                j += 1
        return n, False

    def scan_string(j: int) -> int:
        quote = src[j]
        j += 1
        while j < n:
            ch = src[j]
            if ch == 0x5C:
                j += 2
            elif ch == quote:
                return j + 1
            elif ch in (0x0A, 0x0D):
                return j
            else:
                j += 1
        return n

    def scan_regex(j: int) -> int | None:
        j += 1
        in_class = False
        while j < n:
            ch = src[j]
            if ch == 0x5C:
                j += 2
                continue
            if ch in (0x0A, 0x0D):
                return None
            if in_class:
                in_class = ch != 0x5D
            elif ch == 0x5B:
                in_class = True
            elif ch == 0x2F:
                j += 1
                while j < n and src[j] in ID_PART:
                    j += 1
                return j
            j += 1
        return None

    def regex_allowed() -> bool:
        if not toks:
            return True
        p = toks[-1]
        if p.kind == "id":
            return p.text in EXPR_KEYWORDS and not (len(toks) > 1 and toks[-2].kind in (".", "?."))
        return p.kind not in ("num", "str", "tmpl", "rx", "priv", ")", "]", "}")

    i = 3 if src.startswith(b"\xef\xbb\xbf") else 0
    if src.startswith(b"#!", i):
        while i < n and src[i] not in (0x0A, 0x0D):
            i += 1
    while i < n:
        c = src[i]
        nx = src[i + 1] if i + 1 < n else 0
        if c in WHITESPACE:
            i += 1
        elif c >= RUNE_SELF:
            r, size = decode_rune_in_string(src, i)
            if r in UNICODE_SPACES:
                i += size
            else:
                j = scan_ident(i)
                emit("id", i, j)
                i = j
        elif c == 0x2F and nx == 0x2F:
            while i < n and src[i] not in (0x0A, 0x0D):
                i += 1
        elif c == 0x2F and nx == 0x2A:
            j = src.find(b"*/", i + 2)
            i = n if j < 0 else j + 2
        elif c == 0x2F and regex_allowed() and (j := scan_regex(i)) is not None:
            emit("rx", i, j)
            i = j
        elif c in (0x22, 0x27):
            j = scan_string(i)
            emit("str", i, j)
            i = j
        elif c == 0x60 or (c == 0x7D and braces and braces[-1] == "t"):
            if c == 0x7D:
                braces.pop()
            j, substitution = scan_template(i + 1)
            emit("tmpl", i, j)
            if substitution:
                braces.append("t")
            i = j
        elif c == 0x7B:
            braces.append("c")
            emit("{", i, i + 1)
            i += 1
        elif c == 0x7D:
            if braces:
                braces.pop()
            emit("}", i, i + 1)
            i += 1
        elif c in ID_START:
            j = scan_ident(i)
            emit("id", i, j)
            i = j
        elif c == 0x23 and (nx in ID_START or nx >= RUNE_SELF):
            j = scan_ident(i + 1)
            emit("priv", i, j)
            i = j
        elif c in DIGITS or (c == 0x2E and nx in DIGITS):
            j = i + 1
            hex_like = c == 0x30 and nx in b"xXbBoO"
            while j < n and (src[j] in ID_PART or src[j] == 0x2E
                             or (src[j] in b"+-" and src[j - 1] in b"eE" and not hex_like)):
                j += 1
            emit("num", i, j)
            i = j
        elif c == 0x2E:
            width = 3 if src.startswith(b"...", i) else 1
            emit(src[i:i + width].decode(), i, i + width)
            i += width
        elif c == 0x3F and nx == 0x2E and not (i + 2 < n and src[i + 2] in DIGITS):
            emit("?.", i, i + 2)
            i += 2
        elif c == 0x3D and nx == 0x3E:
            emit("=>", i, i + 2)
            i += 2
        else:
            emit(chr(c), i, i + 1)
            i += 1
    return toks


def is_name(toks: list[Tok], idx: int) -> bool:
    """A non-keyword identifier, a private name, or any word after `.` / `?.`."""
    t = toks[idx]
    if t.kind == "priv":
        return True
    if t.kind != "id":
        return False
    return t.text not in KEYWORDS or (idx > 0 and toks[idx - 1].kind in (".", "?."))


def match_brackets(toks: list[Tok]) -> dict[int, int]:
    openers = {")": "(", "]": "[", "}": "{"}
    match: dict[int, int] = {}
    stack: list[int] = []
    for idx, t in enumerate(toks):
        if t.kind in ("(", "[", "{"):
            stack.append(idx)
        elif t.kind in openers:
            for s in range(len(stack) - 1, -1, -1):
                if toks[stack[s]].kind == openers[t.kind]:
                    match[stack[s]] = idx
                    del stack[s:]
                    break
    return match


def spread(items: list, cap: int | None) -> list:
    """All items, or `cap` items spaced evenly over the list."""
    if cap is None or len(items) <= cap:
        return list(items)
    return [items[i * len(items) // cap] for i in range(cap)]


class Samples:
    """Token indexes for the per-position requests of one file (map-oracle 4.2)."""

    def __init__(self, toks: list[Tok], k: int, caps: dict, sweep: dict):
        match = match_brackets(toks)
        names = [i for i in range(len(toks)) if is_name(toks, i)]
        self.positions = spread(names[::k], caps.get("positions"))
        self.dots = spread([i for i, t in enumerate(toks)
                            if t.kind in (".", "?.") and i + 1 < len(toks) and toks[i + 1].kind in NAME_KINDS],
                           caps.get("dots"))
        calls = []
        for i, t in enumerate(toks):
            if t.kind != "(" or i == 0 or not (is_name(toks, i - 1) or toks[i - 1].text == "super"):
                continue
            before = toks[i - 2] if i > 1 else None
            if before is not None and (before.text == "function"
                                       or (before.kind == "*" and i > 2 and toks[i - 3].text == "function")):
                continue  # declaration name, not a call
            close = match.get(i)
            after = toks[close + 1] if close is not None and close + 1 < len(toks) else None
            if after is not None and after.kind in ("{", "=>", ":"):
                continue  # method or function-like declaration
            comma = None
            j = i + 1
            while close is not None and j < close:
                if toks[j].kind == ",":
                    comma = j
                    break
                j = match[j] + 1 if j in match else j + 1
            calls.append((i, comma))
        self.calls = spread(calls, caps.get("calls"))
        starts = [i for i in names if toks[i].kind == "id" and i > 0 and toks[i - 1].kind not in (".", "?.")
                  and (toks[i - 1].kind in EXPR_PREV_PUNCT
                       or (toks[i - 1].kind == "id" and toks[i - 1].text in EXPR_KEYWORDS))]
        self.global_completions = spread(starts, sweep["globalCompletionsPerFile"])
        functions = [i for i in range(1, len(toks)) if toks[i].kind == "id" and is_name(toks, i)
                     and (toks[i - 1].text == "function"
                          or (toks[i - 1].kind == "*" and i > 1 and toks[i - 2].text == "function"))]
        self.functions = spread(functions, sweep["callHierarchyCap"])


# ---------------------------------------------------------------------------
# Traces
# ---------------------------------------------------------------------------

LANGUAGE_IDS = {
    ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact",
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact",
}

SEMANTIC_TOKEN_TYPES = ["namespace", "class", "enum", "interface", "struct", "typeParameter", "type", "parameter",
                        "variable", "property", "enumMember", "decorator", "event", "function", "method", "macro",
                        "label", "comment", "string", "keyword", "number", "regexp", "operator"]
SEMANTIC_TOKEN_MODIFIERS = ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async",
                            "modification", "documentation", "defaultLibrary", "local"]


def get_capabilities_with_defaults(position_encoding: str) -> dict:
    """internal/fourslash/fourslash.go:674 getCapabilitiesWithDefaults(nil), with our position encoding."""
    doc_formats = ["markdown", "plaintext"]
    diagnostic_caps = {"relatedInformation": True, "tagSupport": {"valueSet": [1, 2]}}
    return {
        "general": {"positionEncodings": [position_encoding]},
        "experimental": {"hoverVerbosityLevel": True},
        "textDocument": {
            "completion": {
                "completionItem": {"snippetSupport": True, "commitCharactersSupport": True, "preselectSupport": True,
                                   "labelDetailsSupport": True, "insertReplaceSupport": True,
                                   "documentationFormat": doc_formats},
                "completionList": {"itemDefaults": ["commitCharacters", "editRange"]},
            },
            "diagnostic": diagnostic_caps,
            "publishDiagnostics": diagnostic_caps,
            "semanticTokens": {"requests": {"full": True}, "tokenTypes": SEMANTIC_TOKEN_TYPES,
                               "tokenModifiers": SEMANTIC_TOKEN_MODIFIERS, "formats": ["relative"]},
            "definition": {"linkSupport": True},
            "typeDefinition": {"linkSupport": True},
            "implementation": {"linkSupport": True},
            "hover": {"contentFormat": doc_formats},
            "signatureHelp": {
                "signatureInformation": {"documentationFormat": doc_formats,
                                         "parameterInformation": {"labelOffsetSupport": True},
                                         "activeParameterSupport": True},
                "contextSupport": True,
            },
            "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
            "foldingRange": {"rangeLimit": 5000,
                             "foldingRangeKind": {"valueSet": ["comment", "imports", "region"]},
                             "foldingRange": {"collapsedText": True}},
        },
        "workspace": {
            "fileOperations": {"willRename": True},
            "workspaceEdit": {"documentChanges": True, "resourceOperations": ["rename"]},
            "configuration": True,
        },
    }


def document_uri(rel: str) -> str:
    # The harness replaces the placeholder with FileNameToDocumentURI(root). Roots keep
    # only characters that PathEscape leaves alone, so per-segment escaping of the
    # relative path gives the same URI as escaping the whole file name.
    return ROOT_URI_PLACEHOLDER + file_name_to_document_uri("/" + rel)[len("file://"):]


class Trace:
    def __init__(self):
        self.events: list[dict] = []
        self.methods: Counter = Counter()
        self.conditional = 0

    def request(self, method: str, params=None, params_from=None) -> int:
        event = {"kind": "request", "method": method}
        if params is not None:
            event["params"] = params
        if params_from is not None:
            event["paramsFrom"] = params_from
            self.conditional += 1
        self.events.append(event)
        self.methods[method] += 1
        return len(self.events) - 1

    def notification(self, method: str, params: dict):
        self.events.append({"kind": "notification", "method": method, "params": params})


class Battery:
    """Shared request settings from the manifest."""

    def __init__(self, manifest: dict):
        self.encoding = manifest["positionEncoding"]
        self.sweep = manifest["sweep"]
        self.config = manifest["config"]
        self.initialize = {
            "processId": None,
            "rootUri": ROOT_URI_PLACEHOLDER,
            "locale": "en-US",
            "capabilities": get_capabilities_with_defaults(self.encoding),
            "initializationOptions": manifest["initializationOptions"],
        }

    def file_trace(self, rel: str, text: bytes, k: int, caps: dict, extras: list[dict]) -> Trace:
        """All requests for one open file: map-oracle 4.2, then the case extras."""
        sweep = self.sweep
        script = Script(rel, text)
        line_map = compute_lsp_line_starts(text)
        conv = new_converters(self.encoding, lambda _: line_map)

        def lsp(pos: int) -> dict:
            return conv.position_to_line_and_character(script, pos)

        def after_first_rune(pos: int) -> dict:  # "start + 1" in characters
            return lsp(pos + decode_rune_in_string(text, pos)[1])

        uri = document_uri(rel)
        td = {"uri": uri}
        end = lsp(len(text))
        full = {"start": {"line": 0, "character": 0}, "end": end}
        range_lines = sweep["semanticTokensRangeLines"]
        head_end = {"line": range_lines, "character": 0} if len(line_map.line_starts) > range_lines else end
        ata_off = self.config["js/ts"]

        tr = Trace()
        tr.request("initialize", self.initialize)
        language_id = LANGUAGE_IDS[os.path.splitext(rel)[1]]
        assert language_kind_to_script_kind(language_id) != SCRIPT_KIND_UNKNOWN
        tr.notification("textDocument/didOpen", {"textDocument": {
            "uri": uri, "languageId": language_id, "version": 1, "text": text.decode("utf-8")}})

        # Whole-file requests.
        diagnostic = tr.request("textDocument/diagnostic", {"textDocument": td})
        tr.request("textDocument/documentSymbol", {"textDocument": td})
        tr.request("textDocument/foldingRange", {"textDocument": td})
        tr.request("textDocument/semanticTokens/full", {"textDocument": td})
        tr.request("textDocument/semanticTokens/range",
                   {"textDocument": td, "range": {"start": {"line": 0, "character": 0}, "end": head_end}})
        tr.request("textDocument/inlayHint", {"textDocument": td, "range": full})
        tr.notification("workspace/didChangeConfiguration", {"settings": {"js/ts": {**ata_off, **sweep["allPrefs"]}}})
        tr.request("textDocument/inlayHint", {"textDocument": td, "range": full})
        tr.request("textDocument/formatting", {"textDocument": td, "options": sweep["formattingOptions"]})
        lenses = tr.request("textDocument/codeLens", {"textDocument": td})
        for i in range(sweep["codeLensResolveCap"]):
            tr.request("codeLens/resolve", params_from={"event": lenses, "pointer": "", "pick": {"index": i}})
        tr.notification("workspace/didChangeConfiguration", {"settings": {"js/ts": ata_off}})
        zero = {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 0}}
        tr.request("textDocument/codeAction", {"textDocument": td, "range": zero, "context": {
            "diagnostics": [], "only": ["source.organizeImports"], "triggerKind": 1}})
        for i in range(sweep["quickFixCap"]):
            tr.request("textDocument/codeAction",
                       {"textDocument": td, "range": None,
                        "context": {"diagnostics": [None], "only": ["quickfix"], "triggerKind": 1}},
                       {"event": diagnostic, "pointer": "/items", "pick": {"index": i},
                        "into": [{"to": "/range", "from": "/range"}, {"to": "/context/diagnostics/0", "from": ""}]})

        toks = lex(text)
        samples = Samples(toks, k, caps, sweep)

        # Per sampled identifier.
        for idx in samples.positions:
            tdp = {"textDocument": td, "position": after_first_rune(toks[idx].start)}
            tr.request("textDocument/hover", tdp)
            tr.request("textDocument/definition", tdp)
            tr.request("textDocument/typeDefinition", tdp)
            tr.request("textDocument/implementation", tdp)
            tr.request("textDocument/references", {**tdp, "context": {"includeDeclaration": True}})
            tr.request("textDocument/documentHighlight", tdp)
            tr.request("textDocument/prepareRename", tdp)
            tr.request("textDocument/rename", {**tdp, "newName": sweep["renameTo"]})
            tr.request("textDocument/selectionRange", {"textDocument": td, "positions": [tdp["position"]]})

        # Member completions after `.`.
        for idx in samples.dots:
            completion = tr.request("textDocument/completion", {
                "textDocument": td, "position": lsp(toks[idx].end),
                "context": {"triggerKind": 2, "triggerCharacter": "."}})
            for i in range(sweep["completionResolvePerList"]):
                tr.request("completionItem/resolve", params_from={
                    "event": completion, "pointer": "/items",
                    "pick": {"sortBy": ["sortText", "label"], "index": i}})

        # Signature help after a call `(` and at its first `,`.
        for open_idx, comma_idx in samples.calls:
            for idx, trigger in ((open_idx, "("), (comma_idx, ",")):
                if idx is not None:
                    tr.request("textDocument/signatureHelp", {
                        "textDocument": td, "position": lsp(toks[idx].end),
                        "context": {"triggerKind": 2, "triggerCharacter": trigger, "isRetrigger": False}})

        # Global completions at a few identifier starts.
        for idx in samples.global_completions:
            tr.request("textDocument/completion", {
                "textDocument": td, "position": lsp(toks[idx].start), "context": {"triggerKind": 1}})

        tr.request("workspace/symbol", {"query": os.path.basename(rel).split(".")[0]})

        for idx in samples.functions:
            call_hierarchy(tr, {"textDocument": td, "position": after_first_rune(toks[idx].start)})

        labels: dict[str, int] = {}
        for extra in extras:
            params = {"_vs_textDocument": td} if extra["method"] == "textDocument/_vs_onAutoInsert" \
                else {"textDocument": td}
            if "find" in extra:
                needle = extra["find"].encode("utf-8")
                at = -1
                for _ in range(extra.get("occurrence", 1)):
                    at = text.find(needle, at + 1)
                    if at < 0:
                        raise SystemExit(f"{rel}: extra anchor not found: {extra['find']!r}")
                at += len(needle) if extra.get("after") else extra.get("delta", 0)
                key = "_vs_position" if "_vs_textDocument" in params else "position"
                params[key] = lsp(at)
            params.update(extra.get("params", {}))
            if extra["method"] == "textDocument/prepareCallHierarchy" and extra.get("calls"):
                call_hierarchy(tr, params)
                continue
            params_from = None
            if "activeSignatureHelpFrom" in extra:
                params_from = {"event": labels[extra["activeSignatureHelpFrom"]], "pointer": "",
                               "into": "/context/activeSignatureHelp"}
            event = tr.request(extra["method"], params, params_from)
            if "label" in extra:
                labels[extra["label"]] = event
        return tr


def call_hierarchy(tr: Trace, params: dict):
    prepared = tr.request("textDocument/prepareCallHierarchy", params)
    for method in ("callHierarchy/incomingCalls", "callHierarchy/outgoingCalls"):
        tr.request(method, {"item": None},
                   {"event": prepared, "pointer": "", "pick": {"index": 0}, "into": "/item"})


def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def write_trace(out_dir: Path, header: dict, tr: Trace) -> dict:
    body = "".join(dumps(line) + "\n" for line in [header, *tr.events]).encode("utf-8")
    path = out_dir / (header["name"] + ".jsonl")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return {"name": header["name"], "file": path.relative_to(out_dir).as_posix(),
            "requests": sum(tr.methods.values()), "conditionalRequests": tr.conditional,
            "sha256": hashlib.sha256(body).hexdigest()}


def read_source(path: Path) -> bytes:
    text = path.read_bytes()
    text.decode("utf-8")  # didOpen carries text as a JSON string; refuse invalid UTF-8
    return text


def list_sources(root: Path, include: list[str], exclude: list[str], extensions: list[str]) -> list[str]:
    """Relative POSIX paths under root, sorted. Patterns are fnmatch (`*` crosses `/`)."""
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != "node_modules")
        for name in filenames:
            rel = Path(dirpath, name).relative_to(root).as_posix()
            if (os.path.splitext(name)[1] in extensions and any(fnmatch.fnmatchcase(rel, p) for p in include)
                    and not any(fnmatch.fnmatchcase(rel, p) for p in exclude)):
                found.append(rel)
    return sorted(found)


def guard_out(out_dir: Path, roots: list[Path]):
    out = out_dir.resolve()
    for root in roots:
        if out.is_relative_to(root.resolve()):
            raise SystemExit(f"refusing to write traces inside a read-only root: {out} is under {root}")


def sweep_project(battery: Battery, part: dict, out_dir: Path) -> list[dict]:
    root = Path(part["root"])
    rels = list_sources(root, part["include"], part["exclude"], battery.sweep["extensions"])
    if "expectFiles" in part and len(rels) != part["expectFiles"]:
        raise SystemExit(f"{part['name']}: found {len(rels)} files, manifest expects {part['expectFiles']}")
    entries = []
    for rel in rels:
        text = read_source(root / rel)
        tr = battery.file_trace(rel, text, part["k"], part["caps"], [])
        header = {
            "format": TRACE_FORMAT,
            "name": f"{part['name']}/{rel}",
            "source": {"kind": "sweep", "part": part["name"], "file": rel, "complete": True,
                       "sha256": hashlib.sha256(text).hexdigest(), "k": part["k"], "caps": part["caps"]},
            "root": {"kind": "project", "dir": str(root.resolve())},
            "cwd": "",
            "config": battery.config,
        }
        entries.append(write_trace(out_dir, header, tr))
    return entries


def sweep_inline(battery: Battery, part: dict, out_dir: Path) -> list[dict]:
    entries = []
    for case in part["cases"]:
        case_dir = BATTERY_DIR / part["dir"] / case
        spec_path = case_dir / "case.json"
        spec = json.loads(spec_path.read_text()) if spec_path.exists() else {}
        files = {}
        for path in sorted(p for p in case_dir.rglob("*") if p.is_file() and p != spec_path):
            files[path.relative_to(case_dir).as_posix()] = read_source(path).decode("utf-8")
        swept = spec.get("sweep") or [rel for rel in files if os.path.splitext(rel)[1] in battery.sweep["extensions"]
                                      and not rel.endswith(".d.ts")]
        for rel in swept:
            text = files[rel].encode("utf-8")
            extras = [e for e in spec.get("extra", []) if e["file"] == rel]
            tr = battery.file_trace(rel, text, part["k"], part["caps"], extras)
            header = {
                "format": TRACE_FORMAT,
                "name": f"{part['name']}/{case}/{rel}",
                "source": {"kind": "inline", "part": part["name"], "case": case, "file": rel, "complete": True,
                           "description": spec.get("description", ""),
                           "sha256": hashlib.sha256(text).hexdigest(), "k": part["k"], "caps": part["caps"]},
                "root": {"kind": "materialize", "files": files},
                "cwd": "",
                "config": battery.config,
            }
            entries.append(write_trace(out_dir, header, tr))
    return entries


def copy_fourslash(part: dict, main: Path, traces_root: Path) -> tuple[list[dict], bool]:
    """Copies the listed fourslash traces (from fourslash_import.py) into the part directory.

    List lines are test names, optionally with a `fourslash/` prefix; `#` starts a comment."""
    listing = BATTERY_DIR / part["list"]
    if not listing.exists():
        return [], False
    source_dir = main / part["traceDir"]
    entries = []
    for line in listing.read_text().splitlines():
        test = line.split("#", 1)[0].strip().removeprefix("fourslash/")
        if not test:
            continue
        entry = {"name": f"{part['name']}/{test}", "source": None}
        for suffix in (".jsonl", ".jsonl.gz"):
            src = source_dir / f"{test}{suffix}"
            if src.exists():
                body = src.read_bytes()
                dst = traces_root / part["name"] / f"{test}{suffix}"
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(body)
                entry.update(source=str(src), file=dst.relative_to(traces_root).as_posix(),
                             sha256=hashlib.sha256(body).hexdigest())
                break
        entries.append(entry)
    return entries, True


def main_checkout() -> Path:
    common = subprocess.run(["git", "-C", str(SCRIPT_DIR), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                            check=True, capture_output=True, text=True).stdout.strip()
    return Path(common).parent


def file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def print_summary(parts: list[dict]):
    for part in parts:
        traces = part["traces"]
        if part["kind"] == "fourslash":
            found = sum("file" in t for t in traces)
            state = f"{found}/{len(traces)} listed traces copied" if part["listPresent"] else "list missing"
            print(f"{part['name']:16s} {part['schedule']:9s} {found:4d} traces ({state})")
            continue
        requests = sum(t["requests"] for t in traces)
        conditional = sum(t["conditionalRequests"] for t in traces)
        print(f"{part['name']:16s} {part['schedule']:9s} {len(traces):4d} traces {requests:7d} requests "
              f"({conditional} with paramsFrom)")


def cmd_build(args) -> int:
    manifest_path = BATTERY_DIR / f"{args.battery}.json"
    manifest = json.loads(manifest_path.read_text())
    battery = Battery(manifest)
    main = main_checkout()
    traces_root = (Path(args.out) if args.out else main / "target/goport-lsp") / "traces"
    guard_out(traces_root, [Path(p["root"]) for p in manifest["parts"] if p["kind"] == "project"]
              + [main / "target/project-inputs", BATTERY_DIR])
    parts = []
    for part in manifest["parts"]:
        entry = {"name": part["name"], "kind": part["kind"], "schedule": part["schedule"]}
        if part["kind"] == "inline":
            entry["traces"] = sweep_inline(battery, part, traces_root)
        elif part["kind"] == "project":
            entry["root"] = str(Path(part["root"]).resolve())
            entry["traces"] = sweep_project(battery, part, traces_root)
        elif part["kind"] == "fourslash":
            entry["list"] = str(BATTERY_DIR / part["list"])
            entry["traces"], entry["listPresent"] = copy_fourslash(part, main, traces_root)
        else:
            raise SystemExit(f"unknown part kind: {part['kind']}")
        parts.append(entry)
    trace_set = hashlib.sha256("".join(f"{t['name']} {t.get('sha256', '')}\n"
                                       for p in parts for t in p["traces"]).encode()).hexdigest()
    index = {"format": "goport-lsp-battery-index/1", "battery": manifest["battery"],
             "manifest": str(manifest_path), "manifestSha256": file_sha(manifest_path),
             "generatorSha256": file_sha(Path(__file__)), "positionEncoding": battery.encoding,
             "traceSetSha256": trace_set, "parts": parts}
    (traces_root / f"{manifest['battery']}.index.json").write_text(json.dumps(index, indent=1) + "\n")
    print(f"traces: {traces_root}")
    print_summary(parts)
    written = {t["file"] for p in parts for t in p["traces"] if "file" in t}
    for part in parts:
        part_dir = traces_root / part["name"]
        stale = sorted(rel for f in part_dir.rglob("*.jsonl*")
                       if (rel := f.relative_to(traces_root).as_posix()) not in written) if part_dir.exists() else []
        if stale:
            print(f"warning: {part['name']}: {len(stale)} old trace files not in the index (kept), e.g. {stale[0]}")
    missing = [t["name"] for p in parts for t in p["traces"] if "file" not in t]
    if missing:
        print(f"warning: {len(missing)} listed fourslash traces not found, e.g. {missing[0]}")
    return 0


def cmd_sweep(args) -> int:
    manifest = json.loads((BATTERY_DIR / "b1.json").read_text())
    battery = Battery(manifest)
    positions, dots, calls = ([int(x) for x in args.caps.split(",")] if args.caps else (None, None, None))
    part = {"name": args.name, "root": args.root, "include": args.include or ["*"], "exclude": args.exclude or [],
            "k": args.k, "caps": {"positions": positions, "dots": dots, "calls": calls}}
    out_dir = Path(args.out)
    guard_out(out_dir, [Path(args.root), main_checkout() / "target/project-inputs"])
    traces = sweep_project(battery, part, out_dir)
    print_summary([{"name": args.name, "kind": "project", "schedule": "manual", "traces": traces}])
    return 0


def cmd_selftest(_args) -> int:
    """Go lsconv tests: TestFileNameToDocumentURI, TestConvertersInvalidUTF8 and the
    TestConvertersAgainstJSReference cases, with Python str as the UTF-16 reference."""
    failures = []

    def check(ok: bool, what: str):
        if not ok:
            failures.append(what)

    for file_name, uri in [
        ("/path/to/file.ts", "file:///path/to/file.ts"),
        ("//server/share/file.ts", "file://server/share/file.ts"),
        ("d:/work/tsgo932/lib/utils.ts", "file:///d%3A/work/tsgo932/lib/utils.ts"),
        ("d:/work/tsgo932/app/(test)/comp/comp-test.tsx", "file:///d%3A/work/tsgo932/app/%28test%29/comp/comp-test.tsx"),
        ("c:/test/me", "file:///c%3A/test/me"),
        ("//shares/files/c#/p.cs", "file://shares/files/c%23/p.cs"),
        ("c:/Source/Zürich or Zurich (ˈzjʊərɪk,/Code/resources/app/plugins/c#/plugin.json",
         "file:///c%3A/Source/Z%C3%BCrich%20or%20Zurich%20%28%CB%88zj%CA%8A%C9%99r%C9%AAk%2C/Code/resources/app/plugins/c%23/plugin.json"),
        ("c:/test %/path", "file:///c%3A/test%20%25/path"),
        ("/", "file:///"),
        ("/_:/path", "file:///_%3A/path"),
        ("/users/me/c#-projects/", "file:///users/me/c%23-projects/"),
        ("//localhost/c$/GitDevelopment/express", "file://localhost/c%24/GitDevelopment/express"),
        ("c:/test with %25/c#code", "file:///c%3A/test%20with%20%2525/c%23code"),
        ("^/untitled/ts-nul-authority/Untitled-1", "untitled:Untitled-1"),
        ("^/untitled/ts-nul-authority/c:/Users/jrieken/Code/abc.txt", "untitled:c:/Users/jrieken/Code/abc.txt"),
        ("^/untitled/ts-nul-authority///wsl%2Bubuntu/home/jabaile/work/TypeScript-go/newfile.ts",
         "untitled://wsl%2Bubuntu/home/jabaile/work/TypeScript-go/newfile.ts"),
    ]:
        got = file_name_to_document_uri(file_name)
        check(got == uri, f"FileNameToDocumentURI({file_name!r}) = {got!r}, want {uri!r}")

    def converters_for(text: bytes) -> tuple[Converters, Script]:
        line_map = compute_lsp_line_starts(text)
        return new_converters(POSITION_ENCODING_KIND_UTF16, lambda _: line_map), Script("test.ts", text)

    text = b"a\x80b\ncd"
    conv, script = converters_for(text)
    for line, char, byte_pos in [(0, 0, 0), (0, 1, 1), (0, 2, 2), (0, 3, 3), (1, 0, 4), (1, 1, 5), (1, 2, 6)]:
        lc = {"line": line, "character": char}
        check(conv.line_and_character_to_position(script, lc) == byte_pos, f"invalid utf8 ({line},{char})")
        check(conv.position_to_line_and_character(script, byte_pos) == lc, f"invalid utf8 byte {byte_pos}")
    for byte_pos in range(len(text) + 1):
        lc = conv.position_to_line_and_character(script, byte_pos)
        check(conv.line_and_character_to_position(script, lc) == byte_pos, f"invalid utf8 round trip {byte_pos}")

    for name, s in [
        ("empty", ""), ("ascii", "hello\nworld"), ("ascii_crlf", "hello\r\nworld\r\n!"), ("ascii_cr_only", "a\rb\rc"),
        ("trailing_newline", "abc\n"), ("bmp_em_dash", "ab\u2014cd\nef"), ("bmp_multi", "α\nβ\nγδε\nzz"),
        ("supplementary_emoji", "x\U0001F600y\nz"), ("supplementary_at_lineend", "ab\U0001F600\ncd\U0001F60A"),
        ("supplementary_only", "\U0001F600\U0001F601\U0001F602"), ("mixed", "α \u2014 \U0001F600\r\nβ\nγ\r"),
        ("long_mixed_ws", "  \tαβ\n\t\U0001F600  end\n"), ("zwj_emoji", "\U0001F468\u200D\U0001F4BB\nnext"),
        ("only_newlines", "\n\n\r\n\r"),
    ]:
        conv, script = converters_for(s.encode("utf-8"))
        # Reference: LSP line starts over UTF-16 units, one row per code point boundary.
        units = [len(ch.encode("utf-16-le")) // 2 for ch in s]
        line_starts, i = [0], 0
        while i < len(s):
            if s[i] == "\r" and i + 1 < len(s) and s[i + 1] == "\n":
                i += 1
            if s[i] in "\r\n":
                line_starts.append(sum(units[:i + 1]))
            i += 1
        byte_pos = js_idx = 0
        for ch in [*s, None]:
            line = bisect.bisect_right(line_starts, js_idx) - 1
            lc = {"line": line, "character": js_idx - line_starts[line]}
            check(conv.position_to_line_and_character(script, byte_pos) == lc, f"{name}: byte {byte_pos} -> {lc}")
            check(conv.line_and_character_to_position(script, lc) == byte_pos, f"{name}: {lc} -> byte {byte_pos}")
            if ch is not None:
                byte_pos += len(ch.encode("utf-8"))
                js_idx += len(ch.encode("utf-16-le")) // 2

    for what in failures:
        print("FAIL", what)
    print(f"selftest: {len(failures)} failures")
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="write all traces of a battery manifest")
    b.add_argument("--battery", default="b1")
    b.add_argument("--out", help="output root (default: target/goport-lsp in the main checkout)")
    s = sub.add_parser("sweep", help="write sweep traces for one project directory")
    s.add_argument("--root", required=True)
    s.add_argument("--name", required=True, help="battery (directory) name")
    s.add_argument("--out", required=True, help="traces root")
    s.add_argument("--include", action="append")
    s.add_argument("--exclude", action="append")
    s.add_argument("--k", type=int, default=1)
    s.add_argument("--caps", help="POSITIONS,DOTS,CALLS per file")
    sub.add_parser("selftest", help="check the lsconv port against the Go test tables")
    args = ap.parse_args()
    return {"build": cmd_build, "sweep": cmd_sweep, "selftest": cmd_selftest}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
