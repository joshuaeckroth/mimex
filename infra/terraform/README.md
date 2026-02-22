# AWS Terraform (single-host on mimex.dev)

This stack deploys Mimex on a single low-cost EC2 host and serves everything from `https://mimex.dev`.

## What it creates

- One EC2 instance (`t4g.small` by default)
- One Elastic IP (stable address)
- Route53 root `A` record (`mimex.dev` -> Elastic IP)
- One security group (80/443 + optional SSH)
- IAM role/profile for SSM and ECR image pulls
- Two ECR repositories (`api` and `web`)

## Architecture

- TLS endpoint: your EC2 host (you provide cert/key files)
- Reverse proxy on host (Caddy container)
- Path routing:
  - `/` -> web container
  - `/api/*` -> API container
- Workspace data persists on host storage and is mounted into API container
- MCP is currently stdio-based (`apps/mcp`) and not exposed via HTTP in this slim deploy

## Prerequisites

- Terraform >= 1.6
- AWS credentials configured
- Existing Route53 hosted zone for `mimex.dev`
- Existing EC2 key pair (if you want SSH)
- Local cert files for `mimex.dev`:
  - full chain PEM
  - private key PEM

## Variables

- `hosted_zone_name` default: `mimex.dev`
- `instance_type` default: `t4g.small`
- `instance_arch` default: `arm64` (`x86_64` for t3/t3a)
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

1. `terraform apply`
2. Build and push API/Web images to ECR
3. Upload `docker-compose.yml`, `Caddyfile`, and TLS cert files to EC2
4. Pull and restart containers on EC2

Required env vars for `release.sh`:

- `SSH_PRIVATE_KEY_PATH`
- `TLS_CERT_PATH`
- `TLS_KEY_PATH`

Optional env vars:

- `BUILD_CONTEXT` (defaults to repo root)
- `API_DOCKERFILE` (defaults to `apps/api/Dockerfile`)
- `WEB_DOCKERFILE` (defaults to `apps/web/Dockerfile`)
