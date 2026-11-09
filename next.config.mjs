/**
 * Security headers, on every route.
 *
 * The app is behind Vercel Authentication, so these are the second layer, and
 * they are written around one fact: the feed API keys live in this browser's
 * storage. The policy that matters most is therefore connect-src and img-src
 * 'self'. Even a script that somehow got onto the page could not send a key
 * anywhere, because the browser may only talk to this origin -- every feed
 * call already goes through this app's own server routes, never from the page.
 *
 * script-src keeps 'unsafe-inline' because the App Router hydrates from inline
 * scripts and these pages are static; a per-request nonce would make every
 * page dynamic and would also have to reach the OCR worker's importScripts,
 * which a nonce cannot. Everything else about scripts is locked to this
 * origin. 'wasm-unsafe-eval' is the OCR engine compiling WebAssembly, and
 * blob: workers are how it starts its worker; both were checked against a
 * real OCR run under this policy. Development additionally allows eval and
 * the hot-reload socket, which production never gets.
 */
const isDev = process.env.NODE_ENV === "development"

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // Nothing may frame the app, so nobody can overlay it to steal clicks.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // The app links out to the feeds' sites; they learn nothing about where from.
  { key: "Referrer-Policy", value: "no-referrer" },
  // Nothing here uses a camera, microphone, location or payments, so none can be asked for.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 16.3 writes AGENTS.md and CLAUDE.md on dev start. CLAUDE.md carries its
  // own meaning for anyone using Claude Code in this repo, so generation is off
  // rather than letting the framework overwrite a hand-written file.
  agentRules: false,
  // Do not announce the framework and version to every visitor.
  poweredByHeader: false,
  images: {
    unoptimized: true,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }]
  },
}

export default nextConfig
