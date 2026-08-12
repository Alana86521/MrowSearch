import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { extname, relative } from "node:path"

const root = process.cwd()
const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
const files = output.split("\0").filter(Boolean).filter(file => !file.startsWith("node_modules") && existsSync(file))
const textExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".json", ".md", ".yml", ".yaml", ".html", ".xml", ".conf", ".sh", ".env", ".txt"])
const failures = []
const restricted = ["T3BlbkFJ", "Q2hhdEdQVA==", "Q29kZXg=", "Q2xhdWRl", "QW50aHJvcGlj", "Q29waWxvdA==", "QWlkZXI=", "Q3Vyc29y", "Q2xpbmU="].map(value => Buffer.from(value, "base64").toString("utf8"))
const trackingSnapshot = readFileSync("deploy/tracking-hosts.txt")
const trackingChecksum = readFileSync("deploy/tracking-hosts.sha256", "utf8").trim().split(/\s+/)[0]

if (createHash("sha256").update(trackingSnapshot).digest("hex") !== trackingChecksum) {
  failures.push("deploy/tracking-hosts.txt: checksum mismatch")
}
const trackingSource = readFileSync("src/shared/tracking.ts", "utf8")
const snapshotHosts = trackingSnapshot.toString("utf8").trim().split(/\r?\n/).sort()
const sourceHosts = [...trackingSource.matchAll(/"([a-z0-9.-]+\.[a-z0-9.-]+)"/g)].map(match => match[1]).sort()
if (JSON.stringify(snapshotHosts) !== JSON.stringify(sourceHosts)) {
  failures.push("src/shared/tracking.ts: snapshot mismatch")
}

for (const file of files) {
  const extension = extname(file).toLowerCase()
  const basename = file.split(/[\\/]/).at(-1) ?? file
  if (!textExtensions.has(extension) && !["Dockerfile", ".dockerignore", ".gitignore", ".gitattributes"].includes(basename)) {
    continue
  }
  const content = readFileSync(file, "utf8")
  if (content.includes("\u2014")) {
    failures.push(`${file}: em dash`)
  }
  const lowered = content.toLowerCase()
  if (restricted.some(term => new RegExp(`(^|[^a-z])${term}([^a-z]|$)`, term === restricted[7] ? "" : "i").test(term === restricted[7] ? content : lowered))) {
    failures.push(`${file}: restricted provenance text`)
  }
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    for (const position of findScriptComments(content)) {
      failures.push(`${file}:${content.slice(0, position).split("\n").length}: comment`)
    }
  }
  if (extension === ".css" && /\/\*/.test(content)) {
    failures.push(`${file}: comment`)
  }
  if ([".yml", ".yaml"].includes(extension) && content.split(/\r?\n/).some(line => /^\s*#/.test(line))) {
    failures.push(`${file}: comment`)
  }
  if (["Dockerfile", ".dockerignore"].includes(basename) && content.split(/\r?\n/).some(line => /^\s*#/.test(line))) {
    failures.push(`${file}: comment`)
  }
  if (extension === ".sh" && content.split(/\r?\n/).slice(1).some(line => /^\s*#/.test(line))) {
    failures.push(`${file}: comment`)
  }
  if ([".md", ".html", ".xml"].includes(extension) && content.includes("<!--")) {
    failures.push(`${file}: comment`)
  }
  if (extension === ".conf" && content.split(/\r?\n/).some(line => /^\s*#/.test(line))) {
    failures.push(`${file}: comment`)
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`)
  process.exit(1)
}

process.stdout.write(`Policy check passed for ${files.length} tracked and unignored files in ${relative(root, root) || "."}.\n`)

function findScriptComments(content) {
  const positions = []
  let state = "code"
  let escaped = false
  for (let index = 0; index < content.length; index += 1) {
    const value = content[index]
    const next = content[index + 1]
    if (state === "code") {
      if (value === "'" || value === '"' || value === "`") {
        state = value
        escaped = false
        continue
      }
      if (value === "/" && content[index - 1] !== "\\" && (next === "/" || next === "*")) {
        positions.push(index)
        if (next === "/") {
          index = content.indexOf("\n", index + 2)
          if (index < 0) break
        } else {
          index = content.indexOf("*/", index + 2)
          if (index < 0) break
          index += 1
        }
      }
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (value === "\\") {
      escaped = true
      continue
    }
    if (value === state) {
      state = "code"
    }
  }
  return positions
}
