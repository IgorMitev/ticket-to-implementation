"""Compare two completed run usage.json files; emit machine-readable deltas and a chart."""
import html
import json
import sys
from pathlib import Path

baseline, candidate, destination = map(Path, sys.argv[1:4])
a, b = (json.loads((p / 'usage.json').read_text()) for p in (baseline, candidate))
metrics = {
    'Cumulative input': lambda x: x['totals']['input_tokens'],
    'Cached input (included above)': lambda x: x['totals']['cached_input_tokens'],
    'Uncached input': lambda x: x['uncached_input_tokens'],
    'Output': lambda x: x['totals']['output_tokens'],
    'Total tokens': lambda x: x['totals']['total_tokens'],
    'Peak request input': lambda x: x['peak_request_input_tokens'],
    'Top-level tool calls': lambda x: x['tool_calls'],
}
rows = []
for label, metric in metrics.items():
    x, y = metric(a), metric(b)
    rows.append({'metric': label, 'main': x, 'candidate': y, 'change_percent': (y / x - 1) * 100 if x else None})
destination.mkdir(exist_ok=True)
(destination / 'comparison.json').write_text(json.dumps(rows, indent=2) + '\n')
lines = ['| Metric | Main | Candidate | Change |', '|---|---:|---:|---:|']
for row in rows:
    change = f"{row['change_percent']:+.1f}%" if row['change_percent'] is not None else 'N/A'
    lines.append(f"| {row['metric']} | {row['main']:,} | {row['candidate']:,} | {change} |")
(destination / 'metrics.md').write_text('\n'.join(lines) + '\n')
chart = '''<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:var(--font-sans);color:var(--foreground);margin:0}section{margin:16px 0}h3{font-size:15px;margin:0 0 8px}.row{display:flex;align-items:center;gap:8px;margin:5px 0}.label{width:72px;font-size:13px}.track{flex:1;height:22px}.bar{height:100%;border-radius:4px;background:var(--chart-1)}.candidate{background:var(--chart-2)}.value{width:100px;text-align:right;font-variant-numeric:tabular-nums;font-size:13px}p{font-size:13px;color:var(--muted-foreground)}
</style></head><body><p>One paired Luna trial · main agent + implementor · lower is better</p>'''
for row in rows:
    if row['metric'] not in ('Cumulative input', 'Uncached input', 'Output', 'Peak request input'): continue
    maximum = max(row['main'], row['candidate'], 1)
    chart += f"<section><h3>{html.escape(row['metric'])}</h3>"
    for key, label in [('main', 'Main'), ('candidate', 'Candidate')]:
        chart += f'<div class="row"><span class="label">{label}</span><div class="track"><div class="bar {key}" style="width:{row[key]/maximum*100:.2f}%"></div></div><span class="value">{row[key]:,}</span></div>'
    chart += '</section>'
chart += '<p>Cached input is included in cumulative input. Peak is the largest request across either agent, not a sum. One pair does not establish repeatable savings or dollar cost.</p></body></html>'
(destination / 'comparison.html').write_text(chart)
print('\n'.join(lines))
