import io, sys, tokenize

def strip(src: str, keep_license: bool) -> str:
    out = []
    lines = src.splitlines(keepends=True)
    drop = {}
    toks = tokenize.generate_tokens(io.StringIO(src).readline)
    for tok in toks:
        if tok.type != tokenize.COMMENT:
            continue
        row, col = tok.start
        text = tok.string
        if row == 1 and text.startswith("#!"):
            continue
        if row <= 2 and "coding" in text:
            continue
        if keep_license and row <= 5 and any(k in text.lower() for k in ("license", "copyright", "spdx")):
            continue
        drop[row] = col
    for i, line in enumerate(lines, 1):
        if i in drop:
            before = line[: drop[i]].rstrip()
            if before:
                out.append(before + ("\n" if line.endswith("\n") else ""))
            continue
        out.append(line)
    return "".join(out)

if __name__ == "__main__":
    sys.stdout.write(strip(sys.stdin.read(), sys.argv[1:2] == ["keep"]))
