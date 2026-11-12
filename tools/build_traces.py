# Builds the three test traces from the recorded base trace. Every edit is asserted, so a changed base fails loudly.
#
# Base: a recording (tracer.js) of every WebGPU call one page made: a VP9 decode, then a VP9 encode (SpawnDev.Codecs
# kernels compiled to WGSL by SpawnDev.ILGPU). Two of the decoder's kernels (ParseKernel, IntraWaveKernel) were already
# replaced by small synthetic kernels that loop over two function-scope arrays and touch no memory at run time; the
# encoder kernel that dies later is the real one. The base was then made portable: `enable f16;` removed (no shader uses
# f16) and requestDevice asks for no optional features, only maxStorageBuffersPerShaderStage = 10.
#
# Outputs (traces/):
#   control_1652.jsonl  the two synthetic kernels hold 1588 + 64 = 1652 i32 per thread
#   test_1653.jsonl     the same with 1589 + 64 = 1653 i32 per thread (the only difference: one array element)
#   fix_1653.jsonl      test_1653 plus a queue submit right after the large kernel's compute pass (no wait)
#
# python -I build_traces.py <base.jsonl> <out folder>
import json, os, sys

base, out = sys.argv[1], sys.argv[2]
lines = [l for l in open(base, encoding='utf-8') if l.strip()]


def load():
    return [json.loads(l) for l in lines]


def size(recs, big, small=64):
    hits = 0
    for r in recs:
        if r['op'] == 'shader' and '(SYNTHETIC SPIN + PRIVATE ARRAYS' in r['code']:
            c = r['code']
            assert c.count('array<i32, 1592>') == 1 and c.count('% 1592u') == 3
            assert c.count('array<i32, 64>') == 1 and c.count('& 63u') == 3
            c = c.replace('array<i32, 1592>', f'array<i32, {big}>').replace('% 1592u', f'% {big}u')
            c = c.replace('array<i32, 64>', f'array<i32, {small}>').replace('& 63u', f'& {small - 1}u')
            r['code'] = c
            hits += 1
    assert hits == 2, hits  # ParseKernel (1.5M iterations) and IntraWaveKernel (1000 iterations)
    return recs


def submit_boundary(recs):
    # finish + submit the command encoder right after the large kernel's compute pass (record 545) and open a new
    # encoder for the rest of that step. 3 records are inserted, so every later index moves up by 3.
    recs.sort(key=lambda r: r['i'])
    at = next(r for r in recs if r['i'] == 545)
    assert at['op'] == 'GPUComputePassEncoder.end', at['op']
    assert next(r for r in recs if r['i'] == 544)['op'] == 'GPUComputePassEncoder.dispatchWorkgroups'
    begin = next(r for r in recs if r['op'] == 'GPUCommandEncoder.beginComputePass' and r['ret'] == at['self'])
    enc = begin['self']
    queue = next(r for r in recs if r['i'] > 545 and r['op'] == 'GPUQueue.submit')['self']
    device = next(r for r in recs if r['op'] == 'GPUDevice.createCommandEncoder' and r['ret'] == enc)['self']
    ids = [r[k] for r in recs for k in ('ret', 'self') if isinstance(r.get(k), int)]
    new_enc, new_buf = max(ids) + 1000, max(ids) + 1001
    for r in recs:
        if r['i'] > 545:
            if r.get('self') == enc:
                r['self'] = new_enc
            r['i'] += 3
        if r['op'] == 'resolved' and r.get('of', -1) > 545:
            r['of'] += 3
    t = at.get('t', 0)
    recs += [
        {'op': 'GPUCommandEncoder.finish', 'self': enc, 'args': [], 'ret': new_buf, 'i': 546, 't': t},
        {'op': 'GPUQueue.submit', 'self': queue, 'args': [[{'$': new_buf}]], 'i': 547, 't': t},
        {'op': 'GPUDevice.createCommandEncoder', 'self': device, 'args': [], 'ret': new_enc, 'i': 548, 't': t},
    ]
    recs.sort(key=lambda r: r['i'])
    assert [r['i'] for r in recs] == list(range(len(recs)))
    assert not any(r['i'] > 548 and json.dumps(r.get('args', '')).find('{"$": %d}' % enc) >= 0 for r in recs)
    return recs


def write(name, recs):
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, name), 'w', encoding='utf-8', newline='\n') as f:
        for r in recs:
            f.write(json.dumps(r) + '\n')
    print(name, len(recs), 'records')


write('control_1652.jsonl', size(load(), 1588))
write('test_1653.jsonl', size(load(), 1589))
write('fix_1653.jsonl', submit_boundary(size(load(), 1589)))
