#!/usr/bin/env python3
"""Structural formatting checker for Pine Script v6 source files.

Checks the mechanical rules that make a Pine file well-formed, without needing
TradingView's compiler:

  1. //@version directive is the first line.
  2. No tabs, no CRLF, no trailing whitespace, file ends with a newline.
  3. Brackets balance across the whole file.
  4. Line-continuation indentation. This is the rule Pine actually enforces:
     a wrapped continuation line must NOT be indented by a multiple of four
     spaces, because those indents are reserved for local-block nesting.
     Conversely a real statement must sit at a multiple of four.
  5. Local blocks opened by '=>', 'if', 'for', 'while' or 'switch' are indented.
  6. Reports lines longer than a configurable width (advisory only).

Exit status is non-zero if any hard error (1-5) is found.

Usage: python3 backtest/pine_format_check.py indicators/*.pine [--width N]
"""
import re
import sys

# A line continues onto the next when it ends with a dangling operator. '=>'
# is excluded: it opens an indented block rather than continuing an expression.
CONT_END = re.compile(
    r"(?:"
    r"\b(?:and|or|not)\b"        # dangling boolean operator
    r"|[+\-*/%,?:]"              # dangling arithmetic / ternary / comma
    r"|(?<![=<>!])=(?![=>])"     # bare assignment '=' (not ==, =>, <=, >=, !=)
    r"|[<>]=?|==|!="             # dangling comparison
    r")\s*$"
)
BLOCK_OPEN = re.compile(r"(?:=>|\bif\b.*|\bfor\b.*|\bwhile\b.*|\bswitch\b.*)\s*$")
ARROW_OPEN = re.compile(r"=>\s*$")


def strip_literals(line):
    """Replace string literals with a placeholder and drop line comments.

    Literals become a single 'S' token so that a line ending in a string is
    not mistaken for a line ending in the '=' that assigned it.
    """
    out, i = [], 0
    while i < len(line):
        ch = line[i]
        if ch == '"':
            i += 1
            while i < len(line):
                if line[i] == "\\":
                    i += 2
                    continue
                if line[i] == '"':
                    i += 1
                    break
                i += 1
            out.append("S")
            continue
        if ch == "/" and i + 1 < len(line) and line[i + 1] == "/":
            break
        out.append(ch)
        i += 1
    return "".join(out)


def check(path, width=100):
    with open(path, newline="") as fh:
        raw = fh.read()

    errors, warnings = [], []

    if "\r" in raw:
        errors.append((0, "file contains CR characters (expected LF endings)"))
    if not raw.endswith("\n"):
        errors.append((0, "file does not end with a newline"))

    lines = raw.replace("\r\n", "\n").split("\n")
    # The //@version= annotation must precede all code. TradingView tolerates
    # comment and blank lines above it, so scan past those.
    version_line = None
    for n, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or (stripped.startswith("//")
                            and not stripped.startswith("//@version=")):
            continue
        version_line = n if stripped.startswith("//@version=") else None
        break
    if version_line is None:
        errors.append((1, "no //@version= directive found before the first "
                          "statement"))

    for n, line in enumerate(lines, start=1):
        if "\t" in line:
            errors.append((n, "tab character (Pine indentation must be spaces)"))
        if line != line.rstrip():
            errors.append((n, "trailing whitespace"))
        if len(line) > width:
            warnings.append((n, f"line is {len(line)} chars (>{width})"))

    depth = 0
    prev_incomplete = False
    prev_opened_block = False
    logical_indent = 0
    opener_indent = 0
    for n, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("//"):
            continue
        code = strip_literals(line).rstrip()
        indent = len(line) - len(line.lstrip(" "))
        at_block_indent = indent % 4 == 0
        # A block body is indented relative to the start of the logical line
        # that opened it, not relative to the physical line carrying the '=>'.
        # A wrapped parameter list puts '=>' on a continuation line.
        if not prev_incomplete:
            logical_indent = indent

        if prev_incomplete and at_block_indent:
            errors.append((
                n,
                f"continuation line indented {indent} spaces (a multiple of 4); "
                f"Pine reads this as a new statement, not a continuation",
            ))
        if not prev_incomplete and not at_block_indent:
            errors.append((
                n,
                f"statement indented {indent} spaces; block indentation must "
                f"be a multiple of 4",
            ))
        if prev_opened_block and indent <= opener_indent:
            errors.append((
                n,
                f"line follows a block opener but is not indented past it "
                f"({indent} <= {opener_indent})",
            ))

        depth += (code.count("(") - code.count(")")
                  + code.count("[") - code.count("]"))
        if depth < 0:
            errors.append((n, "unbalanced closing bracket"))
            depth = 0

        prev_incomplete = depth > 0 or (
            bool(CONT_END.search(code)) and not ARROW_OPEN.search(code))
        if depth == 0 and ARROW_OPEN.search(code):
            prev_opened_block = True
            opener_indent = logical_indent
        else:
            prev_opened_block = False

    if depth != 0:
        errors.append((len(lines), f"{depth} bracket(s) left unclosed at EOF"))

    return errors, warnings


def main(argv):
    width = 100
    if "--width" in argv:
        i = argv.index("--width")
        width = int(argv[i + 1])
        del argv[i:i + 2]
    paths = argv or ["indicators/mnq_eth_final_indicator_scaffold.pine"]

    failed = False
    for path in paths:
        errors, warnings = check(path, width)
        print(f"{path}")
        for n, msg in errors:
            print(f"  ERROR   line {n}: {msg}")
        for n, msg in warnings:
            print(f"  advisory line {n}: {msg}")
        if errors:
            failed = True
            print(f"  -> {len(errors)} error(s), {len(warnings)} advisory")
        else:
            print(f"  -> clean ({len(warnings)} advisory)")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
