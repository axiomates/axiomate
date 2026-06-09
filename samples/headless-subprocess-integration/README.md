# Headless Subprocess Integration

This sample shows how to use Axiomate as an external headless worker instead of importing it as an SDK.

The sample program:

- reads a JSON file describing either two image lists or two directories
- pairs images by array order or by same filename in two directories
- computes a local pixel similarity score with `sharp`
- calls Axiomate in `--print` mode for a VL comparison
- merges the two signals into a JSON report

## What This Is Called

This integration style is:

- `headless-subprocess-integration`
- `CLI + stdin/stdout protocol integration`
- `out-of-process agent invocation`

It is not an SDK import.

## Prerequisites

- Install dependencies for this sample project.
- Have `axiomate` available on your `PATH`, or pass `--axiomate-bin`.
- Configure your model keys in `~/.axiomate.json`.
- Ensure the remote VL and OCR services you reference support image input.

Example model key usage:

- `visionModel`: a vision-capable key from `models` in `~/.axiomate.json`.
  The bundled examples use `Pro/moonshotai/Kimi-K2.6`; either configure a
  `models["Pro/moonshotai/Kimi-K2.6"]` entry, or replace the example value
  with your own configured model key.

## Copy Elsewhere

This sample is intentionally self-contained. You can copy the whole
`headless-subprocess-integration` folder anywhere else and run it as a normal
Node/TypeScript project.

## Install

From inside the sample folder:

```powershell
pnpm install
```

## Compile

```powershell
pnpm run build
```

## Run

```powershell
pnpm run start -- --input input.example.json
```

You can also point the sample at either dedicated example file:

- [input.array.example.json](./input.array.example.json)

If your Axiomate binary is not at the default path, pass one of:

```powershell
pnpm run start -- --input <input.json> --axiomate-bin C:\path\to\axiomate.exe
```

or:

```powershell
$env:AXIOMATE_BIN="C:\path\to\axiomate.exe"
pnpm run start -- --input <input.json>
```

## Input Shape

Mode 1: explicit arrays

```json
{
  "left": ["C:/imgs/left/a.png", "C:/imgs/left/b.png"],
  "right": ["C:/imgs/right/a.png", "C:/imgs/right/b.png"],
  "visionModel": "Pro/moonshotai/Kimi-K2.6",
  "visionImageScaleFactor": 0.5,
  "pixelCompareScaleFactor": 0.5,
  "outputPath": "./report.json"
}
```

Mode 2: directories

```json
{
  "leftDir": "C:/imgs/left",
  "rightDir": "C:/imgs/right",
  "visionModel": "Pro/moonshotai/Kimi-K2.6",
  "visionImageScaleFactor": 0.5,
  "pixelCompareScaleFactor": 0.5,
  "outputPath": "./report.json"
}
```

The example input file uses placeholder image paths. Replace them with real files before running the sample.

Sample input files:

- [input.example.json](./input.example.json) - default directory-mode example
- [input.array.example.json](./input.array.example.json) - explicit array mode

## Output

The report includes:

- local pixel metrics
- VL verdict and confidence
- final fused probability and label
- per-source errors when one comparison path fails
- a human-readable `report.html` generated alongside `report.json`

See the example output file here:

- [report.example.json](./report.example.json)

When the sample runs, it writes both:

- `report.json`
- `report.html`

`report.html` is self-contained. You can double-click it and view the report directly from the filesystem without hosting it anywhere.
For easier review, the HTML view sorts pairs by `sameProbability` ascending so the most suspicious results appear first.

## Notes

- The sample uses Axiomate's headless `stream-json` protocol for VL only.
- `visionImageScaleFactor` scales images before sending them to VL, preserving original aspect ratio.
- `pixelCompareScaleFactor` scales images for local pixel comparison, preserving original aspect ratio and remaining independent from the VL image scale factor.
- If local pixel comparison proves the images are identical (`fileHashEqual` or `exactPixelMatch`), that result overrides VL/OCR confidence and the final probability becomes `1`.
- Final labels use these thresholds:
  - `same` when `sameProbability >= 0.85`
  - `uncertain` when `0.4 < sameProbability < 0.85`
  - `different` otherwise
- Array mode: `left` and `right` must have the same length. The sample compares `left[0]` to `right[0]`, `left[1]` to `right[1]`, and so on.
- Directory mode: the sample pairs files by exact same filename in `leftDir` and `rightDir`.
- If `pixelCompareScaleFactor` is omitted, the sample compares at original image dimensions when both images have the same size. If dimensions differ, it falls back to the smallest common width and height.
- Both the local pixel path and the model-input path always derive from the original image bytes, so there is no repeated resize-on-resize drift inside one run.
- Source failures are soft by default: if `pixel` or `vl` fails for a pair, the sample records the error in the report and continues with the remaining sources and pairs.
- If `axiomate` is on your `PATH`, no repository-relative binary path is needed.
