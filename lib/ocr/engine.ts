"use client"

import { tagBoosts, type Pixels } from "./boost"
import { tagOutcomes } from "./ring"
import type { OcrLine } from "./extract"

/**
 * Browser OCR via Tesseract.
 *
 * The worker, the WebAssembly core and the English language data are all served
 * from this app rather than a CDN, so screenshot reading works with no network
 * and nothing about your board leaves the machine.
 */

export interface OcrProgress {
  status: string
  progress: number
}

export interface OcrOutput {
  /** The screenshot read as-is. Best for large, clean text. */
  lines: OcrLine[]
  /** The same screenshot read after cleanup. Best for small values beside icons. */
  cleanedLines: OcrLine[]
  text: string
  meanConfidence: number
}

let workerPromise: Promise<unknown> | null = null

/**
 * Page segmentation mode, and the single most important setting in this file.
 *
 * tesseract.js defaults to SINGLE_BLOCK (6), unlike the Tesseract CLI, which
 * defaults to AUTO (3). SINGLE_BLOCK assumes one column of evenly sized text,
 * and a pick'em board is neither:
 *
 *   - PrizePicks lays cards out in a two-column grid. SINGLE_BLOCK reads straight
 *     across both, so "LeBron James" and "Stephen Curry" come out as one
 *     four-word line that is neither name.
 *   - The line value is the largest text on the card, around three times the
 *     size of everything else. SINGLE_BLOCK treats it as noise and drops it, so
 *     no prop can be formed at all, whatever the parser does afterwards.
 *
 * AUTO runs Tesseract's own layout analysis. It finds each card as its own
 * block and emits one card at a time, left column then right, with the line
 * value intact. Measured on a rendered two-column board: SINGLE_BLOCK gave 11
 * lines and zero line values; AUTO gave 25 lines and all four.
 *
 * SPARSE_TEXT (11) also recovers every value but interleaves the columns,
 * which pairs the wrong name with the wrong line. Do not use it here.
 */
export const PAGE_SEG_MODE = "3" // PSM.AUTO

async function getWorker(onProgress?: (p: OcrProgress) => void) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import("tesseract.js")
      const worker = await createWorker("eng", 1, {
        workerPath: "/tesseract/worker.min.js",
        corePath: "/tesseract/",
        langPath: "/tesseract",
        gzip: true,
        logger: (m: OcrProgress) => onProgress?.(m),
      })
      await worker.setParameters({ tessedit_pageseg_mode: PAGE_SEG_MODE as never })
      return worker
    })()
    // A failed start must not be cached, or every later attempt reuses the
    // rejection and the only fix is reloading the page.
    workerPromise.catch(() => {
      workerPromise = null
    })
  }
  return workerPromise
}

interface RecognizeLine {
  text: string
  confidence: number
  bbox?: { x0: number; y0: number; x1: number; y1: number }
}

/**
 * Clean a screenshot up before OCR.
 *
 * Measured on a real PrizePicks lineup screenshot: read as-is, every line value
 * came back as junk ("O15", "805", "@tT05") and "3PTM" as "Pub". Upscaled,
 * greyscaled, inverted and thresholded, the stats read cleanly and the values
 * come back in a consistent, repairable form ("T15", "T05").
 *
 *   Upscale: the decimal point in "1.5" is a few pixels on a phone screenshot
 *     and OCR drops it. Capped at 12M pixels, under iOS Safari's canvas limit.
 *   Invert: every one of these apps is dark mode; Tesseract is trained on dark
 *     text on light paper.
 *   Threshold: removes the grey card backgrounds and gradient buttons that
 *     otherwise read as stray characters.
 */
export const PREP = { targetWidth: 2700, maxScale: 3, maxPixels: 12_000_000, threshold: 150 }

async function prepare(file: File | Blob): Promise<HTMLCanvasElement | File | Blob> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return file
  try {
    const bmp = await createImageBitmap(file)
    const w = bmp.width
    const h = bmp.height
    const scale = Math.max(1, Math.min(PREP.maxScale, PREP.targetWidth / w, Math.sqrt(PREP.maxPixels / (w * h))))
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return file
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close?.()
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const px = img.data
    let sum = 0
    for (let i = 0; i < px.length; i += 4) {
      const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
      px[i] = y
      sum += y
    }
    const invert = sum / (px.length / 4) < 128
    for (let i = 0; i < px.length; i += 4) {
      const y = invert ? 255 - px[i] : px[i]
      const v = y < PREP.threshold ? 0 : 255
      px[i] = px[i + 1] = px[i + 2] = v
      px[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    return canvas
  } catch {
    // Anything the browser cannot decode or draw goes to OCR untouched.
    return file
  }
}

/**
 * Read one image. Screenshots of dense mobile boards are the hard case, so the
 * page segmentation mode is left on automatic and the results are always sent to
 * a human for review rather than used directly.
 */
export async function readImage(file: File | Blob, onProgress?: (p: OcrProgress) => void): Promise<OcrOutput> {
  const worker = (await getWorker(onProgress)) as unknown as Recognizer
  const raw = await recognizeLines(worker, file)
  const prepared = await prepare(file)
  const cleaned = prepared === file ? { lines: [], text: "" } : await recognizeLines(worker, prepared)
  const meanConfidence =
    raw.lines.length > 0 ? raw.lines.reduce((a, l) => a + (l.confidence ?? 0), 0) / raw.lines.length : 0
  // Goblins and demons are only visible in colour, so look for them in the
  // original pixels. The cleaned read ran on an upscaled copy: scale back.
  const px = await pixelsOf(file)
  if (!px) return { lines: raw.lines, cleanedLines: cleaned.lines, text: raw.text, meanConfidence }
  const scale = prepared instanceof HTMLCanvasElement ? prepared.width / px.width : 1
  // The ring round each player's picture says whether the leg hit; see ring.ts.
  return {
    lines: tagOutcomes(tagBoosts(raw.lines, px), px),
    cleanedLines: tagOutcomes(tagBoosts(cleaned.lines, px, scale), px, scale),
    text: raw.text,
    meanConfidence,
  }
}

async function pixelsOf(file: File | Blob): Promise<Pixels | null> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return null
  try {
    const bmp = await createImageBitmap(file)
    const canvas = document.createElement("canvas")
    canvas.width = bmp.width
    canvas.height = bmp.height
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(bmp, 0, 0)
    bmp.close?.()
    return ctx.getImageData(0, 0, canvas.width, canvas.height)
  } catch {
    // No colour, no boost: every leg reads as a standard pick for the user to correct.
    return null
  }
}

type Recognizer = {
  recognize: (
    image: File | Blob | HTMLCanvasElement,
    options: Record<string, unknown>,
    output: Record<string, boolean>,
  ) => Promise<{
    data: {
      text: string
      lines?: RecognizeLine[]
      blocks?: { paragraphs?: { lines?: RecognizeLine[] }[] }[] | null
      confidence?: number
    }
  }>
}

async function recognizeLines(
  worker: Recognizer,
  image: File | Blob | HTMLCanvasElement,
): Promise<{ lines: OcrLine[]; text: string }> {
  const { data } = await worker.recognize(image, {}, { blocks: true, text: true })

  // Walk blocks -> paragraphs -> lines explicitly. Under AUTO segmentation each
  // card is its own block, and block order is what keeps a card's name, line
  // value and stat together, so the order here matters.
  const fromBlocks: OcrLine[] = []
  for (const b of data.blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        const text = (l.text ?? "").trim()
        // Keep the position. It is what lets the parser pair a value with the
        // name beside it rather than whichever name happened to be read last.
        if (text) fromBlocks.push({ text, confidence: l.confidence, bbox: l.bbox })
      }
    }
  }
  const lines: OcrLine[] =
    fromBlocks.length > 0
      ? fromBlocks
      : (data.lines ?? [])
          .map((l) => ({ text: (l.text ?? "").trim(), confidence: l.confidence }))
          .filter((l) => l.text.length > 0)

  // Fall back to splitting the flat text if the engine gave no line structure.
  const finalLines =
    lines.length > 0
      ? lines
      : (data.text ?? "")
          .split(/\r?\n/)
          .map((t) => ({ text: t.trim(), confidence: data.confidence }))
          .filter((l) => l.text.length > 0)

  return { lines: finalLines, text: data.text ?? "" }
}

/** Release the worker. Called when the capture screen unmounts. */
export async function disposeOcr(): Promise<void> {
  if (!workerPromise) return
  const worker = (await workerPromise) as { terminate: () => Promise<void> }
  await worker.terminate()
  workerPromise = null
}
