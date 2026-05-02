import json
from pathlib import Path
from collections import Counter

p = Path('.graphify_detect.json')
if not p.exists():
    print('No .graphify_detect.json found')
    raise SystemExit(1)

b = p.read_bytes()
encodings = ['utf-8', 'utf-8-sig', 'utf-16', 'utf-16-le', 'utf-16-be', 'latin1']
d = None
used = None
for e in encodings:
    try:
        s = b.decode(e)
        d = json.loads(s)
        used = e
        break
    except Exception:
        d = None

if d is None:
    print('Failed to decode/parse .graphify_detect.json')
    raise SystemExit(2)

files = d.get('files', {})
total = sum(len(v) for v in files.values())
print(f'Parsed with encoding: {used}')
print(f'Corpus: {total} files')
for k, v in files.items():
    if v:
        print(f'  {k}: {len(v)} files')

print('\nTop directories:')
dirs = [str(Path(f).parent) for v in files.values() for f in v]
c = Counter(dirs)
for pth, cnt in c.most_common(8):
    print(f'  {pth} ({cnt})')
