import ipaddr from "ipaddr.js"

export type AddressInput = { kind: "url"; url: string } | { kind: "search"; query: string } | { kind: "invalid"; message: string }

export function classifyAddressInput(value: string): AddressInput {
  const input = value.trim()
  if (!input) {
    return { kind: "search", query: "" }
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(input)
  if (hasScheme && !/^https?:\/\//i.test(input)) {
    return { kind: "invalid", message: "Only HTTP and HTTPS addresses are supported." }
  }
  const candidate = /^https?:\/\//i.test(input) ? input : !/\s/.test(input) && input.includes(".") ? `https://${input}` : null
  if (!candidate) {
    return { kind: "search", query: input }
  }
  try {
    const url = new URL(candidate)
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
      return { kind: "invalid", message: "Only HTTP and HTTPS addresses are supported." }
    }
    if (url.username || url.password) {
      return { kind: "invalid", message: "Addresses with embedded usernames or passwords are not allowed." }
    }
    if (!isPublicHost(url.hostname)) {
      return { kind: "invalid", message: "The address must use a public destination host." }
    }
    return { kind: "url", url: cleanTrackingParameters(url).toString() }
  } catch {
    return { kind: "invalid", message: "The address is invalid. Check the host and port, then try again." }
  }
}

function isPublicHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (["localhost", "metadata.google.internal", "host.docker.internal", "gateway.docker.internal"].includes(host) || [".local", ".internal", ".localhost", ".home.arpa", ".docker", ".lan"].some(suffix => host.endsWith(suffix))) {
    return false
  }
  if (ipaddr.isValid(host)) {
    const address = ipaddr.process(host)
    if (address.range() !== "unicast") {
      return false
    }
    if (address.kind() === "ipv4") {
      const [first, second] = (address as ipaddr.IPv4).octets
      return !(first === 100 && second >= 64 && second <= 127)
    }
    const blocked = ["64:ff9b:1::/48", "100::/64", "2001::/23", "2002::/16", "3fff::/20", "5f00::/16"].map(value => ipaddr.parseCIDR(value) as [ipaddr.IPv6, number])
    if (blocked.some(range => (address as ipaddr.IPv6).match(range))) {
      return false
    }
    return true
  }
  return host.includes(".") && host.split(".").every(label => label.length >= 1 && label.length <= 63)
}

const trackingNames = new Set(["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid", "ref_src", "vero_id"])

export function cleanTrackingParameters(url: URL) {
  for (const name of [...url.searchParams.keys()]) {
    if (trackingNames.has(name.toLowerCase()) || name.toLowerCase().startsWith("utm_")) {
      url.searchParams.delete(name)
    }
  }
  return url
}

export function displayUrl(value: string) {
  try {
    const url = new URL(value)
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`
  } catch {
    return value
  }
}
