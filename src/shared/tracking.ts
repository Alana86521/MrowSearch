const trackerDomains = new Set([
  "2mdn.net",
  "adnxs.com",
  "adsrvr.org",
  "amazon-adsystem.com",
  "app-measurement.com",
  "branch.io",
  "clarity.ms",
  "criteo.com",
  "criteo.net",
  "demdex.net",
  "doubleclick.net",
  "facebook.net",
  "google-analytics.com",
  "googlesyndication.com",
  "googletagmanager.com",
  "hotjar.com",
  "mathtag.com",
  "mixpanel.com",
  "newrelic.com",
  "omtrdc.net",
  "quantserve.com",
  "scorecardresearch.com",
  "segment.io",
  "segment.com",
  "taboola.com",
  "tealiumiq.com",
  "yieldmo.com"
])

export function isTrackerHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  return [...trackerDomains].some(domain => host === domain || host.endsWith(`.${domain}`))
}
