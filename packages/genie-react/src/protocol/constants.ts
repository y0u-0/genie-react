export const GENIE_PROTOCOL_VERSION = 1

/** WebSocket path the hub listens on, mounted on the Vite dev server's HTTP socket. */
export const GENIE_WS_PATH = '/__genie/ws'

/** Global the in-browser client publishes itself on, for debugging and the shell plugin. */
export const GENIE_GLOBAL_KEY = '__GENIE_REACT_AGENT__'

/** Discovery file the Vite plugin writes so the genie CLI can find the hub URL. */
export const GENIE_DISCOVERY_FILE = '.genie/bridge.json'

/** Default port for the standalone hub (`genie hub`, Next.js instrumentation). */
export const GENIE_DEFAULT_HUB_PORT = 4390

/** `Symbol.for` key the hub's bound port is published under: survives Next.js resetting `process.env` between recompiles, so `<GenieScript />` keeps emitting a walked port. */
export const GENIE_HUB_PORT_GLOBAL = 'genie-react.hubPort'

/** HTTP path the standalone hub serves the self-contained browser client from. */
export const GENIE_CLIENT_PATH = '/__genie/client.js'

/** HTTP path a standalone hub identifies itself on, so a second hub can tell reuse from a port collision. */
export const GENIE_INFO_PATH = '/__genie/info'

// Generous by default: some tools (e.g. browser_measure_memory, slow loaders) legitimately take seconds.
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
export const DEFAULT_INSPECT_DEPTH = 2
export const DEFAULT_PREVIEW_STRING_LENGTH = 80
export const DEFAULT_MAX_STRING_LENGTH = 1_000
export const DEFAULT_MAX_ENTRIES = 100

export type ConnectionRole = 'app' | 'agent'
export const ROLE_QUERY_PARAM = 'role'
