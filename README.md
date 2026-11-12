# webgpu-device-hung-test

**Test your GPU: https://lostbeard.github.io/webgpu-device-hung-test/**

On an NVIDIA RTX 4070 (Windows 11, Chrome, WebGPU on the D3D12 backend), this sequence of plain WebGPU calls always loses the
device with `DXGI_ERROR_DEVICE_HUNG`:

1. a compute kernel that holds **more than 1652 32-bit ints (6608 bytes) of dynamically indexed function-scope arrays per
   thread**,
2. followed by any other dispatch in the same queue submit,
3. then, later and after the GPU has gone idle, a large kernel (which also has function-scope arrays) loses the device.

With 1652 ints instead of 1653 it never happens. With a queue submit right after the kernel from step 1 (no wait) it never
happens. Other GPUs we tried are not affected. This repository holds the test page, so anyone can check their GPU and report
the result.

> On an affected GPU the screen may go black for a moment while Windows resets the display driver, and the browser may turn
> WebGPU off for the tab. Save your work before running the test.

## Results so far

| GPU | Driver | Browser / backend | Result |
|---|---|---|---|
| NVIDIA RTX 4070 (lovelace) | 596.21, 621.14 | Chrome 157 (.52, .78), D3D12 | **affected**: 1653 loses the device; 1652 and 1653 + submit pass |
| NVIDIA RTX 2060 (turing) | 610.88 | Chrome 157 (.50, .78), D3D12 | not affected: control, test and fix pass on the page; the original recording (1656 ints) passes too |
| AMD RX 590 (gcn-4) | 31.0.21925.1001 | Chrome 157 (.51), D3D12 | not affected: control, test and fix pass on the page; the original recording (1656 ints) passes too |

Please [open an issue](https://github.com/LostBeard/webgpu-device-hung-test/issues/new) with your result, affected or not:
the page fills in the report for you. Passing GPUs narrow the problem down as much as failing ones.

## What is known (RTX 4070)

Each line below was measured by replaying the recording with one change; every run was repeated or had a control in the same
session.

- **The threshold is per thread and exact.** 1588 + 64 ints passes, 1589 + 64 loses the device (2 of 2 each); 1620 + 32
  passes, 1621 + 32 loses it. The same edge at `@workgroup_size` 1, 64 and 256. Only the size in step 1 matters; the size in
  the follow-up dispatch does not.
- **Step 2 is required.** The large kernel with nothing dispatched after it in that submit: passes. Any dispatch after it,
  even a trivial one: loses the device.
- **A submit boundary prevents it**, with or without a wait: `finish()` + `submit()` right after the large kernel's pass.
- **Module-scope `var<private>` arrays do not help** (same loss).
- **A long kernel without arrays does not do it** (a 377 ms single-thread loop that touches no memory: passes).
- **Not out-of-range access.** Every storage index of the follow-up kernel (step 2 in the original recording) clamped to its
  buffer: same loss. The same application sequence run with bounds checks in every kernel on a CPU implementation: clean.
- **Not the Chrome version or the driver version.** Chrome 157.0.8103 .52 and .78, NVIDIA 596.21 and 621.14: same loss on the
  4070. The RTX 2060 passes on Chrome .50 and .78.
- **The victim (step 3).** It needs live function-scope arrays: with its 5 large arrays moved to device memory (in the
  application) it passes. How
  it writes its output does not matter (atomicOr + atomicAnd, atomicOr alone, or atomicLoad + atomicStore: all lose the
  device). We have not found a small synthetic kernel that takes its place, so the test uses the real one (27,667 lines of
  WGSL compiled by SpawnDev.ILGPU from a VP9 encoder kernel); smaller candidates we wrote passed, possibly because the
  compiler removed their arrays.

Not known: why the 4070 and not the 2060, and which other GPUs are affected.

## Files

| file | what |
|---|---|
| `index.html` | the test page |
| `replay.js` | replays a trace: reissues every recorded WebGPU call in order on a fresh device and waits on each promise where the original page did |
| `traces/control_1652.jsonl` | step 1 with 1652 ints per thread |
| `traces/test_1653.jsonl` | the same with 1653 ints |
| `traces/fix_1653.jsonl` | 1653 ints plus a submit right after the large kernel |
| `traces/base_synth_1592.jsonl` | the base the three are built from (`tools/build_traces.py`) |
| `traces/original_recording.jsonl` | the original recording: a VP9 decode, then an encode, with the real decoder kernels (ParseKernel holds 1592 + 64 ints). Loses the device on the 4070 at record 828 |
| `tracer.js` | the recorder that wrote the traces (wraps the WebGPU prototypes) |
| `tools/build_traces.py` | builds the three test traces from the base; every edit is asserted |
| `tools/drive.cs` | clicks the page's buttons in a fresh Chrome profile (`dotnet run tools/drive.cs -- <url> control,test,fix`) |

All traces are "portable": `enable f16;` removed (no shader uses f16) and the device is requested with no optional
features and only `maxStorageBuffersPerShaderStage: 10`, so GPUs without `shader-f16` can run them.

## Background

Found in [SpawnDev.Codecs](https://github.com/LostBeard/SpawnDev.Codecs) (VP9 on WebGPU through
[SpawnDev.ILGPU](https://github.com/LostBeard/SpawnDev.ILGPU)), which now keeps the large array of its decoder kernel in
device memory. The recordings run no SpawnDev code: only WebGPU calls.

## License

MIT, see [LICENSE](LICENSE).
