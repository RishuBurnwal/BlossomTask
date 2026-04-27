import json
from pathlib import Path
from graphify.detect import detect

p = Path('.')
res = detect(p)
Path('.graphify_detect_utf8.json').write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding='utf-8')
print('WROTE .graphify_detect_utf8.json')
