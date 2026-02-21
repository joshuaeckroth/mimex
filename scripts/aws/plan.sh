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

if ! command -v terraform >/dev/null 2>&1; then
  echo "Missing required command: terraform" >&2
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
  -var "ssh_cidr=$SSH_CIDR"
)

if [[ -n "$SSH_KEY_NAME" ]]; then
  TF_VARS+=( -var "ssh_key_name=$SSH_KEY_NAME" )
fi

terraform -chdir="$TF_DIR" init
terraform -chdir="$TF_DIR" plan "${TF_VARS[@]}"
