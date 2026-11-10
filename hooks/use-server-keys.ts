import * as React from "react"
import { NO_SERVER_KEYS, parseServerKeys, type ServerKeys } from "@/lib/odds-feed/keys"

/**
 * Which feed keys the server holds in its own environment, as /api/keys
 * reports them: booleans, never a key.
 *
 * The routes use an environment key before any key from Settings, so two
 * screens need to know one is there. Today enables its button on an install
 * set up only through .env.local, and Settings says when the key typed into it
 * is not the one a pull sends -- which is otherwise invisible, and is why
 * retyping a key there can change nothing at all.
 *
 * Null until the server has answered, so neither screen draws a conclusion
 * from not knowing yet. A request that fails reads as no server keys.
 */
export function useServerKeys(): ServerKeys | null {
  const [serverKeys, setServerKeys] = React.useState<ServerKeys | null>(null)

  React.useEffect(() => {
    let live = true
    fetch("/api/keys", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (live) setServerKeys(parseServerKeys(json))
      })
      .catch(() => {
        if (live) setServerKeys(NO_SERVER_KEYS)
      })
    return () => {
      live = false
    }
  }, [])

  return serverKeys
}
