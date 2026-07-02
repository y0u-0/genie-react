// ws's optional native addons crash when a host bundler or stale prebuild half-resolves them ("bufferUtil.unmask is not a function"); loopback dev traffic never needs their speed, so opt out before ws loads.
process.env.WS_NO_BUFFER_UTIL ??= '1'
process.env.WS_NO_UTF_8_VALIDATE ??= '1'

export {}
