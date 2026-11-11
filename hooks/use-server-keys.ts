import * as React from "react"
import { NO_SERVER_KEYS, parseServerKeys, type ServerKeys } from "@/lib/odds-feed/keys"

/**
 * Which feed keys the server holds in its own environment, which the routes
 * use before any key from Settings. Null until the server has answered.
 *
 * Two screens need it for opposite reasons. Today enables its button on an
 * install set up only through the environment, where Settings is empty.
 * Settings says when a key typed there is not the one in use, because a key
 * in the environment outranks it and nothing on that screen showed that it
 * did: the field took the new key, kept it, and every pull went on sending
 * the old one.
 *
 * Booleans only. A key value never leaves the server.
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
