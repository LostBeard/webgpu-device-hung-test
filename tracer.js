// WebGPU call-trace RECORDER. Injected before any page script (Playwright AddInitScript / CDP
// Page.addScriptToEvaluateOnNewDocument). Wraps the WebGPU prototypes so every call the page makes is recorded IN ORDER:
//   {i, t, op, self, args, ret}        a call: self/ret are object ids, GPU objects inside args become {$:id}
//   {i, t, op: 'resolved', of, ret}    the promise returned by call `of` settled (ret = resulting object id, if any)
// writeBuffer data and mapped-for-write ranges ride as base64; shader code is sent once per distinct source (by hash).
// Records stream to the trace server (POST, text/plain = no CORS preflight). Change TRACE_URL below or set
// globalThis.__wgtraceUrl before this script runs. Nothing about the page's behavior changes: every wrapper calls the
// original and returns its result.
(() => {
    if (globalThis.__wgtraceInstalled || typeof GPUDevice === 'undefined') return;
    globalThis.__wgtraceInstalled = true;
    const TRACE_URL = globalThis.__wgtraceUrl || 'http://127.0.0.1:8793/trace';
    const ids = new WeakMap();
    let nextId = 1, seq = 0;
    const idOf = o => { if (o == null || (typeof o !== 'object' && typeof o !== 'function')) return 0; let v = ids.get(o); if (!v) { v = nextId++; ids.set(o, v); } return v; };
    const isGpu = o => o && typeof o === 'object' && /^GPU/.test(o.constructor?.name || '') && !(o instanceof Promise);
    const b64 = u8 => { let s = ''; for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000)); return btoa(s); };
    const bytesOf = (data, off, size) => {
        // writeBuffer(buffer, bufferOffset, data, dataOffset, size): dataOffset/size are in ELEMENTS of a TypedArray, bytes of an ArrayBuffer
        let u8, bpe = 1;
        if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer)) u8 = new Uint8Array(data);
        else { bpe = data.BYTES_PER_ELEMENT || 1; u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength); }
        const start = (off || 0) * bpe;
        const len = size === undefined ? u8.length - start : size * bpe;
        return u8.slice(start, start + len);
    };
    const shaders = new Set();
    const hash = s => { let h = 2166136261; for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16) + '_' + s.length; };
    // serialize descriptor arguments: GPU objects -> {$:id}, typed arrays -> {$bytes}, shader code -> {$code: hash}
    const ser = (v, depth = 0) => {
        if (v == null || typeof v !== 'object') return v;
        if (isGpu(v)) return { $: idOf(v) };
        if (ArrayBuffer.isView(v)) return { $bytes: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
        if (v instanceof ArrayBuffer) return { $bytes: b64(new Uint8Array(v)) };
        if (depth > 8) return null;
        if (Array.isArray(v)) return v.map(x => ser(x, depth + 1));
        const o = {};
        for (const k in v) {
            const x = v[k];
            if (typeof x === 'function') continue;
            if (k === 'code' && typeof x === 'string') { const h = hash(x); if (!shaders.has(h)) { shaders.add(h); push({ op: 'shader', hash: h, code: x }); } o.code = { $code: h }; continue; }
            o[k] = ser(x, depth + 1);
        }
        return o;
    };
    let buf = [], bytes = 0, timer = null, posting = Promise.resolve();
    const flush = () => {
        timer = null;
        if (!buf.length) return;
        const body = buf.map(r => JSON.stringify(r)).join('\n') + '\n';
        buf = []; bytes = 0;
        posting = posting.then(() => fetch(TRACE_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body }).catch(() => {}));
    };
    const push = r => {
        r.i = seq++; r.t = Math.round(performance.now() * 10) / 10;
        buf.push(r); bytes += 64 + (r.code ? r.code.length : 0) + (r.data ? r.data.length : 0);
        if (bytes > 4e6) flush(); else if (!timer) timer = setTimeout(flush, 100);
    };
    globalThis.__wgtraceFlush = () => { flush(); return posting; };
    globalThis.__wgtraceMark = what => push({ op: 'mark', what: String(what) });
    // mapped ranges handed out for WRITE, captured at unmap
    const writeRanges = new WeakMap();
    const wrap = (proto, name, special) => {
        const orig = proto?.[name];
        if (typeof orig !== 'function') return;
        proto[name] = function (...args) {
            const rec = { op: (proto.constructor?.name || '?') + '.' + name, self: idOf(this) };
            if (special?.pre) special.pre.call(this, rec, args);
            else rec.args = args.map(a => ser(a));
            let ret;
            try { ret = orig.apply(this, args); }
            catch (e) { rec.threw = String(e?.message || e).slice(0, 200); push(rec); throw e; }
            if (ret instanceof Promise) {
                rec.async = 1; push(rec);
                const of = rec.i;
                ret.then(v => push({ op: 'resolved', of, ret: isGpu(v) ? idOf(v) : 0, ok: 1 }),
                         e => push({ op: 'resolved', of, ok: 0, err: String(e?.message || e).slice(0, 200) }));
            } else {
                if (isGpu(ret)) rec.ret = idOf(ret);
                if (special?.post) special.post.call(this, rec, args, ret);
                push(rec);
            }
            return ret;
        };
    };
    wrap(GPU.prototype, 'requestAdapter');
    wrap(GPUAdapter.prototype, 'requestDevice');
    for (const m of ['createBuffer', 'createShaderModule', 'createComputePipeline', 'createComputePipelineAsync', 'createBindGroup',
        'createBindGroupLayout', 'createPipelineLayout', 'createCommandEncoder', 'createQuerySet', 'createTexture', 'createSampler',
        'pushErrorScope', 'popErrorScope', 'destroy'])
        wrap(GPUDevice.prototype, m);
    wrap(GPUQueue.prototype, 'submit');
    wrap(GPUQueue.prototype, 'onSubmittedWorkDone');
    wrap(GPUQueue.prototype, 'writeBuffer', {
        pre(rec, [buffer, bufferOffset, data, dataOffset, size]) {
            const u8 = bytesOf(data, dataOffset, size);
            rec.args = [{ $: idOf(buffer) }, bufferOffset];
            rec.data = b64(u8);
        }
    });
    for (const m of ['beginComputePass', 'copyBufferToBuffer', 'clearBuffer', 'finish', 'resolveQuerySet', 'writeTimestamp'])
        wrap(GPUCommandEncoder.prototype, m);
    for (const m of ['setPipeline', 'setBindGroup', 'dispatchWorkgroups', 'dispatchWorkgroupsIndirect', 'end'])
        wrap(GPUComputePassEncoder.prototype, m);
    wrap(GPUComputePipeline.prototype, 'getBindGroupLayout');
    wrap(GPUShaderModule.prototype, 'getCompilationInfo');
    wrap(GPUBuffer.prototype, 'mapAsync', { pre(rec, args) { rec.args = args; this.__wgMode = args[0]; } });
    wrap(GPUBuffer.prototype, 'getMappedRange', {
        pre(rec, args) { rec.args = args; },
        post(rec, args, ret) {
            // GPUMapMode.WRITE = 2; mappedAtCreation buffers have no mode and are writable. READ ranges are kept too:
            // their content hash at unmap is the replay's fidelity check.
            let l = writeRanges.get(this); if (!l) writeRanges.set(this, l = []);
            l.push({ off: args[0] || 0, ab: ret, write: this.__wgMode === undefined || (this.__wgMode & 2) });
        }
    });
    const fnv = u8 => { let h = 2166136261; for (let k = 0; k < u8.length; k++) { h ^= u8[k]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16) + '_' + u8.length; };
    wrap(GPUBuffer.prototype, 'unmap', {
        pre(rec) {
            const l = writeRanges.get(this);
            if (l) {
                const w = l.filter(x => x.write), r = l.filter(x => !x.write);
                if (w.length) rec.writes = w.map(x => ({ off: x.off, data: b64(new Uint8Array(x.ab)) }));
                if (r.length) rec.reads = r.map(x => ({ off: x.off, hash: fnv(new Uint8Array(x.ab)) }));
                writeRanges.delete(this);
            }
            this.__wgMode = undefined;
        }
    });
    wrap(GPUBuffer.prototype, 'destroy');
    // device.lost: record when it fires (the hang point)
    const origReqDev = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = function (...a) {
        const p = origReqDev.apply(this, a);
        p.then(d => push({ op: 'queue', device: idOf(d), queue: idOf(d.queue) }));
        p.then(d => d.lost.then(info => { push({ op: 'lost', self: idOf(d), reason: info.reason, message: String(info.message).slice(0, 300) }); flush(); }));
        return p;
    };
    // buffers created mappedAtCreation are writable until unmap
    const origCreateBuffer = GPUDevice.prototype.createBuffer;
    GPUDevice.prototype.createBuffer = function (desc) { const b = origCreateBuffer.call(this, desc); if (desc?.mappedAtCreation) b.__wgMode = undefined; else b.__wgMode = 0; return b; };
    push({ op: 'start', href: String(location.href), ua: navigator.userAgent });
})();
