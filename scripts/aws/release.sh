#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="$ROOT_DIR/infra/terraform"

AWS_REGION="${AWS_REGION:-us-east-1}"
HOSTED_ZONE_NAME="${HOSTED_ZONE_NAME:-mimex.dev}"
PROJECT_NAME="${PROJECT_NAME:-mimex}"
ENVIRONMENT="${ENVIRONMENT:-prod}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
INSTANCE_ARCH="${INSTANCE_ARCH:-arm64}"
ROOT_VOLUME_SIZE_GB="${ROOT_VOLUME_SIZE_GB:-30}"
SSH_KEY_NAME="${SSH_KEY_NAME:-}"
SSH_CIDR="${SSH_CIDR:-0.0.0.0/0}"

BUILD_CONTEXT="${BUILD_CONTEXT:-$ROOT_DIR}"
API_DOCKERFILE="${API_DOCKERFILE:-$ROOT_DIR/apps/api/Dockerfile}"
WEB_DOCKERFILE="${WEB_DOCKERFILE:-$ROOT_DIR/apps/web/Dockerfile}"

IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
AUTO_APPROVE="${AUTO_APPROVE:-true}"

SSH_PRIVATE_KEY_PATH="${SSH_PRIVATE_KEY_PATH:-}"
TLS_CERT_PATH="${TLS_CERT_PATH:-}"
TLS_KEY_PATH="${TLS_KEY_PATH:-}"

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

for bin in terraform aws docker git ssh scp tar mktemp; do
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

if [[ -z "$TLS_CERT_PATH" || ! -f "$TLS_CERT_PATH" ]]; then
  echo "Set TLS_CERT_PATH to your fullchain PEM file" >&2
  exit 1
fi

if [[ -z "$TLS_KEY_PATH" || ! -f "$TLS_KEY_PATH" ]]; then
  echo "Set TLS_KEY_PATH to your private key PEM file" >&2
  exit 1
fi

TF_VARS=(
  -var "aws_region=$AWS_REGION"
  -var "hosted_zone_name=$HOSTED_ZONE_NAME"
  -var "project_name=$PROJECT_NAME"
  -var "environment=$ENVIRONMENT"
  -var "instance_type=$INSTANCE_TYPE"
  -var "instance_arch=$INSTANCE_ARCH"
  -var "root_volume_size_gb=$ROOT_VOLUME_SIZE_GB"
  -var "ssh_key_name=$SSH_KEY_NAME"
  -var "ssh_cidr=$SSH_CIDR"
)

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

echo "==> Terraform init"
terraform -chdir="$TF_DIR" init

echo "==> Provision/update EC2 + ECR + DNS"
tf_apply

API_ECR_REPO="$(terraform -chdir="$TF_DIR" output -raw api_ecr_repository_url)"
WEB_ECR_REPO="$(terraform -chdir="$TF_DIR" output -raw web_ecr_repository_url)"
INSTANCE_IP="$(terraform -chdir="$TF_DIR" output -raw instance_public_ip)"
SITE_URL="$(terraform -chdir="$TF_DIR" output -raw site_url)"
REGISTRY_HOST="${API_ECR_REPO%%/*}"

echo "==> ECR login ($REGISTRY_HOST)"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY_HOST"

API_IMAGE="$API_ECR_REPO:$IMAGE_TAG"
WEB_IMAGE="$WEB_ECR_REPO:$IMAGE_TAG"

echo "==> Build and push API image: $API_IMAGE"
docker build -f "$API_DOCKERFILE" -t "$API_IMAGE" "$BUILD_CONTEXT"
docker push "$API_IMAGE"

echo "==> Build and push Web image: $WEB_IMAGE"
docker build -f "$WEB_DOCKERFILE" -t "$WEB_IMAGE" "$BUILD_CONTEXT"
docker push "$WEB_IMAGE"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cp "$TLS_CERT_PATH" "$TMP_DIR/fullchain.pem"
cp "$TLS_KEY_PATH" "$TMP_DIR/privkey.pem"

cat > "$TMP_DIR/.env" <<ENV
HOST_NAME=${HOSTED_ZONE_NAME%.}
API_IMAGE=$API_IMAGE
WEB_IMAGE=$WEB_IMAGE
ENV

cat > "$TMP_DIR/Caddyfile" <<'CADDY'
http://{$HOST_NAME} {
  redir https://{$HOST_NAME}{uri} permanent
}

https://{$HOST_NAME} {
  tls /certs/fullchain.pem /certs/privkey.pem

  @api path /api/*
  handle @api {
    reverse_proxy api:8080
  }

  handle {
    reverse_proxy web:3000
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
      - ./certs:/certs:ro
      - caddy_data:/data
      - caddy_config:/config

  web:
    image: ${WEB_IMAGE}
    restart: unless-stopped
    environment:
      HOST: "0.0.0.0"
      PORT: "3000"
      API_ORIGIN: "http://api:8080"
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
    expose:
      - "8080"

volumes:
  caddy_data:
  caddy_config:
COMPOSE

mkdir -p "$TMP_DIR/certs"
mv "$TMP_DIR/fullchain.pem" "$TMP_DIR/certs/fullchain.pem"
mv "$TMP_DIR/privkey.pem" "$TMP_DIR/certs/privkey.pem"

TARBALL="$TMP_DIR/mimex-deploy.tgz"
tar -C "$TMP_DIR" -czf "$TARBALL" docker-compose.yml Caddyfile .env certs

SSH_TARGET="ec2-user@$INSTANCE_IP"
SSH_OPTS=(-i "$SSH_PRIVATE_KEY_PATH" -o StrictHostKeyChecking=accept-new)

echo "==> Waiting for EC2 SSH availability"
wait_for_ssh "$SSH_TARGET"

echo "==> Upload deploy bundle to $SSH_TARGET"
scp "${SSH_OPTS[@]}" "$TARBALL" "$SSH_TARGET:/tmp/mimex-deploy.tgz"

echo "==> Activate services on EC2"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "set -euo pipefail; \
   sudo mkdir -p /opt/mimex; \
   sudo tar -xzf /tmp/mimex-deploy.tgz -C /opt/mimex; \
   sudo chmod 600 /opt/mimex/certs/privkey.pem; \
   sudo chown -R root:root /opt/mimex/certs; \
   aws ecr get-login-password --region '$AWS_REGION' | sudo docker login --username AWS --password-stdin '$REGISTRY_HOST'; \
   sudo systemctl restart mimex-compose || true; \
   sudo systemctl enable mimex-compose; \
   sudo docker compose -f /opt/mimex/docker-compose.yml --env-file /opt/mimex/.env pull; \
   sudo docker compose -f /opt/mimex/docker-compose.yml --env-file /opt/mimex/.env up -d --remove-orphans"

echo ""
echo "Release complete"
echo "Site URL: $SITE_URL"
echo "API base: $SITE_URL/api"
echo "MCP: not exposed in slim cloud deploy (stdio only)"
echo "Instance IP: $INSTANCE_IP"
echo "Image tag: $IMAGE_TAG"
