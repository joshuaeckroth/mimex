#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="$ROOT_DIR/infra/terraform"

AWS_REGION="${AWS_REGION:-us-east-1}"
HOSTED_ZONE_NAME="${HOSTED_ZONE_NAME:-mimex.dev}"
CREATE_HOSTED_ZONE="${CREATE_HOSTED_ZONE:-false}"
VPC_ID="${VPC_ID:-}"
SUBNET_ID="${SUBNET_ID:-}"
PROJECT_NAME="${PROJECT_NAME:-mimex}"
ENVIRONMENT="${ENVIRONMENT:-prod}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
INSTANCE_ARCH="${INSTANCE_ARCH:-arm64}"
ROOT_VOLUME_SIZE_GB="${ROOT_VOLUME_SIZE_GB:-30}"
DOCKER_COMPOSE_VERSION="${DOCKER_COMPOSE_VERSION:-v5.0.1}"
SSH_KEY_NAME="${SSH_KEY_NAME:-}"
SSH_CIDR="${SSH_CIDR:-}"
TF_INIT_UPGRADE="${TF_INIT_UPGRADE:-false}"

BUILD_CONTEXT="${BUILD_CONTEXT:-$ROOT_DIR}"
API_DOCKERFILE="${API_DOCKERFILE:-$ROOT_DIR/apps/api/Dockerfile}"
WEB_DOCKERFILE="${WEB_DOCKERFILE:-$ROOT_DIR/apps/web/Dockerfile}"
DOCKER_BUILD_PLATFORM="${DOCKER_BUILD_PLATFORM:-}"

IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
AUTO_APPROVE="${AUTO_APPROVE:-false}"

SSH_PRIVATE_KEY_PATH="${SSH_PRIVATE_KEY_PATH:-}"
BASIC_AUTH_USERNAME="${BASIC_AUTH_USERNAME:-mimex}"
BASIC_AUTH_PASSWORD_HASH="${BASIC_AUTH_PASSWORD_HASH:-}"

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

for bin in terraform docker git ssh scp tar mktemp; do
  require_bin "$bin"
done

if [[ ! -d "$TF_DIR" ]]; then
  echo "Terraform directory not found: $TF_DIR" >&2
  exit 1
fi

if [[ ! -d "$BUILD_CONTEXT" ]]; then
  echo "Build context not found: $BUILD_CONTEXT" >&2
  exit 1
fi

if [[ ! -f "$API_DOCKERFILE" ]]; then
  echo "API Dockerfile not found at $API_DOCKERFILE" >&2
  exit 1
fi

if [[ ! -f "$WEB_DOCKERFILE" ]]; then
  echo "Web Dockerfile not found at $WEB_DOCKERFILE" >&2
  exit 1
fi

if [[ -z "$SSH_KEY_NAME" ]]; then
  echo "Set SSH_KEY_NAME to your EC2 key pair name" >&2
  exit 1
fi

if [[ -z "$SSH_PRIVATE_KEY_PATH" || ! -f "$SSH_PRIVATE_KEY_PATH" ]]; then
  echo "Set SSH_PRIVATE_KEY_PATH to an existing private key file" >&2
  exit 1
fi

if [[ -z "$SSH_CIDR" ]]; then
  echo "Set SSH_CIDR to the deployer's public IP as a /32 CIDR" >&2
  exit 1
fi

if [[ ! "$BASIC_AUTH_USERNAME" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "BASIC_AUTH_USERNAME may contain only letters, digits, dot, underscore, and hyphen" >&2
  exit 1
fi

if [[ -z "$BASIC_AUTH_PASSWORD_HASH" ]]; then
  echo "Set BASIC_AUTH_PASSWORD_HASH to a Caddy-compatible password hash" >&2
  exit 1
fi

if [[ -z "$DOCKER_BUILD_PLATFORM" ]]; then
  case "$INSTANCE_ARCH" in
    arm64)
      DOCKER_BUILD_PLATFORM="linux/arm64"
      ;;
    x86_64)
      DOCKER_BUILD_PLATFORM="linux/amd64"
      ;;
    *)
      echo "Unsupported INSTANCE_ARCH: $INSTANCE_ARCH" >&2
      exit 1
      ;;
  esac
fi

if ! docker buildx version >/dev/null 2>&1; then
  echo "Docker Buildx is required for deployment image builds" >&2
  exit 1
fi

if ! BUILDX_INSPECT="$(docker buildx inspect --bootstrap 2>&1)"; then
  echo "Docker Buildx is installed, but the active builder could not start:" >&2
  echo "$BUILDX_INSPECT" >&2
  exit 1
fi

if [[ "$BUILDX_INSPECT" != *"$DOCKER_BUILD_PLATFORM"* ]]; then
  echo "The active Docker Buildx builder does not support $DOCKER_BUILD_PLATFORM" >&2
  echo "$BUILDX_INSPECT" >&2
  exit 1
fi

TF_VARS=(
  -var "aws_region=$AWS_REGION"
  -var "hosted_zone_name=$HOSTED_ZONE_NAME"
  -var "create_hosted_zone=$CREATE_HOSTED_ZONE"
  -var "project_name=$PROJECT_NAME"
  -var "environment=$ENVIRONMENT"
  -var "instance_type=$INSTANCE_TYPE"
  -var "instance_arch=$INSTANCE_ARCH"
  -var "root_volume_size_gb=$ROOT_VOLUME_SIZE_GB"
  -var "docker_compose_version=$DOCKER_COMPOSE_VERSION"
  -var "ssh_key_name=$SSH_KEY_NAME"
  -var "ssh_cidr=$SSH_CIDR"
)

if [[ -n "$VPC_ID" ]]; then
  TF_VARS+=( -var "vpc_id=$VPC_ID" )
fi

if [[ -n "$SUBNET_ID" ]]; then
  TF_VARS+=( -var "subnet_id=$SUBNET_ID" )
fi

tf_apply() {
  local extra_vars=("$@")
  if [[ "$AUTO_APPROVE" == "true" ]]; then
    terraform -chdir="$TF_DIR" apply -auto-approve "${TF_VARS[@]}" "${extra_vars[@]}"
  else
    terraform -chdir="$TF_DIR" apply "${TF_VARS[@]}" "${extra_vars[@]}"
  fi
}

wait_for_ssh() {
  local target="$1"
  local attempts=40
  local sleep_seconds=10
  local i=1

  while (( i <= attempts )); do
    if ssh "${SSH_OPTS[@]}" "$target" "echo ok" >/dev/null 2>&1; then
      return 0
    fi
    echo "Waiting for SSH on $target (attempt $i/$attempts)..."
    sleep "$sleep_seconds"
    i=$((i + 1))
  done

  echo "EC2 host is not reachable over SSH after $attempts attempts" >&2
  exit 1
}

wait_for_host_bootstrap() {
  local target="$1"

  echo "Waiting for cloud-init and Docker bootstrap on $target..."
  if ! ssh "${SSH_OPTS[@]}" "$target" \
    "sudo cloud-init status --wait >/dev/null && \
     command -v docker >/dev/null && \
     sudo systemctl is-active --quiet docker && \
     sudo docker compose version >/dev/null"; then
    echo "EC2 bootstrap failed; recent cloud-init output:" >&2
    ssh "${SSH_OPTS[@]}" "$target" "sudo tail -n 80 /var/log/cloud-init-output.log" >&2 || true
    exit 1
  fi
}

echo "==> Terraform init"
TF_INIT_ARGS=()
if [[ "$TF_INIT_UPGRADE" == "true" ]]; then
  TF_INIT_ARGS+=( -upgrade )
fi
terraform -chdir="$TF_DIR" init "${TF_INIT_ARGS[@]}"

API_IMAGE="mimex-api:$IMAGE_TAG"
WEB_IMAGE="mimex-web:$IMAGE_TAG"

echo "==> Build API image: $API_IMAGE"
docker buildx build --platform "$DOCKER_BUILD_PLATFORM" --load -f "$API_DOCKERFILE" -t "$API_IMAGE" "$BUILD_CONTEXT"

echo "==> Build Web image: $WEB_IMAGE"
docker buildx build --platform "$DOCKER_BUILD_PLATFORM" --load -f "$WEB_DOCKERFILE" -t "$WEB_IMAGE" "$BUILD_CONTEXT"

echo "==> Provision/update EC2 + DNS"
tf_apply

INSTANCE_IP="$(terraform -chdir="$TF_DIR" output -raw instance_public_ip)"
SITE_URL="$(terraform -chdir="$TF_DIR" output -raw site_url)"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat > "$TMP_DIR/.env" <<ENV
API_IMAGE=$API_IMAGE
WEB_IMAGE=$WEB_IMAGE
MIMEX_AUTH_USERNAME=$BASIC_AUTH_USERNAME
MIMEX_AUTH_PASSWORD_HASH='$BASIC_AUTH_PASSWORD_HASH'
ENV

echo "==> Export Docker images"
docker save -o "$TMP_DIR/api-image.tar" "$API_IMAGE"
docker save -o "$TMP_DIR/web-image.tar" "$WEB_IMAGE"

cat > "$TMP_DIR/Caddyfile" <<CADDY
${HOSTED_ZONE_NAME%.} {
  handle /auth/login {
    reverse_proxy web:3000
  }

  handle /auth/logout {
    header {
      Set-Cookie "mimex_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict"
      Cache-Control "no-store"
    }
    redir * /login.html 303
  }

  @public path /login.html /site.webmanifest /favicon.ico /favicon-*.png /apple-touch-icon.png /android-chrome-*.png
  handle @public {
    reverse_proxy web:3000
  }

  @authenticated header_regexp session Cookie "(^|;[[:space:]]*)mimex_session={\$MIMEX_AUTH_SESSION_TOKEN}(;|$)"
  handle @authenticated {
    header Set-Cookie "mimex_session={\$MIMEX_AUTH_SESSION_TOKEN}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Strict"

    @api path /api/*
    handle @api {
      reverse_proxy api:8080
    }

    handle {
      reverse_proxy web:3000
    }
  }

  @unauthenticated_api path /api/*
  handle @unauthenticated_api {
    header Content-Type "application/json; charset=utf-8"
    respond "{\"error\":\"authentication required\"}" 401
  }

  handle {
    redir * /login.html 303
  }
}
CADDY

cat > "$TMP_DIR/docker-compose.yml" <<'COMPOSE'
services:
  caddy:
    image: caddy:2.9-alpine
    restart: unless-stopped
    env_file:
      - .env
    ports:
      - "80:80"
      - "443:443"
    depends_on:
      - web
      - api
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

  web:
    image: ${WEB_IMAGE}
    restart: unless-stopped
    environment:
      HOST: "0.0.0.0"
      PORT: "3000"
      API_ORIGIN: "http://api:8080"
    env_file:
      - .env
    expose:
      - "3000"

  api:
    image: ${API_IMAGE}
    restart: unless-stopped
    environment:
      HOST: "0.0.0.0"
      PORT: "8080"
      MIMEX_WORKSPACE_ROOT: "/var/lib/mimex/workspaces"
    volumes:
      - /opt/mimex/data/workspaces:/var/lib/mimex/workspaces
      - /opt/mimex/secrets/ssh:/root/.ssh:ro
    expose:
      - "8080"

volumes:
  caddy_data:
  caddy_config:
COMPOSE

TARBALL="$TMP_DIR/mimex-deploy.tgz"
tar -C "$TMP_DIR" -czf "$TARBALL" docker-compose.yml Caddyfile .env api-image.tar web-image.tar

SSH_TARGET="ec2-user@$INSTANCE_IP"
SSH_OPTS=(
  -i "$SSH_PRIVATE_KEY_PATH"
  -o "UserKnownHostsFile=$TMP_DIR/known_hosts"
  -o StrictHostKeyChecking=accept-new
)

echo "==> Waiting for EC2 SSH availability"
wait_for_ssh "$SSH_TARGET"
wait_for_host_bootstrap "$SSH_TARGET"

echo "==> Upload deploy bundle to $SSH_TARGET"
scp "${SSH_OPTS[@]}" "$TARBALL" "$SSH_TARGET:/tmp/mimex-deploy.tgz"

echo "==> Activate services on EC2"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  'set -euo pipefail
   sudo mkdir -p /opt/mimex /opt/mimex/secrets/ssh
   sudo chmod 700 /opt/mimex/secrets/ssh
   sudo tar -xzf /tmp/mimex-deploy.tgz -C /opt/mimex
   if ! sudo test -s /opt/mimex/secrets/auth-session-token; then
     SESSION_TOKEN="$(openssl rand -hex 32)"
     printf "%s\n" "$SESSION_TOKEN" | sudo tee /opt/mimex/secrets/auth-session-token >/dev/null
     sudo chmod 600 /opt/mimex/secrets/auth-session-token
     unset SESSION_TOKEN
   fi
   MIMEX_AUTH_SESSION_TOKEN="$(sudo cat /opt/mimex/secrets/auth-session-token)"
   printf "MIMEX_AUTH_SESSION_TOKEN=%s\n" "$MIMEX_AUTH_SESSION_TOKEN" | sudo tee -a /opt/mimex/.env >/dev/null
   unset MIMEX_AUTH_SESSION_TOKEN
   sudo docker load -i /opt/mimex/api-image.tar
   sudo docker load -i /opt/mimex/web-image.tar
   sudo systemctl restart mimex-compose || true
   sudo systemctl enable mimex-compose
   sudo docker compose -f /opt/mimex/docker-compose.yml --env-file /opt/mimex/.env up -d --remove-orphans
   sudo rm -f /opt/mimex/api-image.tar /opt/mimex/web-image.tar /tmp/mimex-deploy.tgz'

echo ""
echo "Release complete"
echo "Site URL: $SITE_URL"
echo "API base: $SITE_URL/api"
echo "MCP: not exposed in slim cloud deploy (stdio only)"
echo "Instance IP: $INSTANCE_IP"
echo "Image tag: $IMAGE_TAG"
