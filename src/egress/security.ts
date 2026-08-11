import ipaddr from "ipaddr.js"

export function validateHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  const blockedNames = ["localhost", "localhost.localdomain", "metadata.google.internal", "instance-data.ec2.internal", "host.docker.internal", "gateway.docker.internal"]
  const blockedSuffixes = [".local", ".internal", ".localhost", ".home.arpa", ".docker", ".lan"]
  if (blockedNames.includes(host) || blockedSuffixes.some(suffix => host.endsWith(suffix))) {
    throw new Error("The destination host is private or reserved.")
  }
  return host
}

export function validateAddress(address: string) {
  const parsed = ipaddr.process(address)
  const range = parsed.range()
  if (range !== "unicast") {
    throw new Error("The destination address is not public.")
  }
  if (parsed.kind() === "ipv4") {
    const [first, second] = (parsed as ipaddr.IPv4).octets
    if (first === 100 && second >= 64 && second <= 127) {
      throw new Error("The destination address is not public.")
    }
  }
  if (parsed.kind() === "ipv6") {
    const blocked = ["64:ff9b:1::/48", "100::/64", "2001::/23", "2002::/16", "3fff::/20", "5f00::/16"].map(value => ipaddr.parseCIDR(value) as [ipaddr.IPv6, number])
    if (blocked.some(rangeValue => (parsed as ipaddr.IPv6).match(rangeValue))) {
      throw new Error("The destination address is not public.")
    }
  }
  return parsed.toString()
}

export function validateResolvedAddresses(values: string[]) {
  if (values.length === 0) {
    throw new Error("The destination host did not resolve.")
  }
  return [...new Set(values.map(validateAddress))]
}

export function parseAuthority(authority: string) {
  const bracket = /^\[([^\]]+)]:(\d+)$/.exec(authority)
  if (bracket) {
    return { hostname: bracket[1], port: Number(bracket[2]) }
  }
  const index = authority.lastIndexOf(":")
  if (index < 1) {
    throw new Error("The destination port is missing.")
  }
  return { hostname: authority.slice(0, index), port: Number(authority.slice(index + 1)) }
}
