#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
env_file="$repo_root/.env"
compose_file="$repo_root/compose.yaml"
service_file="/etc/systemd/system/mrowsearch.service"
casaos_url_file="/var/run/casaos/app-management.url"
service_description="MrowSearch container stack managed by install.sh"

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

run_root() {
  if (( EUID == 0 )); then
    "$@"
    return
  fi
  command -v sudo >/dev/null 2>&1 || fail "Install sudo or run this command as root."
  sudo "$@"
}

env_value() {
  local key="$1"
  [[ -f "$env_file" ]] || return 0
  awk -v key="$key" 'index($0, key "=") == 1 { sub(/^[^=]*=/, ""); sub(/\r$/, ""); print; exit }' "$env_file"
}

set_env() {
  local key="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$env_file" > "$temporary"
  mv "$temporary" "$env_file"
  chmod 600 "$env_file"
}

fill_secret() {
  local key="$1"
  local format="$2"
  local supplied="${!key-}"
  local current
  local generated
  current="$(env_value "$key")"
  if [[ -n "$supplied" ]]; then
    set_env "$key" "$supplied"
  elif [[ -z "$current" ]]; then
    case "$format" in
      data-key) generated="$(openssl rand -base64 32 | tr -d '\r\n')" ;;
      hex-24) generated="$(openssl rand -hex 24)" ;;
      hex-32) generated="$(openssl rand -hex 32)" ;;
      *) fail "The installer received an unknown secret format." ;;
    esac
    set_env "$key" "$generated"
  fi
}

install_base_tools() {
  local missing=0
  local tool
  for tool in awk curl grep hostname openssl sed ss; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing=1
    fi
  done
  if (( missing == 0 )); then
    return
  fi
  command -v apt-get >/dev/null 2>&1 || fail "This installer supports Ubuntu and Debian hosts that use apt."
  say "Installing the required host tools."
  run_root env DEBIAN_FRONTEND=noninteractive apt-get update
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl iproute2 openssl
}

configure_docker_repository() {
  local distro_id
  local codename
  local architecture
  local key_file
  local source_file
  command -v apt-get >/dev/null 2>&1 || fail "Docker installation supports Ubuntu and Debian hosts that use apt."
  distro_id="$(. /etc/os-release && printf '%s' "$ID")"
  codename="$(. /etc/os-release && printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")"
  architecture="$(dpkg --print-architecture)"
  [[ "$distro_id" == "ubuntu" || "$distro_id" == "debian" ]] || fail "Docker installation supports Ubuntu and Debian."
  [[ -n "$codename" ]] || fail "The installer could not find the operating system codename."
  key_file="$(mktemp)"
  source_file="$(mktemp)"
  curl -fsSL "https://download.docker.com/linux/$distro_id/gpg" -o "$key_file"
  printf '%s\n' \
    "Types: deb" \
    "URIs: https://download.docker.com/linux/$distro_id" \
    "Suites: $codename" \
    "Components: stable" \
    "Architectures: $architecture" \
    "Signed-By: /etc/apt/keyrings/docker.asc" > "$source_file"
  run_root install -m 0755 -d /etc/apt/keyrings
  run_root install -m 0644 "$key_file" /etc/apt/keyrings/docker.asc
  run_root install -m 0644 "$source_file" /etc/apt/sources.list.d/docker.sources
  rm -f "$key_file" "$source_file"
  run_root env DEBIAN_FRONTEND=noninteractive apt-get update
}

ensure_docker() {
  local architecture
  architecture="$(uname -m)"
  case "$architecture" in
    x86_64|amd64|aarch64|arm64) ;;
    *) fail "MrowSearch supports AMD64 and ARM64 hosts." ;;
  esac
  if ! command -v docker >/dev/null 2>&1; then
    say "Installing Docker Engine and Docker Compose."
    configure_docker_repository
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif ! run_root docker compose version >/dev/null 2>&1; then
    say "Installing the Docker Compose plugin."
    configure_docker_repository
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin
  fi
  if command -v systemctl >/dev/null 2>&1; then
    run_root systemctl enable --now docker.service
    if systemctl list-unit-files --type=service 2>/dev/null | grep -q '^containerd.service'; then
      run_root systemctl enable containerd.service
    fi
  fi
  run_root docker info >/dev/null
  run_root docker compose version >/dev/null
}

port_is_used() {
  local port="$1"
  ss -H -ltn | awk '{ print $4 }' | grep -Eq "(^|:)$port$"
}

select_port() {
  local port="${MROW_PORT:-3080}"
  local candidate
  [[ "$port" =~ ^[0-9]+$ ]] || fail "MROW_PORT must be a number."
  port="$((10#$port))"
  (( port >= 1024 && port <= 65535 )) || fail "MROW_PORT must be between 1024 and 65535."
  if [[ -n "${MROW_PORT-}" ]]; then
    printf '%s' "$port"
    return
  fi
  for (( candidate = port; candidate <= port + 19 && candidate <= 65535; candidate += 1 )); do
    if ! port_is_used "$candidate"; then
      printf '%s' "$candidate"
      return
    fi
  done
  fail "Ports $port through $((port + 19)) are in use. Set MROW_PORT and run the installer again."
}

append_origin() {
  local list="$1"
  local origin="$2"
  if [[ ",$list," == *",$origin,"* ]]; then
    printf '%s' "$list"
  elif [[ -z "$list" ]]; then
    printf '%s' "$origin"
  else
    printf '%s,%s' "$list" "$origin"
  fi
}

prepare_environment() {
  local created=0
  local port
  local public_url
  local allow_http
  local allowed_origins
  local address
  local primary_address=""
  local short_name
  local casaos_authority
  local casaos_hostname
  local casaos_port
  if [[ ! -f "$env_file" ]]; then
    cp "$repo_root/.env.example" "$env_file"
    chmod 600 "$env_file"
    created=1
  fi
  if [[ -n "${MROW_PORT-}" ]]; then
    port="$(select_port)"
  elif (( created == 1 )); then
    port="$(select_port)"
  else
    port="$(env_value MROW_PORT)"
    [[ -n "$port" ]] || port=3080
  fi
  set_env MROW_PORT "$port"
  for address in $(hostname -I 2>/dev/null || true); do
    if [[ "$address" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ && "$address" != 127.* ]]; then
      primary_address="${primary_address:-$address}"
    fi
  done
  primary_address="${primary_address:-127.0.0.1}"
  public_url="${MROW_PUBLIC_URL:-$(env_value MROW_PUBLIC_URL)}"
  if [[ -z "$public_url" || "$public_url" == "https://search.example.com" ]]; then
    public_url="http://$primary_address:$port"
  fi
  public_url="${public_url%/}"
  case "$public_url" in
    https://*) allow_http=false ;;
    http://*) allow_http=true ;;
    *) fail "MROW_PUBLIC_URL must start with http:// or https://." ;;
  esac
  set_env MROW_PUBLIC_URL "$public_url"
  set_env MROW_ALLOW_INSECURE_HTTP "$allow_http"
  casaos_authority="${public_url#*://}"
  casaos_authority="${casaos_authority%%/*}"
  if [[ "$casaos_authority" == \[*\]* ]]; then
    casaos_hostname="${casaos_authority%%]*}"
    casaos_hostname="${casaos_hostname#\[}"
    if [[ "$casaos_authority" == *"]:"* ]]; then
      casaos_port="${casaos_authority##*:}"
    elif [[ "$allow_http" == "true" ]]; then
      casaos_port=80
    else
      casaos_port=443
    fi
  else
    casaos_hostname="${casaos_authority%%:*}"
    if [[ "$casaos_authority" == *:* ]]; then
      casaos_port="${casaos_authority##*:}"
    elif [[ "$allow_http" == "true" ]]; then
      casaos_port=80
    else
      casaos_port=443
    fi
  fi
  set_env MROW_CASAOS_SCHEME "${public_url%%://*}"
  set_env MROW_CASAOS_HOSTNAME "$casaos_hostname"
  set_env MROW_CASAOS_PORT "$casaos_port"
  if [[ -n "${MROW_ALLOWED_ORIGINS-}" ]]; then
    allowed_origins="$MROW_ALLOWED_ORIGINS"
  elif [[ -n "${MROW_PUBLIC_URL-}" ]]; then
    allowed_origins=""
  else
    allowed_origins="$(env_value MROW_ALLOWED_ORIGINS)"
  fi
  if [[ -z "$allowed_origins" ]]; then
    allowed_origins="$(append_origin "$allowed_origins" "$public_url")"
    if [[ "$allow_http" == "true" ]]; then
      for address in $(hostname -I 2>/dev/null || true); do
        if [[ "$address" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
          allowed_origins="$(append_origin "$allowed_origins" "http://$address:$port")"
        fi
      done
      short_name="$(hostname -s 2>/dev/null || true)"
      if [[ "$short_name" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
        allowed_origins="$(append_origin "$allowed_origins" "http://$short_name:$port")"
        allowed_origins="$(append_origin "$allowed_origins" "http://$short_name.local:$port")"
      fi
      allowed_origins="$(append_origin "$allowed_origins" "http://localhost:$port")"
      allowed_origins="$(append_origin "$allowed_origins" "http://127.0.0.1:$port")"
    fi
  fi
  set_env MROW_ALLOWED_ORIGINS "$allowed_origins"
  fill_secret MROW_SETUP_TOKEN hex-32
  fill_secret MROW_DATA_KEY data-key
  fill_secret MROW_SESSION_SECRET hex-32
  fill_secret MROW_WORKER_PASSWORD hex-24
  fill_secret MROW_SEARXNG_SECRET hex-32
  chmod 600 "$env_file"
}

compose() {
  run_root docker compose --project-directory "$repo_root" --env-file "$env_file" -f "$compose_file" "$@"
}

is_generated_service() {
  [[ -f "$service_file" ]] && grep -Fqx "Description=$service_description" "$service_file"
}

stop_generated_service() {
  if is_generated_service && command -v systemctl >/dev/null 2>&1; then
    run_root systemctl disable --now mrowsearch.service >/dev/null 2>&1 || true
  fi
}

remove_generated_service() {
  if ! is_generated_service; then
    return
  fi
  stop_generated_service
  run_root rm -f "$service_file"
  run_root systemctl daemon-reload
}

install_systemd_service() {
  local docker_path
  local temporary
  command -v systemctl >/dev/null 2>&1 || return
  [[ "$repo_root" != *[[:space:]]* ]] || fail "Move the repository to a path without spaces before systemd setup."
  docker_path="$(command -v docker)"
  temporary="$(mktemp)"
  printf '%s\n' \
    "[Unit]" \
    "Description=$service_description" \
    "Requires=docker.service" \
    "After=docker.service network-online.target" \
    "Wants=network-online.target" \
    "" \
    "[Service]" \
    "Type=oneshot" \
    "RemainAfterExit=yes" \
    "WorkingDirectory=$repo_root" \
    "ExecStart=$docker_path compose --project-directory $repo_root --env-file $env_file -f $compose_file up -d --remove-orphans" \
    "ExecStop=$docker_path compose --project-directory $repo_root --env-file $env_file -f $compose_file stop" \
    "TimeoutStartSec=infinity" \
    "TimeoutStopSec=120" \
    "" \
    "[Install]" \
    "WantedBy=multi-user.target" > "$temporary"
  run_root install -m 0644 "$temporary" "$service_file"
  rm -f "$temporary"
  run_root systemctl daemon-reload
  run_root systemctl enable mrowsearch.service
  run_root systemctl restart mrowsearch.service
}

casaos_endpoint() {
  [[ -s "$casaos_url_file" ]] || return 1
  tr -d '\r\n' < "$casaos_url_file"
}

casaos_app_exists() {
  local endpoint="$1"
  curl -fsS --connect-timeout 3 --max-time 10 "$endpoint/v2/app_management/compose/mrowsearch" >/dev/null 2>&1
}

register_with_casaos() {
  local endpoint
  local rendered
  local response
  local status
  local method
  local target
  local existing=0
  endpoint="$(casaos_endpoint)" || return 1
  if casaos_app_exists "$endpoint"; then
    existing=1
    method=PUT
    target="$endpoint/v2/app_management/compose/mrowsearch?check_port_conflict=false"
  else
    method=POST
    target="$endpoint/v2/app_management/compose?check_port_conflict=true"
  fi
  stop_generated_service
  if (( existing == 0 )); then
    compose down --remove-orphans >/dev/null 2>&1 || true
  fi
  rendered="$(mktemp)"
  response="$(mktemp)"
  compose config > "$rendered"
  chmod 600 "$rendered"
  status="$(curl -sS --connect-timeout 3 --max-time 30 -o "$response" -w '%{http_code}' -X "$method" -H 'Accept: application/json' -H 'Content-Type: application/yaml' --data-binary "@$rendered" "$target" || true)"
  if [[ "$status" != "200" ]]; then
    say "CasaOS registration returned HTTP ${status:-000}."
    sed -n '1,8p' "$response" >&2
    rm -f "$rendered" "$response"
    return 1
  fi
  rm -f "$rendered" "$response"
  remove_generated_service
  return 0
}

wait_for_app() {
  local port
  local attempt
  port="$(env_value MROW_PORT)"
  for (( attempt = 1; attempt <= 180; attempt += 1 )); do
    if curl -fsS --connect-timeout 2 --max-time 4 "http://127.0.0.1:$port/health/ready" >/dev/null 2>&1; then
      return 0
    fi
    if (( attempt % 15 == 0 )); then
      say "Waiting for a browser worker to become ready."
    fi
    sleep 2
  done
  say "MrowSearch did not become ready within six minutes."
  compose ps || true
  compose logs --tail=80 mrow-app mrow-browser-1 || true
  return 1
}

print_summary() {
  local public_url
  local setup_token
  local allow_http
  local mode="$1"
  public_url="$(env_value MROW_PUBLIC_URL)"
  setup_token="$(env_value MROW_SETUP_TOKEN)"
  allow_http="$(env_value MROW_ALLOW_INSECURE_HTTP)"
  say ""
  say "MrowSearch is ready."
  say "Open: $public_url"
  say "Setup token: $setup_token"
  say "Startup manager: $mode"
  say "Open the page and create the owner account. No other setup is required."
  say "The installer stored the secrets in $env_file with owner-only access."
  if [[ "$allow_http" == "true" ]]; then
    say "The generated HTTP URL is for the local network. Set an HTTPS URL before remote access."
  fi
}

install_application() {
  local memory_kib
  local mode
  [[ "$(uname -s)" == "Linux" ]] || fail "Run this installer on the Ubuntu or Debian host that will run MrowSearch."
  [[ -f "$compose_file" && -f "$repo_root/.env.example" ]] || fail "Run the installer from the MrowSearch repository."
  install_base_tools
  ensure_docker
  prepare_environment
  memory_kib="$(awk '/MemTotal/ { print $2; exit }' /proc/meminfo)"
  if [[ -n "$memory_kib" ]] && (( memory_kib < 7500000 )); then
    say "Warning: MrowSearch works best with at least 8 GB of memory."
  fi
  say "Checking the generated configuration."
  compose config --quiet
  say "Building the MrowSearch application and browser image."
  compose build --pull
  if register_with_casaos; then
    mode="CasaOS"
    say "CasaOS registered and started the application."
  else
    say "CasaOS is not available. Starting the Docker Compose stack."
    compose up -d --remove-orphans
    install_systemd_service
    mode="systemd and Docker restart policies"
  fi
  wait_for_app
  compose ps
  print_summary "$mode"
}

show_status() {
  [[ -f "$env_file" ]] || fail "Run bash install.sh first."
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed."
  compose ps
  local port
  port="$(env_value MROW_PORT)"
  if curl -fsS --connect-timeout 2 --max-time 4 "http://127.0.0.1:$port/health/ready"; then
    say ""
    say "MrowSearch is ready."
  else
    say ""
    say "MrowSearch is not ready. Run bash install.sh logs."
    return 1
  fi
}

show_logs() {
  [[ -f "$env_file" ]] || fail "Run bash install.sh first."
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed."
  compose logs --tail=200
}

show_setup_token() {
  [[ -f "$env_file" ]] || fail "Run bash install.sh first."
  env_value MROW_SETUP_TOKEN
}

uninstall_application() {
  local endpoint
  local response
  local status
  [[ -f "$env_file" ]] || fail "Run bash install.sh first."
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed."
  if endpoint="$(casaos_endpoint)" && casaos_app_exists "$endpoint"; then
    response="$(mktemp)"
    status="$(curl -sS --connect-timeout 3 --max-time 30 -o "$response" -w '%{http_code}' -X DELETE "$endpoint/v2/app_management/compose/mrowsearch?delete_config_folder=false" || true)"
    if [[ "$status" != "200" ]]; then
      sed -n '1,8p' "$response" >&2
    fi
    rm -f "$response"
  fi
  remove_generated_service
  compose down --remove-orphans
  say "MrowSearch stopped. The data volume, images, and $env_file remain on this host."
}

update_application() {
  command -v git >/dev/null 2>&1 || fail "Git is required for an update."
  [[ -d "$repo_root/.git" ]] || fail "This directory is not a Git checkout."
  if [[ -n "$(git -C "$repo_root" status --porcelain --untracked-files=no)" ]]; then
    fail "Commit or stash the tracked changes before an update."
  fi
  git -C "$repo_root" pull --ff-only
  install_application
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  action="${1:-install}"
  case "$action" in
    install) install_application ;;
    update) update_application ;;
    status) show_status ;;
    logs) show_logs ;;
    setup-token) show_setup_token ;;
    uninstall) uninstall_application ;;
    *) fail "Use install, update, status, logs, setup-token, or uninstall." ;;
  esac
fi
