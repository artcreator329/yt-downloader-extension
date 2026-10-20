#!/usr/bin/env python3
"""
Copy the extension popup's real styles into the landing page, scoped so they
only apply to the walkthrough mock-ups: every selector in popup/popup.css is
prefixed with `.pp`, and its keyframes are renamed `pp-*` so they can't clash
with the page's own.
The result replaces the block between the BEGIN/END markers in
landing/index.html. deploy.py runs this before every deploy, so the
mock-ups always match the shipped extension.
"""
import os
import re

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(BASE_DIR, 'landing', 'index.html')
BEGIN = '/* ===== BEGIN generated replica CSS (landing/sync_replica_css.py) ===== */'
END = '/* ===== END generated replica CSS ===== */'


def _blocks(text):
    """Yield (prelude, body) for each top-level `prelude { body }` block."""
    i, n = 0, len(text)
    while i < n:
        j = text.find('{', i)
        if j < 0:
            return
        prelude = text[i:j].strip()
        depth, k = 1, j + 1
        while depth and k < n:
            if text[k] == '{':
                depth += 1
            elif text[k] == '}':
                depth -= 1
            k += 1
        yield prelude, text[j + 1:k - 1]
        i = k


def _scope_selector(selector, scope):
    out = []
    for part in selector.split(','):
        part = part.strip()
        if part in ('html', 'body'):
            out.append(scope)
        elif part.startswith('body'):
            out.append(scope + part[4:])
        else:
            out.append(f'{scope} {part}')
    return ', '.join(out)


def scope_css(css, scope, kf_prefix):
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    keyframes = re.findall(r'@keyframes\s+([\w-]+)', css)
    rules = []
    for prelude, body in _blocks(css):
        if prelude.startswith('@keyframes'):
            name = prelude.split()[1]
            rules.append(f'@keyframes {kf_prefix}{name} {{{" ".join(body.split())}}}')
        elif prelude.startswith('@media'):
            inner = ' '.join(f'{_scope_selector(s, scope)} {{{" ".join(b.split())}}}' for s, b in _blocks(body))
            rules.append(f'{prelude} {{ {inner} }}')
        else:
            rules.append(f'{_scope_selector(prelude, scope)} {{ {" ".join(body.split())} }}')
    text = '\n'.join(rules)

    def rename(match):
        decl = match.group(0)
        for name in keyframes:
            decl = re.sub(rf'\b{re.escape(name)}\b', kf_prefix + name, decl)
        return decl

    return re.sub(r'animation(?:-name)?\s*:[^;}]*', rename, text)


def build():
    with open(os.path.join(BASE_DIR, 'popup', 'popup.css'), encoding='utf-8') as f:
        popup = scope_css(f.read(), '.pp', 'pp-')
    return f'{BEGIN}\n/* popup/popup.css */\n{popup}\n{END}'


def sync():
    with open(INDEX, encoding='utf-8') as f:
        html = f.read()
    a, b = html.find(BEGIN), html.find(END)
    if a < 0 or b < 0:
        raise SystemExit('Replica CSS markers not found in landing/index.html')
    html = html[:a] + build() + html[b + len(END):]
    with open(INDEX, 'w', encoding='utf-8') as f:
        f.write(html)


if __name__ == '__main__':
    sync()
    print('✅ Synced popup CSS into landing/index.html')
