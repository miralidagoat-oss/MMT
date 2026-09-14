#!/usr/bin/env python3
"""Static sanity checks for a Pine v6 script (no TradingView compiler here).

Catches the classes of mistake that are fatal in Pine but invisible to eyeballs:
unbalanced brackets, tabs, assignment to a global from inside a function,
a function used before it is defined, duplicate global declarations, and
comma-joined declarations.
"""
import re
import sys

def strip_code(line):
    """Remove strings and trailing comments so bracket counting is honest."""
    out, i, in_str = [], 0, None
    while i < len(line):
        ch = line[i]
        if in_str:
            if ch == in_str:
                in_str = None
            out.append(" ")
        elif ch in "\"'":
            in_str = ch
            out.append(" ")
        elif ch == "/" and i + 1 < len(line) and line[i + 1] == "/":
            break
        else:
            out.append(ch)
        i += 1
    return "".join(out)

def mask_strings(line):
    """Like strip_code but keeps a placeholder for each string, so indentation
    and line endings stay faithful."""
    out, i, q = [], 0, None
    while i < len(line):
        ch = line[i]
        if q:
            if ch == q:
                q = None
                out.append('"')
            i += 1
            continue
        if ch in "\"'":
            q = ch
            out.append('"')
            i += 1
            continue
        if ch == "/" and i + 1 < len(line) and line[i + 1] == "/":
            break
        out.append(ch)
        i += 1
    return "".join(out).rstrip()


def _calls(text, name):
    """Every call to `name` in `text`, matched with balanced parentheses."""
    out, idx = [], 0
    while True:
        i = text.find(name + "(", idx)
        if i < 0:
            return out
        if i > 0 and (text[i - 1].isalnum() or text[i - 1] in "_."):
            idx = i + 1
            continue
        j, depth, q = i + len(name), 0, None
        while j < len(text):
            ch = text[j]
            if q:
                if ch == q:
                    q = None
            elif ch in "\"'":
                q = ch
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        out.append(text[i:j + 1])
        idx = j + 1


def _nargs(call):
    inner = call[call.index("(") + 1:-1]
    depth, q, n = 0, None, (1 if inner.strip() else 0)
    for ch in inner:
        if q:
            if ch == q:
                q = None
            continue
        if ch in "\"'":
            q = ch
        elif ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        elif ch == "," and depth == 0:
            n += 1
    return n


def arity_errors(src):
    """UDT constructors and f_* calls must match their declarations."""
    flat = re.sub(r"\n\s+", " ", src)
    errs = []
    types, cur = {}, None
    for ln in src.split("\n"):
        m = re.match(r"^type (\w+)", ln)
        if m:
            cur, types[m.group(1)] = m.group(1), 0
            continue
        if cur:
            if ln.startswith("    ") and ln.strip() and not ln.strip().startswith("//"):
                types[cur] += 1
            elif ln.strip():
                cur = None
    for tname, nf in types.items():
        for call in _calls(flat, tname + ".new"):
            if _nargs(call) != nf:
                errs.append(f"{tname}.new called with {_nargs(call)} args, type has {nf} fields")
    defs = {}
    for ln in src.split("\n"):
        m = re.match(r"^(f_\w+)\((.*)\)\s*=>", ln)
        if m:
            defs[m.group(1)] = _nargs(f"{m.group(1)}({m.group(2)})")
    for name, want in defs.items():
        for call in _calls(flat, name):
            if call.rstrip().endswith("=>"):
                continue
            if _nargs(call) != want:
                errs.append(f"{name}() called with {_nargs(call)} args, defined with {want}")
    return errs


def main(path):
    src = open(path).read()
    lines = src.split("\n")
    errs, warns = [], []

    if "\t" in src:
        errs.append("file contains TAB characters (Pine requires spaces)")

    # 1. bracket balance over the whole file
    depth = {"(": 0, "[": 0, "{": 0}
    close_map = {")": "(", "]": "[", "}": "{"}
    for n, raw in enumerate(lines, 1):
        code = strip_code(raw)
        for ch in code:
            if ch in depth:
                depth[ch] += 1
            elif ch in close_map:
                depth[close_map[ch]] -= 1
                if depth[close_map[ch]] < 0:
                    errs.append(f"line {n}: unbalanced '{ch}'")
                    depth[close_map[ch]] = 0
    for k, v in depth.items():
        if v:
            errs.append(f"unclosed '{k}' x{v} at end of file")

    # 2. Pine reads a wrapped line as a continuation only when its indent is NOT
    #    a multiple of 4; anything else starts a new statement or block.
    # word operators need a boundary or "limitEntryVector" looks like "...or"
    cont_end = (" and", " or", " not", "+", "-", "*", "/", ",", "(", "[", "?", ":",
                "==", "!=", ">=", "<=", ">", "<", "=")
    prev = ""
    for n, raw in enumerate(lines, 1):
        code = mask_strings(raw)
        if not code.strip():
            continue
        ind = len(code) - len(code.lstrip(" "))
        body = code.strip()
        prev_s = prev.strip()
        prev_cont = prev_s.endswith(cont_end) and not prev_s.endswith("=>") and \
            not prev_s.endswith('"')
        starts_op = re.match(r"^(and|or|\+|\-|\*|/|\?|:|\)|\])\s", body) is not None
        if (prev_cont or starts_op) and ind % 4 == 0:
            errs.append(f"line {n}: continuation line indented {ind} (a multiple of 4) — "
                        f"Pine will parse it as a new statement")
        prev = code

    # 3. comma-joined declarations
    for n, raw in enumerate(lines, 1):
        if re.search(r",\s*var\s+\w+", strip_code(raw)):
            errs.append(f"line {n}: comma-joined 'var' declaration is not valid Pine")

    # 4. collect global declarations and function definitions
    func_re = re.compile(r"^(f_\w+)\s*\(([^)]*)\)\s*=>")
    decl_re = re.compile(r"^(?:var\s+)?(?:float|int|bool|string|color|line|label|box|table|array<[^>]+>)\s+(\w+)\s*=")
    simple_re = re.compile(r"^(\w+)\s*=\s*[^=]")
    globals_, funcs, dup = {}, {}, []
    for n, raw in enumerate(lines, 1):
        code = strip_code(raw)
        if not code.strip() or code.startswith(" "):
            continue
        m = func_re.match(code)
        if m:
            if m.group(1) in funcs:
                errs.append(f"line {n}: function {m.group(1)} redefined")
            funcs[m.group(1)] = n
            continue
        m = decl_re.match(code) or simple_re.match(code)
        if m:
            name = m.group(1)
            if name in globals_:
                dup.append(f"line {n}: '{name}' re-declared (first at line {globals_[name]})")
            else:
                globals_[name] = n

    # 5. function bodies must not assign to globals (Pine forbids it)
    body_owner, body_indent = None, 0
    for n, raw in enumerate(lines, 1):
        code = strip_code(raw)
        if not code.strip():
            continue
        m = func_re.match(code)
        if m and not code.startswith(" "):
            body_owner, body_indent = m.group(1), 0
            continue
        ind = len(code) - len(code.lstrip(" "))
        if body_owner and ind == 0:
            body_owner = None
        if body_owner:
            for am in re.finditer(r"(\w+)\s*(:=|\+=|-=)", code):
                name = am.group(1)
                if name in globals_ and globals_[name] < funcs[body_owner]:
                    errs.append(f"line {n}: {body_owner}() assigns to global '{name}' "
                                f"(declared line {globals_[name]}) — illegal in Pine")

    # 6. functions used before definition
    for name, defline in funcs.items():
        for n, raw in enumerate(lines, 1):
            code = strip_code(raw)
            if n < defline and re.search(rf"\b{name}\s*\(", code) and not func_re.match(code):
                errs.append(f"line {n}: {name}() called before its definition (line {defline})")
                break

    # 7. declared-but-never-referenced inputs (dead knobs)
    for name, n in globals_.items():
        uses = sum(len(re.findall(rf"\b{name}\b", strip_code(l))) for l in lines)
        if uses <= 1 and not name.startswith("G_"):
            warns.append(f"line {n}: '{name}' is declared but never used")

    errs.extend(arity_errors(src))

    for w in warns:
        print("WARN ", w)
    for d in dup:
        print("WARN ", d)
    for e in errs:
        print("ERROR", e)
    print(f"\n{len(lines)} lines · {len(funcs)} functions · {len(globals_)} globals · "
          f"{len(errs)} errors · {len(warns) + len(dup)} warnings")
    return 1 if errs else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
