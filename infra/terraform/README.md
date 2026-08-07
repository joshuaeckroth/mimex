# AWS Terraform (single-host on mimex.dev)

This stack deploys Mimex on a single low-cost EC2 host and serves everything from `https://mimex.dev`.

## What it creates

- One EC2 instance (`t4g.small` by default)
- One Elastic IP (stable address)
- Route53 root `A` record (`mimex.dev` -> Elastic IP)
- One security group (80/443 + optional SSH)
- IAM role/profile for SSM access

## Architecture

- TLS endpoint: Caddy on the EC2 host with automatic HTTPS
- Access control: password login with a secure, HTTP-only session cookie enforced by Caddy
- Reverse proxy on host (Caddy container)
- Path routing:
  - `/` -> web container
  - `/api/*` -> API container
- Workspace data persists on host storage and is mounted into API container
- Dedicated Git SSH credentials persist at `/opt/mimex/secrets/ssh` and are mounted read-only into the API container
- MCP is currently stdio-based (`apps/mcp`) and not exposed via HTTP in this slim deploy

## Prerequisites

- Terraform >= 1.14.0 and < 2.0.0
- AWS credentials configured
- Docker with Buildx and target-platform emulation
- Registrar access for `mimex.dev`; Terraform can create the Route53 hosted zone
- Existing EC2 key pair (if you want SSH)
- Local cert files for `mimex.dev`:
  - full chain PEM
  - private key PEM

## Variables

- `hosted_zone_name` default: `mimex.dev`
- `create_hosted_zone` default: `false`
- `vpc_id` default: empty (use the region's default VPC)
- `subnet_id` default: empty (use the first subnet in the selected VPC)
- `instance_type` default: `t4g.small`
- `instance_arch` default: `arm64` (`x86_64` for t3/t3a)
- `docker_compose_version` default: `v5.0.1`
- `ssh_key_name` default: empty (set for SSH access)
- `ssh_cidr` default: `0.0.0.0/0` (set tighter in production)

## Quick start

```bash
cd infra/terraform
terraform init
terraform apply \
  -var="hosted_zone_name=mimex.dev" \
  -var="ssh_key_name=<your-keypair-name>"
```

## Deployment script flow

Use `scripts/aws/release.sh` to:

1. Build API/Web images locally with Buildx
2. `terraform apply`
3. Upload the images, `docker-compose.yml`, `Caddyfile`, and TLS cert files to EC2
4. Load the images and restart containers on EC2

Required env vars for `release.sh`:

- `SSH_PRIVATE_KEY_PATH`
- `SSH_CIDR`
- `BASIC_AUTH_PASSWORD_HASH`

Optional env vars:

- `BUILD_CONTEXT` (defaults to repo root)
- `API_DOCKERFILE` (defaults to `apps/api/Dockerfile`)
- `WEB_DOCKERFILE` (defaults to `apps/web/Dockerfile`)
- `DOCKER_BUILD_PLATFORM` (defaults from `INSTANCE_ARCH`, for example `linux/arm64`)
- `DOCKER_COMPOSE_VERSION` (defaults to `v5.0.1` for the EC2 bootstrap fallback install)
- `TF_INIT_UPGRADE=true` to refresh provider selections during `terraform init`
