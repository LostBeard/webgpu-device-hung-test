// WebGPU call-trace REPLAYER for traces written by tracer.js. Reissues every recorded call in record order on a fresh
// device in THIS page (no ILGPU, no .NET), awaiting each promise only where the original page saw it settle, so the
// queue depth and the CPU/GPU interleaving follow the original run. Optional pacing (pace: true) also waits out the
// original CPU-side gaps between calls.
// window.__replay = { at, of, done, lost, errors[], lastOp, marks[] } is updated as it goes (the driver polls it: a hang
// leaves `at` stuck and `lost` set).
// Usage: replayTrace(url, { pace, upTo, skip: Set of record indices to drop, powerPreference })
window.__replay = { at: -1, of: 0, done: false, lost: '', errors: [], lastOp: '', marks: [] };
async function replayTrace(url, opt = {}) {
    const R = window.__replay = { at: -1, of: 0, done: false, lost: '', errors: [], lastOp: '', marks: [] };
    const text = await (await fetch(url, { cache: 'no-store' })).text();
    const recs = [];
    for (const line of text.split('\n')) if (line) recs.push(JSON.parse(line));
    recs.sort((a, b) => a.i - b.i);
    const shaders = new Map();
    for (const r of recs) if (r.op === 'shader') shaders.set(r.hash, r.code);
    const objs = new Map(), pending = new Map(), ranges = new Map(), queueOf = new Map();
    const fnv = u8 => { let h = 2166136261; for (let k = 0; k < u8.length; k++) { h ^= u8[k]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16) + '_' + u8.length; };
    const unb64 = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k); return u; };
    const de = v => {
        if (v == null || typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(de);
        if ('$' in v && Object.keys(v).length === 1) { const o = objs.get(v.$); if (o === undefined) throw new Error('unknown object ' + v.$); return o; }
        if ('$bytes' in v) return unb64(v.$bytes);
        if ('$code' in v) return shaders.get(v.$code);
        const o = {};
        for (const k in v) o[k] = (k === 'code' && v[k] && v[k].$code) ? shaders.get(v[k].$code) : de(v[k]);
        return o;
    };
    R.of = recs.length;
    const t0 = performance.now(), rt0 = recs.length ? recs[0].t : 0;
    for (let n = 0; n < recs.length; n++) {
        const r = recs[n];
        if (opt.upTo !== undefined && r.i > opt.upTo) break;
        R.at = r.i; R.lastOp = r.op;
        if (R.lost) break;
        if (opt.skip && opt.skip.has(r.i)) continue;
        if (opt.pace) { const wait = (r.t - rt0) - (performance.now() - t0); if (wait > 1) await new Promise(f => setTimeout(f, wait)); }
        try {
            switch (r.op) {
                case 'start': case 'shader': continue;
                case 'mark': R.marks.push(r.i + ' ' + r.what); continue;
                case 'lost': R.marks.push(r.i + ' ORIGINAL device lost here: ' + r.reason + ' ' + r.message); continue;
                case 'queue': { const d = objs.get(r.device); if (d) { objs.set(r.queue, d.queue); queueOf.set(r.device, r.queue); } continue; }
                case 'resolved': {
                    const p = pending.get(r.of);
                    if (!p) continue;
                    pending.delete(r.of);
                    let v;
                    try { v = await p; } catch (e) { if (r.ok) R.errors.push(r.i + ' resolved rejected: ' + String(e?.message || e).slice(0, 160)); continue; }
                    if (r.ret && v && typeof v === 'object') {
                        objs.set(r.ret, v);
                        if (v instanceof GPUDevice) {
                            v.lost.then(info => { R.lost = info.reason + ' ' + String(info.message).slice(0, 200) + ' at record ' + R.at; });
                            v.onuncapturederror = e => { if (R.errors.length < 200) R.errors.push(R.at + ' uncaptured: ' + e.error.message.split('\n')[0].slice(0, 200)); };
                        }
                    }
                    continue;
                }
            }
            const dot = r.op.indexOf('.'), cls = r.op.slice(0, dot), meth = r.op.slice(dot + 1);
            let self = cls === 'GPU' ? navigator.gpu : objs.get(r.self);
            if (cls === 'GPU' && r.self) objs.set(r.self, navigator.gpu);
            if (self === undefined) { R.errors.push(r.i + ' ' + r.op + ': unknown self ' + r.self); continue; }
            let ret;
            if (meth === 'writeBuffer' && cls === 'GPUQueue') {
                ret = self.writeBuffer(objs.get(r.args[0].$), r.args[1], unb64(r.data));
            } else if (meth === 'unmap') {
                const list = ranges.get(r.self) || [];
                if (r.writes) for (const w of r.writes) {
                    const hit = list.find(x => x.off === w.off);
                    const ab = hit ? hit.ab : self.getMappedRange(w.off);
                    new Uint8Array(ab).set(unb64(w.data));
                }
                // fidelity: what the replay read back must hash to what the original page read back
                if (r.reads) for (const x of r.reads) {
                    const hit = list.find(y => y.off === x.off);
                    if (!hit) continue;
                    R.reads = (R.reads || 0) + 1;
                    if (fnv(new Uint8Array(hit.ab)) !== x.hash) { R.readMismatches = (R.readMismatches || 0) + 1; if ((R.mismatchAt || []).length < 20) (R.mismatchAt = R.mismatchAt || []).push(r.i); }
                }
                ranges.delete(r.self);
                ret = self.unmap();
            } else {
                let args = (r.args || []).map(de);
                // the page lets the tester pick the GPU on a multi-GPU machine (high-performance / low-power)
                if (cls === 'GPU' && meth === 'requestAdapter' && opt.powerPreference) args = [{ powerPreference: opt.powerPreference }];
                if (cls === 'GPU' && meth === 'requestAdapter') { const a = await self[meth](...args); R.adapter = a; ret = Promise.resolve(a); }
                else ret = self[meth](...args);
                if (meth === 'getMappedRange') { let l = ranges.get(r.self); if (!l) ranges.set(r.self, l = []); l.push({ off: r.args?.[0] || 0, ab: ret }); }
            }
            if (ret instanceof Promise) { pending.set(r.i, ret); ret.catch(() => {}); }
            else if (r.ret && ret && typeof ret === 'object') objs.set(r.ret, ret);
        } catch (e) {
            if (R.errors.length < 200) R.errors.push(r.i + ' ' + r.op + ' threw: ' + String(e?.message || e).slice(0, 200));
        }
    }
    // let the last submits finish (or the device die) before reporting
    for (const [, d] of objs) if (d instanceof GPUDevice) { try { await Promise.race([d.queue.onSubmittedWorkDone(), new Promise(f => setTimeout(f, 20000))]); } catch { } }
    R.done = true;
    return R;
}
