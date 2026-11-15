"""Register Codex sessions, or collect their final cumulative usage (never sum token events)."""
import json
import os
import sys
from pathlib import Path

command, run_arg = sys.argv[1:3]
root = Path(run_arg).resolve()
registry = root / 'sessions'
if command == 'register':
    registry.mkdir(exist_ok=True)
    session_id = os.environ['CODEX_THREAD_ID']
    record = {'session_id': session_id, 'role': sys.argv[3] if len(sys.argv) > 3 else 'agent'}
    (registry / f'{session_id}.json').write_text(json.dumps(record) + '\n')
    print(json.dumps(record))
elif command == 'collect':
    records = []
    for marker in sorted(registry.glob('*.json')):
        record = json.loads(marker.read_text())
        paths = list((Path.home() / '.codex/sessions').rglob(f"*{record['session_id']}*.jsonl"))
        if len(paths) != 1:
            raise RuntimeError(f'Expected one session log for {record}, found {len(paths)}')
        usage, peak, counts, tools, seen, model = None, 0, 0, 0, set(), None
        for line in paths[0].open():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue  # A live final line may still be flushing; collect after completion.
            payload = event.get('payload', {})
            if event.get('type') == 'turn_context':
                model = payload.get('model', model)
            if event.get('type') == 'response_item' and payload.get('type') in ('function_call', 'custom_tool_call'):
                tools += 1
            if event.get('type') == 'event_msg' and payload.get('type') == 'token_count' and payload.get('info'):
                info = payload['info']
                usage = info['total_token_usage']
                peak = max(peak, info.get('last_token_usage', {}).get('input_tokens', 0))
                signature = json.dumps(usage, sort_keys=True)
                if signature not in seen:
                    seen.add(signature)
                    counts += 1
        if usage is None:
            raise RuntimeError(f'No usage found for {paths[0]}')
        records.append({**record, 'model': model, 'log': str(paths[0]), 'usage': usage,
                        'uncached_input_tokens': usage['input_tokens'] - usage.get('cached_input_tokens', 0),
                        'peak_request_input_tokens': peak, 'usage_updates': counts, 'tool_calls': tools})
    if not records:
        raise RuntimeError('No registered sessions')
    totals = {k: sum(r['usage'].get(k, 0) for r in records) for k in records[0]['usage']}
    result = {'sessions': records, 'totals': totals,
              'uncached_input_tokens': sum(r['uncached_input_tokens'] for r in records),
              'peak_request_input_tokens': max(r['peak_request_input_tokens'] for r in records),
              'usage_updates': sum(r['usage_updates'] for r in records),
              'tool_calls': sum(r['tool_calls'] for r in records)}
    (root / 'usage.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
else:
    raise SystemExit('Usage: usage.py register|collect RUN_DIRECTORY [ROLE]')
